import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { google, gmail_v1 } from "googleapis";
import { GoogleGenAI } from "@google/genai";

let _db: FirebaseFirestore.Firestore;
let _gmail: gmail_v1.Gmail;
let _gmailUser: string;

function initFirebase() {
  if (_db) return _db;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT env var is not set");
  const sa = JSON.parse(raw);
  if (!getApps().length) initializeApp({ credential: cert(sa) });
  _db = getFirestore();
  return _db;
}

function initGmail() {
  if (_gmail) return { gmail: _gmail, user: _gmailUser };
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
  );
  oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  _gmail = google.gmail({ version: "v1", auth: oAuth2Client });
  _gmailUser = process.env.GMAIL_USER!;
  return { gmail: _gmail, user: _gmailUser };
}

function buildRawEmail(to: string, from: string, subject: string, body: string): string {
  const lines = [
    `From: ${from}`, `To: ${to}`,
    `Subject: ${subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", body,
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64(encoded: string): string {
  return Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function getHeader(headers: { name?: string | null; value?: string | null }[], name: string): string {
  return headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractPlainText(payload: any): string {
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBase64(payload.body.data);
  if (payload.parts) for (const part of payload.parts) { const t = extractPlainText(part); if (t) return t; }
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

function calculateStatus(s: number, currentStatus?: string): string {
  if (s >= 8) return "interested";
  if (s >= 5) return "contacted";
  return currentStatus || "new";
}

function quickFilterEmail(subject: string, body: string, fromRaw: string): "spam" | "promo" | "maybe" {
  const s = subject.toLowerCase();
  const b = body.toLowerCase();
  const combined = s + " " + b;

  const spamPatterns = /\b(free\s+(now|trial|gift)|win\s+(a|the|up\s+to)|prize|congratulations?|limited\s+time|act\s+now|you.ve?\s+won|click\s+here|work\s+from\s+home|make\s+money\s+online|earn\s+\$|buy\s+now|offer\s+expires|cash\s+bonus|urgent\s+(action|response)|immediate\s+action|risk.free|no\s+obligation|100%\s+(free|guaranteed))\b/i;
  if (spamPatterns.test(combined)) return "spam";

  const promoPatterns = /\b(unsubscribe|newsletter|weekly\s+digest|you.re\s+receiving|email\s+preferences|view\s+in\s+browser|sent\s+to\s+you\s+because|you\s+subscribed|email\s+not\s+displaying|white\s+list|add\s+us\s+to|manage\s+your\s+preferences)\b/i;
  if (promoPatterns.test(combined)) return "promo";

  const bodyClean = b.replace(/\s+/g, " ").trim();
  if (bodyClean.length < 20 && !s.includes("?")) return "spam";

  const enquiryPatterns = /\b(looking\s+for|need\s+help|interested\s+in|quote|pricing|price|cost|how\s+much|can\s+you|would\s+you|question|help\s+with|regarding|enquir|about\s+(your|the)\s+service|work\s+with|partner\s+with|collaborat|hire\s+(you|your)|project\s+(for|with)|need\s+(a|an|some|help|info)|i\s+(want|need|would\s+like)|could\s+you|do\s+you\s+(offer|provide|have))\b/i;
  if (enquiryPatterns.test(combined)) return "maybe";

  if (s.includes("?") || b.includes("?")) return "maybe";

  if (/^(hi|hello|hey|thanks|thank you)\b/i.test(s) && bodyClean.length > 50) return "maybe";

  return "spam";
}

async function aiScoreEnquiry(subject: string, body: string): Promise<number> {
  try {
    const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const prompt = `Determine if the following email is a genuine business enquiry or spam/promotional. Reply with ONLY a number 1-10 where 1 = definite spam, 10 = definite genuine enquiry.

Subject: ${subject}
Body: ${body.slice(0, 500)}`;
    const result = await genai.models.generateContent({
      model: "gemini-3-flash",
      contents: prompt,
      config: { responseMimeType: "text/plain" },
    });
    const text = result.text?.trim();
    if (text) {
      const match = text.match(/\d+/);
      if (match) {
        const score = parseInt(match[0], 10);
        return Math.max(1, Math.min(10, score));
      }
    }
  } catch (e) {
    console.error("AI scoring failed", e);
  }
  return 5;
}

async function processLead(
  CleanEmail: string, SenderName: string, Subject: string, bodyText: string,
  gcid: string | null, source?: string | null, threadId?: string, messageId?: string,
): Promise<void> {
  const leadsRef = initFirebase().collection("leads");
  let querySnapshot = await leadsRef.where("identifier", "==", CleanEmail).limit(1).get();
  if (querySnapshot.empty) querySnapshot = await leadsRef.where("lead_id", "==", CleanEmail).limit(1).get();

  if (!gcid && !source && querySnapshot.empty) {
    console.log(`Dropping: no gcid/source and lead ${CleanEmail} not found`);
    return;
  }

  let botActive = true;
  let leadDocRef: any = null;
  let existingData: any = null;
  if (!querySnapshot.empty) {
    const doc = querySnapshot.docs[0];
    leadDocRef = doc.ref;
    existingData = doc.data();
    if (existingData && typeof existingData.bot_active === "boolean") botActive = existingData.bot_active;
  }

  const now = FieldValue.serverTimestamp();
  const timestampIso = new Date().toISOString();
  const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  if (!botActive) {
    if (leadDocRef) {
      await leadDocRef.update({
        conversation_history: FieldValue.arrayUnion({
          id: `email-in-${msgId}`, channel: "email", role: "user", sender: CleanEmail,
          subject: Subject, text: bodyText, timestamp: timestampIso, intent_tags: ["general-inquiry"],
        }),
        last_interaction: now, needs_followup: true,
      });
    }
    return;
  }

  let score = 4;
  let aiReplyText = `Hi ${SenderName},\n\nThank you for reaching out! Our team is looking into this and will get back to you shortly.\n\nBest regards,\n- The Orchestrator`;

  let systemPersona = "You are 'The Orchestrator', an elite business assistant for our creative and tech agency.";
  try {
    const snap = await initFirebase().collection("settings").doc("system").get();
    if (snap.exists && snap.data()?.ai_persona) systemPersona = snap.data()!.ai_persona.trim();
  } catch { /* default */ }

  let historyContext = "";
  if (existingData && Array.isArray(existingData.conversation_history)) {
    const sorted = [...existingData.conversation_history].sort((a: any, b: any) => {
      const ta = a.timestamp?.toDate ? a.timestamp.toDate().getTime() : new Date(a.timestamp).getTime();
      const tb = b.timestamp?.toDate ? b.timestamp.toDate().getTime() : new Date(b.timestamp).getTime();
      return ta - tb;
    });
    historyContext = sorted.map((m: any) =>
      `${m.role === "user" ? "Client" : "Assistant (You)"} (${m.sender}): ${m.text}`
    ).join("\n\n");
  }

  const aiPrompt = `Instructions / System Persona:\n${systemPersona}\n\nRequirements:\nReturn JSON with two keys:\n1. 'leadScore': number 1-10 evaluating intent.\n2. 'replyText': warm, professional reply (2-3 paragraphs). Sign off as '- The Orchestrator'.\n\nConversation History:\n${historyContext || "None"}\n\nNew Email:\nFrom: ${SenderName}\nSubject: ${Subject}\nBody:\n${bodyText}`;

  try {
    const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const result = await genai.models.generateContent({
      model: "gemini-3-flash", contents: aiPrompt,
      config: { responseMimeType: "application/json" },
    });
    const text = result.text?.trim();
    if (text) {
      const parsed = JSON.parse(text);
      if (typeof parsed.leadScore === "number") score = parsed.leadScore;
      if (typeof parsed.replyText === "string" && parsed.replyText.trim()) aiReplyText = parsed.replyText.trim();
    }
  } catch (e) {
    console.error("AI call failed, using fallback", e);
  }

  const gmailCtx = initGmail();
  const rawEmail = buildRawEmail(CleanEmail, gmailCtx.user, Subject, aiReplyText);
  await gmailCtx.gmail.users.messages.send({
    userId: gmailCtx.user,
    requestBody: { raw: rawEmail, threadId: threadId || undefined },
  });
  console.log("Replied to", CleanEmail);

  const inbound = {
    id: `email-in-${msgId}`, channel: "email", role: "user", sender: CleanEmail,
    subject: Subject, text: bodyText, timestamp: timestampIso,
    intent_tags: score >= 9 ? ["high-intent"] : ["general-inquiry"],
  };
  const outbound = {
    id: `email-out-${msgId}`, channel: "email", role: "assistant", sender: initGmail().user,
    subject: `Re: ${Subject}`, text: aiReplyText, timestamp: timestampIso, intent_tags: ["auto-reply"],
  };

  if (!querySnapshot.empty) {
    const cur = existingData?.status || "new";
    const newStatus = score > (existingData?.lead_score || 0) ? calculateStatus(score, cur) : cur;
    await leadDocRef.update({
      conversation_history: FieldValue.arrayUnion(inbound, outbound),
      last_interaction: now, needs_followup: true, score, lead_score: score, status: newStatus,
    });
  } else {
    await initFirebase().collection("leads").add({
      name: SenderName, identifier: CleanEmail, lead_id: CleanEmail,
      status: calculateStatus(score), score, lead_score: score,
      bot_active: true, needs_followup: true, click_id: gcid, source_id: source || null,
      conversation_history: [inbound, outbound], last_interaction: now,
    });
  }
}

async function handlePubSub(body: any, corsHeaders: Record<string, string>): Promise<Response> {
  const pubsubData = body?.message?.data;
  if (!pubsubData) return new Response("No Pub/Sub data", { status: 200, headers: corsHeaders });

  decodeBase64(pubsubData);

  const gmailCtx = initGmail();
  const listResp = await gmailCtx.gmail.users.messages.list({ userId: gmailCtx.user, q: "is:unread in:inbox", maxResults: 1 });
  const messages = listResp.data.messages;
  if (!messages || messages.length === 0) return new Response("No unread messages", { status: 200, headers: corsHeaders });

  const messageId = messages[0].id!;
  const msgResp = await gmailCtx.gmail.users.messages.get({ userId: gmailCtx.user, id: messageId, format: "full" });
  const payload = msgResp.data.payload;
  if (!payload || !payload.headers) return new Response("No payload", { status: 200, headers: corsHeaders });

  const fromRaw = getHeader(payload.headers, "From");
  const CleanEmail = cleanEmail(fromRaw);
  const Subject = getHeader(payload.headers, "Subject");
  const bodyText = extractPlainText(payload).trim();
  const threadId = msgResp.data.threadId;

  let SenderName = "";
  const nameMatch = fromRaw.match(/^([^<]+)/);
  if (nameMatch) SenderName = nameMatch[1].replace(/["']/g, "").trim();
  if (!SenderName) SenderName = CleanEmail.split("@")[0];

  const gcid = extractGcid(Subject);

  await gmailCtx.gmail.users.messages.modify({
    userId: gmailCtx.user, id: messageId,
    requestBody: { removeLabelIds: ["UNREAD"] },
  });

  // Check if lead already exists in Firestore
  const leadsRef = initFirebase().collection("leads");
  let existingSnap = await leadsRef.where("identifier", "==", CleanEmail).limit(1).get();
  if (existingSnap.empty) existingSnap = await leadsRef.where("lead_id", "==", CleanEmail).limit(1).get();

  // Existing lead replying → always process
  if (!existingSnap.empty) {
    await processLead(CleanEmail, SenderName, Subject, bodyText, gcid, null, threadId);
    return new Response("Processed (existing)", { status: 200, headers: corsHeaders });
  }

  // Has gcid (ad click) or source (form submission) → always process
  if (gcid) {
    await processLead(CleanEmail, SenderName, Subject, bodyText, gcid, null, threadId);
    return new Response("Processed (gcid)", { status: 200, headers: corsHeaders });
  }

  // Tier 1: Rule-based filter (zero AI cost)
  const filterResult = quickFilterEmail(Subject, bodyText, fromRaw);
  if (filterResult === "spam" || filterResult === "promo") {
    console.log(`Dropped (${filterResult}): ${Subject}`);
    return new Response("Dropped", { status: 200, headers: corsHeaders });
  }

  // Tier 2: Lightweight AI score
  const aiScore = await aiScoreEnquiry(Subject, bodyText);
  if (aiScore < 5) {
    console.log(`Rejected (AI score ${aiScore}): ${Subject}`);
    return new Response("Rejected", { status: 200, headers: corsHeaders });
  }

  // Process as genuine enquiry
  await processLead(CleanEmail, SenderName, Subject, bodyText, null, null, threadId);
  return new Response("Processed (enquiry)", { status: 200, headers: corsHeaders });
}

async function handleFormSubmission(body: any, corsHeaders: Record<string, string>): Promise<Response> {
  const { name, email, phone, company, message, gcid, source } = body;
  if (!name || !email) {
    return new Response(JSON.stringify({ success: false, error: "Name and email required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sourceId = source || `site-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const bodyText = `Name: ${name}\nEmail: ${email}\nPhone: ${phone || "N/A"}\nCompany: ${company || "N/A"}\n\n--- THE CLIENT'S ENQUIRY ---\n\n${message || "(No specific message provided)"}`;
  const Subject = `Website enquiry from ${name}${gcid ? ` [gcid=${gcid}]` : ""}`;

  await processLead(email.trim().toLowerCase(), name, Subject, bodyText, gcid || null, sourceId);
  return new Response(JSON.stringify({ success: true }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export default async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const body = await req.json();
    if (body?.message?.data) {
      return await handlePubSub(body, corsHeaders);
    }
    return await handleFormSubmission(body, corsHeaders);
  } catch (error) {
    console.error("Error", error);
    return new Response(JSON.stringify({ success: false, error: "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};
