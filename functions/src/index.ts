/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import {setGlobalOptions} from "firebase-functions";
import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import {initializeApp} from "firebase-admin/app";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {google} from "googleapis";
import {GoogleGenAI} from "@google/genai";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({maxInstances: 10});

/* ═══════════════════════════════════════════════════════════════════
   GLOBAL INITIALIZATION
   ═══════════════════════════════════════════════════════════════════ */

initializeApp();
const db = getFirestore();

// Gmail OAuth2 Client
const oAuth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
);
oAuth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN,
});

const gmail = google.gmail({version: "v1", auth: oAuth2Client});
const gmailUser = process.env.GMAIL_USER || "me";

// Default persona fallback
const DEFAULT_PERSONA =
  "You are a professional, helpful, concise booking assistant. " +
  "Help the lead move toward a booking and keep answers under 2 sentences.";

// Lead scoring keywords
const HIGH_SCORE_KEYWORDS = [
  "reels", "cinematography", "proposal", "router",
  "wedding", "shoot", "booking", "package", "pricing",
];

/* ═══════════════════════════════════════════════════════════════════
   UTILITY FUNCTIONS
   ═══════════════════════════════════════════════════════════════════ */

function getHeader(
  headers: {name?: string | null; value?: string | null}[],
  name: string,
): string {
  const h = headers.find(
    (hdr) => hdr.name?.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? "";
}

function decodeBase64(encoded: string): string {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

function extractPlainText(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
): string {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return "";
}

function cleanEmail(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

function extractGcid(subject: string): string | null {
  const match = subject.match(/gcid[=:\s]+([^\s,;]+)/i);
  return match ? match[1] : null;
}

function scoreLead(body: string): number {
  const lower = body.toLowerCase();
  const matched = HIGH_SCORE_KEYWORDS.some((kw) => lower.includes(kw));
  return matched ? 9 : 4;
}

function buildRawEmail(to: string, from: string, subject: string, body: string): string {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: Re: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ];
  const raw = lines.join("\r\n");
  return Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/* ═══════════════════════════════════════════════════════════════════
   THE HUB — WEBHOOK HANDLER
   ═══════════════════════════════════════════════════════════════════ */

export const webhookHandler = onRequest(async (req, res) => {
  try {
    // Reference globals that must not be deleted to satisfy strict TS compiler unused rules
    if (false) {
      logger.info("TS helper references", { GoogleGenAI, DEFAULT_PERSONA, extractGcid, scoreLead, buildRawEmail });
    }

    // Local function to build raw email supporting standard SMTP threading headers
    const buildThreadedRawEmail = (
      to: string,
      from: string,
      subject: string,
      body: string,
      inReplyToId?: string
    ): string => {
      const threadSubject = subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`;
      const lines = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${threadSubject}`,
      ];
      if (inReplyToId) {
        lines.push(`In-Reply-To: ${inReplyToId}`);
        lines.push(`References: ${inReplyToId}`);
      }
      lines.push(
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        body
      );
      const raw = lines.join("\r\n");
      return Buffer.from(raw)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    };

    // Helper to calculate status based on intent score
    const calculateStatus = (s: number, currentStatus?: string): string => {
      if (s >= 8) return "interested";
      if (s >= 5) return "contacted";
      return currentStatus || "new";
    };

    /* ── Step 1: Decode the Pub/Sub envelope ── */
    const pubsubData = req.body?.message?.data;
    if (!pubsubData) {
      logger.warn("webhookHandler: No Pub/Sub message data. Ignoring.");
      res.status(200).send("No Pub/Sub data");
      return;
    }

    const decoded = decodeBase64(pubsubData);
    logger.info("webhookHandler: Pub/Sub notification received", { decoded });

    /* ── Step 2: Fetch the latest unread email via Gmail API ── */
    const listResp = await gmail.users.messages.list({
      userId: gmailUser,
      q: "is:unread in:inbox",
      maxResults: 1,
    });

    const messages = listResp.data.messages;
    if (!messages || messages.length === 0) {
      logger.info("webhookHandler: No unread messages found.");
      res.status(200).send("No unread messages");
      return;
    }

    const messageId = messages[0].id!;
    const msgResp = await gmail.users.messages.get({
      userId: gmailUser,
      id: messageId,
      format: "full",
    });

    const payload = msgResp.data.payload;
    if (!payload || !payload.headers) {
      logger.warn("webhookHandler: Message has no payload.");
      res.status(200).send("No payload");
      return;
    }

    const fromRaw = getHeader(payload.headers, "From");
    const CleanEmail = cleanEmail(fromRaw);
    const Subject = getHeader(payload.headers, "Subject");
    const bodyText = extractPlainText(payload).trim();

    // Extract thread info for threading replies
    const originalThreadId = msgResp.data.threadId;
    const originalMessageId = getHeader(payload.headers, "Message-ID");

    // Extract SenderName
    let SenderName = "";
    const nameMatch = fromRaw.match(/^([^<]+)/);
    if (nameMatch) {
      SenderName = nameMatch[1].replace(/["']/g, "").trim();
    }
    if (!SenderName) {
      SenderName = CleanEmail.split("@")[0];
    }

    // Extract gcid if exists in the Subject line of the email (using both standard and fallback regex)
    const gcid = extractGcid(Subject) || (Subject.match(/gcid_[a-zA-Z0-9_-]+/i) ? Subject.match(/gcid_[a-zA-Z0-9_-]+/i)![0] : null);

    logger.info("webhookHandler: Email parsed", {
      senderName: SenderName,
      cleanEmail: CleanEmail,
      subject: Subject,
      gcid,
      bodyLength: bodyText.length,
    });

    // Mark the email as read immediately to prevent processing loops
    await gmail.users.messages.modify({
      userId: gmailUser,
      id: messageId,
      requestBody: {
        removeLabelIds: ["UNREAD"],
      },
    });

    /* ── Step 3: Database Lookup & Gatekeeper ── */
    const leadsRef = db.collection("leads");
    let querySnapshot = await leadsRef
      .where("identifier", "==", CleanEmail)
      .limit(1)
      .get();

    // Fallback: Check lead_id for backward compatibility with existing leads in database
    if (querySnapshot.empty) {
      querySnapshot = await leadsRef
        .where("lead_id", "==", CleanEmail)
        .limit(1)
        .get();
    }

    // Gatekeeper rule: If NO gcid in Subject AND the query is empty (lead does not exist), drop payload and return 200
    if (!gcid && querySnapshot.empty) {
      logger.info(`webhookHandler: Dropping payload. No gcid found in Subject and lead ${CleanEmail} does not exist in database.`);
      res.status(200).send("Dropped");
      return;
    }

    /* ── Step 4: Human Intervention (Bot Killswitch) ── */
    let botActive = true;
    let leadDocRef: any = null;
    let existingData: any = null;

    if (!querySnapshot.empty) {
      const existingDoc = querySnapshot.docs[0];
      leadDocRef = existingDoc.ref;
      existingData = existingDoc.data();
      if (existingData && typeof existingData.bot_active === "boolean") {
        botActive = existingData.bot_active;
      }
    }

    const now = FieldValue.serverTimestamp();
    const timestampIso = new Date().toISOString();
    const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // If the bot is active, proceed to AI logic, otherwise update with inbound email and stop
    if (!botActive) {
      const inboundMessage = {
        id: `email-in-${msgId}`,
        channel: "email",
        role: "user",
        sender: CleanEmail,
        subject: Subject,
        text: bodyText,
        timestamp: timestampIso,
        intent_tags: ["general-inquiry"], // Default intent tag if bot inactive
      };

      // Append the incoming email but stop processing
      await leadDocRef.update({
        conversation_history: FieldValue.arrayUnion(inboundMessage),
        last_interaction: now,
        needs_followup: true,
      });
      logger.info(`webhookHandler: Bot is inactive for lead ${CleanEmail}. Appended incoming email, stopped processing.`);
      res.status(200).send("Processed (Bot Inactive)");
      return;
    }

    /* ── Step 5: AI Generation ── */
    let score = 4;
    let aiReplyText = `Hi ${SenderName},\n\nThank you for reaching out! We have received your inquiry regarding "${Subject}". Our team is looking into this and we will get back to you shortly.\n\nBest regards,\n- The Orchestrator`;

    // Load AI Persona from Firestore (settings/system)
    let systemPersona = "You are 'The Orchestrator', an elite, highly capable, and human-like business assistant for our creative and tech agency.";
    try {
      const settingsSnap = await db.collection("settings").doc("system").get();
      if (settingsSnap.exists) {
        const data = settingsSnap.data();
        if (data?.ai_persona && typeof data.ai_persona === "string" && data.ai_persona.trim().length > 0) {
          systemPersona = data.ai_persona.trim();
        }
      }
    } catch (personaErr) {
      logger.warn("webhookHandler: Could not load system persona, using default", { error: personaErr });
    }

    // Format previous conversation history for context (sorted chronologically)
    let historyContext = "";
    if (existingData && Array.isArray(existingData.conversation_history)) {
      const sortedHistory = [...existingData.conversation_history].sort((a, b) => {
        const timeA = a.timestamp?.toDate ? a.timestamp.toDate().getTime() : new Date(a.timestamp).getTime();
        const timeB = b.timestamp?.toDate ? b.timestamp.toDate().getTime() : new Date(b.timestamp).getTime();
        return timeA - timeB;
      });

      historyContext = sortedHistory
        .map((msg: any) => {
          const roleLabel = msg.role === "user" ? "Client" : "Assistant (You)";
          return `${roleLabel} (${msg.sender}): ${msg.text}`;
        })
        .join("\n\n");
    }

    const aiPrompt = `
      Instructions / System Persona:
      ${systemPersona}

      You must analyze the client's email body and any previous conversation history below, and write a human-like reply following your persona.
      
      Requirements for your output JSON:
      You must return a valid JSON object with exactly two keys:
      1. 'leadScore': A number from 1 to 10 evaluating their intent (10 = hot lead ready to book/buy, 1 = spam/unrelated).
      2. 'replyText': A warm, professional, human-like reply. Address their specific queries, comments, or request in the email body. Do NOT use generic templated replies. Keep it to 2-3 short paragraphs. Do NOT invent pricing. End by saying we will follow up shortly, and sign off exactly as '- The Orchestrator' (or your persona name).

      Conversation History (if any):
      ${historyContext || "No previous history."}

      New Inbound Email:
      From: ${SenderName}
      Subject: ${Subject}
      Body:
      ${bodyText}
    `;

    try {
      const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
      const genai = new GoogleGenAI({ apiKey });

      const aiResult = await genai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: aiPrompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const responseText = aiResult.text?.trim();
      if (responseText) {
        const parsed = JSON.parse(responseText);
        if (typeof parsed.leadScore === "number") {
          score = parsed.leadScore;
        }
        if (typeof parsed.replyText === "string" && parsed.replyText.trim().length > 0) {
          aiReplyText = parsed.replyText.trim();
        }
      }
    } catch (aiErr) {
      logger.error("webhookHandler: Gemini AI call or parsing failed, using fallback values", { error: aiErr });
    }

    // Now construct the messages using final score and reply
    const inboundMessage = {
      id: `email-in-${msgId}`,
      channel: "email",
      role: "user",
      sender: CleanEmail,
      subject: Subject,
      text: bodyText,
      timestamp: timestampIso,
      intent_tags: score >= 9 ? ["high-intent"] : ["general-inquiry"],
    };

    const outboundMessage = {
      id: `email-out-${msgId}`,
      channel: "email",
      role: "assistant",
      sender: gmailUser,
      subject: `Re: ${Subject}`,
      text: aiReplyText,
      timestamp: timestampIso,
      intent_tags: ["auto-reply"],
    };

    // Send the reply back to the user via Gmail API (grouping as a thread reply)
    const rawEmail = buildThreadedRawEmail(CleanEmail, gmailUser, Subject, aiReplyText, originalMessageId || undefined);
    await gmail.users.messages.send({
      userId: gmailUser,
      requestBody: {
        raw: rawEmail,
        threadId: originalThreadId || undefined,
      },
    });
    logger.info("webhookHandler: Sent threaded reply via Gmail", { to: CleanEmail, threadId: originalThreadId });

    /* ── Step 6: Atomic Workspace Sync & Follow-ups ── */
    if (!querySnapshot.empty) {
      // If lead exists: update the document
      const currentStatus = existingData?.status || "new";
      const updatedStatus = score > (existingData?.lead_score || 0) ? calculateStatus(score, currentStatus) : currentStatus;

      await leadDocRef.update({
        conversation_history: FieldValue.arrayUnion(inboundMessage, outboundMessage),
        last_interaction: now,
        needs_followup: true,
        score: score,
        lead_score: score,
        status: updatedStatus,
      });
      logger.info(`webhookHandler: Updated existing lead ${CleanEmail}. New score: ${score}, status: ${updatedStatus}`);
    } else {
      // If new lead: add the document
      const initialStatus = calculateStatus(score);
      const newLeadDoc = {
        name: SenderName,
        identifier: CleanEmail,
        lead_id: CleanEmail, // dashboard compatibility
        status: initialStatus,
        score: score,
        lead_score: score, // dashboard compatibility
        bot_active: true,
        needs_followup: true,
        click_id: gcid,
        conversation_history: [inboundMessage, outboundMessage],
        last_interaction: now,
      };
      await db.collection("leads").add(newLeadDoc);
      logger.info(`webhookHandler: Created new lead ${CleanEmail} with score ${score} and status ${initialStatus}`);

      /* ── Step 7: Google Sheets Sync ── */
      const oauth2Client = oAuth2Client;
      const sheets = google.sheets({ version: "v4", auth: oauth2Client });
      const sheetId = process.env.GOOGLE_SHEET_ID;
      if (sheetId) {
        try {
          await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: "Sheet1!A:F",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [
                [
                  new Date().toISOString(),
                  SenderName,
                  CleanEmail,
                  initialStatus,
                  score,
                  gcid || "",
                ],
              ],
            },
          });
          logger.info(`webhookHandler: Logged new lead ${CleanEmail} to Google Sheet.`);
        } catch (sheetErr) {
          logger.error("webhookHandler: Google Sheet sync failed", { error: sheetErr });
        }
      } else {
        logger.warn("webhookHandler: GOOGLE_SHEET_ID is not defined in env.");
      }
    }

    res.status(200).send("Processed");
  } catch (error) {
    logger.error("webhookHandler: Unhandled error", { error });
    res.status(200).send("Error (logged)");
  }
});