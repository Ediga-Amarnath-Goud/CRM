"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Clock,
  Download,
  FileText,
  Flame,
  Hash,
  Inbox,
  Loader2,
  Lock,
  LogOut,
  Mail,
  Megaphone,
  MessageSquare,
  PauseCircle,
  Phone,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  User,
} from "firebase/auth";
import { db, auth, googleProvider } from "@/lib/firebase";

/* ═══════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════ */

type TabId = "pipeline" | "inbox" | "ai-center" | "attribution";
type LeadStatus = "new" | "contacted" | "interested" | "hot" | "paused";
type ConversationRole = "user" | "model";
type TimeFilter = "today" | "week" | "month" | "all";

interface ConversationMessage {
  role?: ConversationRole;
  channel?: "whatsapp" | "email";
  message?: string;
  intent?: string;
  timestamp?: { seconds: number; nanoseconds: number };
}

interface Lead {
  id: string;
  lead_id: string;
  status: LeadStatus;
  lead_score: number;
  click_id: string | null;
  last_interaction: Date | null;
  conversation_history: ConversationMessage[];
}

interface ToastItem {
  id: string;
  message: string;
  type: "success" | "error";
}

/* ═══════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════ */

const TAB_ITEMS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "pipeline", label: "Lead Pipeline", icon: <BarChart3 className="h-4 w-4" /> },
  { id: "inbox", label: "Split Inbox", icon: <MessageSquare className="h-4 w-4" /> },
  { id: "ai-center", label: "AI Command Center", icon: <Brain className="h-4 w-4" /> },
  { id: "attribution", label: "Marketing Attribution", icon: <Megaphone className="h-4 w-4" /> },
];

const PIPELINE_COLUMNS: {
  status: LeadStatus;
  label: string;
  borderAccent: string;
  bgAccent: string;
  dotColor: string;
}[] = [
  { status: "new", label: "New", borderAccent: "border-cyan-500/25", bgAccent: "bg-cyan-500/[0.03]", dotColor: "bg-cyan-400" },
  { status: "contacted", label: "Contacted", borderAccent: "border-blue-500/25", bgAccent: "bg-blue-500/[0.03]", dotColor: "bg-blue-400" },
  { status: "interested", label: "Interested", borderAccent: "border-emerald-500/25", bgAccent: "bg-emerald-500/[0.03]", dotColor: "bg-emerald-400" },
  { status: "hot", label: "Hot", borderAccent: "border-amber-400/30", bgAccent: "bg-amber-400/[0.04]", dotColor: "bg-amber-400" },
  { status: "paused", label: "Paused", borderAccent: "border-rose-400/15", bgAccent: "bg-rose-400/[0.02]", dotColor: "bg-rose-400/60" },
];

const STATUS_PILL_STYLES: Record<LeadStatus, string> = {
  new: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300",
  contacted: "border-blue-400/30 bg-blue-400/10 text-blue-300",
  interested: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  hot: "border-amber-400/40 bg-amber-400/15 text-amber-200",
  paused: "border-rose-400/20 bg-rose-400/8 text-rose-300",
};

const DEFAULT_PERSONA =
  "You are a professional, helpful, concise booking assistant. Help the lead move toward a booking and keep answers under 2 sentences.";

/* ═══════════════════════════════════════════════════════════════════
   CUSTOM HOOK — TOAST SYSTEM
   ═══════════════════════════════════════════════════════════════════ */

function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const push = useCallback((message: string, type: "success" | "error" = "success") => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3800);
  }, []);
  return { toasts, push };
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN PAGE COMPONENT
   ═══════════════════════════════════════════════════════════════════ */

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState<TabId>("pipeline");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { toasts, push: pushToast } = useToasts();

  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return unsubscribe;
  }, []);

  // Data Listener
  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const unsubscribe = onSnapshot(
      collection(db, "leads"),
      (snapshot) => {
        const parsed = snapshot.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            lead_id: getString(data.lead_id) ?? d.id,
            status: toLeadStatus(data.status),
            lead_score: clampScore(data.lead_score),
            click_id: getString(data.click_id),
            last_interaction: toDateOrNull(data.last_interaction),
            conversation_history: toConversation(data.conversation_history),
          };
        });
        setLeads(parsed.sort((a, b) => b.lead_score - a.lead_score));
        setLoading(false);
        setError(null);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      },
    );
    return unsubscribe;
  }, [user]);

  // Derived State: Filtered Leads
  const filteredLeads = useMemo(() => {
    if (timeFilter === "all") return leads;
    const now = new Date();
    const cutoff = new Date();
    if (timeFilter === "today") cutoff.setHours(0, 0, 0, 0);
    else if (timeFilter === "week") cutoff.setDate(now.getDate() - 7);
    else if (timeFilter === "month") cutoff.setMonth(now.getMonth() - 1);
    
    return leads.filter((l) => {
      if (!l.last_interaction) return false;
      return l.last_interaction >= cutoff;
    });
  }, [leads, timeFilter]);

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-500" />
      </div>
    );
  }

  if (!user) {
    return <LoginCard pushToast={pushToast} />;
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex min-h-screen w-full max-w-[1920px] flex-col">
        {/* ── HEADER ── */}
        <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/80 px-6 backdrop-blur-xl lg:px-10">
          {/* Top Header Row */}
          <div className="flex items-center justify-between py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-600/20 ring-1 ring-cyan-400/20">
                <ShieldCheck className="h-4.5 w-4.5 text-cyan-400" />
              </div>
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-white">
                  CRM Intelligence Hub
                </h1>
                <p className="text-xs text-zinc-500">
                  Omni-channel lead management &amp; AI orchestration
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              {/* Time Filter Toggle */}
              <div className="hidden items-center rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-1 sm:flex">
                {(["today", "week", "month", "all"] as TimeFilter[]).map((tf) => (
                  <button
                    key={tf}
                    onClick={() => setTimeFilter(tf)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                      timeFilter === tf
                        ? "bg-zinc-800 text-cyan-300 shadow-sm"
                        : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {tf.charAt(0).toUpperCase() + tf.slice(1)}
                  </button>
                ))}
              </div>
              
              {/* Sign Out */}
              <button
                onClick={() => signOut(auth)}
                className="flex items-center gap-2 rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-1.5 text-sm font-medium text-zinc-400 transition hover:bg-zinc-800/80 hover:text-zinc-200"
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            </div>
          </div>

          {/* Bottom Header Row (Tabs) */}
          <div className="flex gap-1 pb-0 pt-2" role="tablist">
            {TAB_ITEMS.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveTab(tab.id)}
                  className={`group relative flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-all duration-300 ${
                    active ? "text-white" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  <span className={`transition-colors duration-300 ${active ? "text-cyan-400" : "text-zinc-600 group-hover:text-zinc-400"}`}>
                    {tab.icon}
                  </span>
                  {tab.label}
                  {active && (
                    <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-gradient-to-r from-cyan-400 to-blue-500" />
                  )}
                </button>
              );
            })}
          </div>
        </header>

        {/* ── ERROR BANNER ── */}
        {error && (
          <div className="mx-6 mt-4 flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-5 py-3.5 text-sm text-red-200 backdrop-blur-sm lg:mx-10">
            <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
            {error}
          </div>
        )}

        {/* ── TAB CONTENT ── */}
        <div className="flex-1 px-6 py-6 lg:px-10">
          {activeTab === "pipeline" && (
            <PipelineTab leads={filteredLeads} loading={loading} pushToast={pushToast} />
          )}
          {activeTab === "inbox" && (
            <InboxTab leads={filteredLeads} loading={loading} pushToast={pushToast} />
          )}
          {activeTab === "ai-center" && (
            <AiCommandCenter pushToast={pushToast} />
          )}
          {activeTab === "attribution" && (
            <AttributionTab leads={filteredLeads} loading={loading} />
          )}
        </div>
      </div>

      {/* ── TOAST CONTAINER ── */}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2.5">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`animate-fade-in-up flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm font-medium shadow-2xl backdrop-blur-md ${
              t.type === "success"
                ? "border-emerald-500/20 bg-emerald-950/80 text-emerald-200"
                : "border-red-500/20 bg-red-950/80 text-red-200"
            }`}
          >
            {t.type === "success" ? (
              <Check className="h-4 w-4 text-emerald-400" />
            ) : (
              <AlertCircle className="h-4 w-4 text-red-400" />
            )}
            {t.message}
          </div>
        ))}
      </div>
    </main>
  );
}
/* ═══════════════════════════════════════════════════════════════════
   LOGIN COMPONENT
   ═══════════════════════════════════════════════════════════════════ */

function LoginCard({ pushToast }: { pushToast: (msg: string, type?: "success" | "error") => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      pushToast("Terminal unlocked");
    } catch (err: any) {
      pushToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
      pushToast("Terminal unlocked via Google");
    } catch (err: any) {
      pushToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/50 shadow-2xl backdrop-blur-xl">
        <div className="border-b border-zinc-800/50 bg-zinc-950/40 px-8 py-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-600/20 ring-1 ring-cyan-400/30">
            <Lock className="h-6 w-6 text-cyan-400" />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-white">Authenticate</h2>
          <p className="mt-1 text-sm text-zinc-500">Secure access to the Intelligence Hub</p>
        </div>

        <div className="px-8 py-6">
          <form onSubmit={handleEmailLogin} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">Email Address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-2.5 text-sm text-white placeholder-zinc-600 outline-none transition focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30"
                placeholder="admin@crm.com"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">Master Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-2.5 text-sm text-white placeholder-zinc-600 outline-none transition focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30"
                placeholder="••••••••"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-cyan-500/20 transition-all hover:shadow-cyan-500/30 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Unlock Terminal"}
            </button>
          </form>

          <div className="relative mt-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-zinc-800" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-zinc-900/50 px-2 text-zinc-500 backdrop-blur-md">OR</span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={loading}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-800/50 px-4 py-3 text-sm font-semibold text-white transition-all hover:bg-zinc-700/50 disabled:opacity-50"
          >
            Sign in with Google
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   TAB 1 — LEAD PIPELINE (Kanban)
   ═══════════════════════════════════════════════════════════════════ */

function PipelineTab({
  leads,
  loading,
  pushToast,
}: {
  leads: Lead[];
  loading: boolean;
  pushToast: (msg: string, type?: "success" | "error") => void;
}) {
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<LeadStatus, number> = { new: 0, contacted: 0, interested: 0, hot: 0, paused: 0 };
    let msgCount = 0;
    for (const l of leads) {
      c[l.status]++;
      msgCount += l.conversation_history.length;
    }
    return { ...c, messages: msgCount };
  }, [leads]);

  const changeStatus = useCallback(
    async (lead: Lead, next: LeadStatus) => {
      if (lead.status === next) return;
      setUpdatingId(lead.id);
      try {
        await updateDoc(doc(db, "leads", lead.id), { status: next });
        pushToast(`Lead moved to ${next.charAt(0).toUpperCase() + next.slice(1)}`);
        setSelectedLead((prev) => (prev?.id === lead.id ? { ...prev, status: next } : prev));
      } catch (e) {
        pushToast(`Failed to update status: ${(e as Error).message}`, "error");
      } finally {
        setUpdatingId(null);
      }
    },
    [pushToast],
  );

  if (loading) return <PipelineSkeleton />;

  return (
    <>
      {/* ── METRICS ROW ── */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <MetricCard icon={<Activity className="h-4 w-4" />} label="Total Leads" value={leads.length} />
        <MetricCard icon={<MessageSquare className="h-4 w-4" />} label="Messages Processed" value={counts.messages} />
        <MetricCard
          icon={<Flame className="h-4 w-4" />}
          label="Hot Leads"
          value={counts.hot}
          variant="hot"
        />
        <MetricCard icon={<Zap className="h-4 w-4" />} label="Interested" value={counts.interested} variant="emerald" />
        <MetricCard icon={<PauseCircle className="h-4 w-4" />} label="Paused" value={counts.paused} variant="rose" />
      </div>

      {/* ── KANBAN GRID ── */}
      <section className="grid flex-1 grid-cols-1 gap-4 xl:grid-cols-5">
        {PIPELINE_COLUMNS.map((col) => (
          <KanbanColumn
            key={col.status}
            config={col}
            leads={leads.filter((l) => l.status === col.status)}
            onSelectLead={setSelectedLead}
          />
        ))}
      </section>

      {/* ── CONVERSATION DRAWER (Legacy from Pipeline) ── */}
      {selectedLead && (
        <ConversationDrawer
          lead={selectedLead}
          updatingId={updatingId}
          onClose={() => setSelectedLead(null)}
          onChangeStatus={changeStatus}
        />
      )}
    </>
  );
}

/* ─── Kanban Column ─── */

function KanbanColumn({
  config,
  leads,
  onSelectLead,
}: {
  config: (typeof PIPELINE_COLUMNS)[number];
  leads: Lead[];
  onSelectLead: (l: Lead) => void;
}) {
  return (
    <div className={`flex min-h-[480px] flex-col rounded-xl border ${config.borderAccent} ${config.bgAccent} backdrop-blur-sm`}>
      <div className="flex items-center justify-between border-b border-zinc-800/60 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className={`h-2 w-2 rounded-full ${config.dotColor}`} />
          <h2 className="text-sm font-semibold text-zinc-200">{config.label}</h2>
        </div>
        <span className="flex h-6 min-w-6 items-center justify-center rounded-lg border border-zinc-700/60 bg-zinc-800/50 px-2 text-xs font-bold text-zinc-400">
          {leads.length}
        </span>
      </div>

      <div className="custom-scrollbar flex flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">
        {leads.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800/40 p-6 text-center">
            <Inbox className="h-6 w-6 text-zinc-700" />
            <p className="text-xs text-zinc-600">No active leads</p>
          </div>
        ) : (
          leads.map((lead) => (
            <LeadCard key={lead.id} lead={lead} onClick={() => onSelectLead(lead)} />
          ))
        )}
      </div>
    </div>
  );
}

/* ─── Lead Card ─── */

function LeadCard({ lead, onClick, selected = false }: { lead: Lead; onClick: () => void; selected?: boolean }) {
  const latest = getLatestMessage(lead.conversation_history);
  const scoreColor =
    lead.lead_score >= 8
      ? "border-amber-400/40 bg-amber-400/15 text-amber-200"
      : lead.lead_score >= 5
        ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
        : "border-zinc-700/60 bg-zinc-800/40 text-zinc-400";

  return (
    <article
      onClick={onClick}
      className={`group cursor-pointer rounded-xl border p-3.5 shadow-lg shadow-black/10 backdrop-blur-sm transition-all duration-300 hover:shadow-xl ${
        selected ? "border-cyan-500/50 bg-cyan-500/10" : "border-zinc-800/70 bg-zinc-900/40 hover:border-zinc-700/80 hover:bg-zinc-900/60"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <UserRound className="h-3 w-3 shrink-0" />
            <span className="truncate">{maskLeadId(lead.lead_id)}</span>
          </div>
          <h3 className="mt-1.5 truncate text-sm font-semibold text-zinc-100">
            {lead.lead_id}
          </h3>
        </div>
        <div className={`shrink-0 rounded-lg border px-2 py-0.5 text-xs font-bold ${scoreColor}`}>
          {lead.lead_score}/10
        </div>
      </div>

      <div className="mt-2.5 rounded-lg border border-zinc-800/50 bg-zinc-950/60 p-2.5">
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
           <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-600">
            <MessageSquare className="h-3 w-3" />
            Latest
          </div>
          <span className={`inline-block rounded-full border px-2 py-[1px] text-[10px] font-semibold ${STATUS_PILL_STYLES[lead.status]}`}>
            {lead.status}
          </span>
        </div>
        <p className="line-clamp-2 text-xs leading-5 text-zinc-400">{latest}</p>
      </div>
    </article>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   TAB 4 — SPLIT INBOX
   ═══════════════════════════════════════════════════════════════════ */

function InboxTab({
  leads,
  loading,
  pushToast,
}: {
  leads: Lead[];
  loading: boolean;
  pushToast: (msg: string, type?: "success" | "error") => void;
}) {
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Sync selected lead changes
  const activeLead = useMemo(() => {
    return leads.find((l) => l.id === selectedLead?.id) || selectedLead;
  }, [leads, selectedLead]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeLead?.conversation_history]);

  const changeStatus = useCallback(
    async (lead: Lead, next: LeadStatus) => {
      if (lead.status === next) return;
      setUpdatingId(lead.id);
      try {
        await updateDoc(doc(db, "leads", lead.id), { status: next });
        pushToast(`Lead moved to ${next.charAt(0).toUpperCase() + next.slice(1)}`);
      } catch (e) {
        pushToast(`Failed to update status: ${(e as Error).message}`, "error");
      } finally {
        setUpdatingId(null);
      }
    },
    [pushToast],
  );

  const statuses: LeadStatus[] = ["new", "contacted", "interested", "hot", "paused"];

  if (loading) return <PipelineSkeleton />;

  return (
    <div className="flex h-[calc(100vh-140px)] w-full overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/30 backdrop-blur-md">
      
      {/* ── LEFT PANE (35%) ── */}
      <div className="flex w-[35%] flex-col border-r border-zinc-800/80 bg-zinc-950/40">
        <div className="border-b border-zinc-800/60 p-4">
          <h2 className="text-sm font-semibold text-zinc-200">Contact Ledger</h2>
          <p className="text-xs text-zinc-500">{leads.length} filtered conversations</p>
        </div>
        <div className="custom-scrollbar flex-1 overflow-y-auto p-3 space-y-3">
          {leads.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              onClick={() => setSelectedLead(lead)}
              selected={activeLead?.id === lead.id}
            />
          ))}
        </div>
      </div>

      {/* ── RIGHT PANE (65%) ── */}
      <div className="flex flex-1 flex-col bg-zinc-950/60">
        {!activeLead ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <MessageSquare className="h-12 w-12 text-zinc-800" />
            <div>
              <h3 className="text-lg font-medium text-zinc-300">No Lead Selected</h3>
              <p className="text-sm text-zinc-500">Select a lead from the ledger to review correspondence.</p>
            </div>
          </div>
        ) : (
          <>
            {/* Header / Pipeline Controls */}
            <div className="border-b border-zinc-800/60 px-6 py-4">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-white">{activeLead.lead_id}</h2>
                  <div className="mt-1 flex items-center gap-4 text-xs text-zinc-500">
                    <span className="flex items-center gap-1">
                      <TrendingUp className="h-3.5 w-3.5" />
                      Score: <span className="font-bold text-zinc-300">{activeLead.lead_score}/10</span>
                    </span>
                    {activeLead.click_id && (
                      <span className="flex items-center gap-1">
                        <Hash className="h-3.5 w-3.5" />
                        {activeLead.click_id}
                      </span>
                    )}
                  </div>
                </div>
                
                {/* Pipeline Stages */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {statuses.map((s) => {
                    const active = activeLead.status === s;
                    const isUpdating = updatingId === activeLead.id;
                    return (
                      <button
                        key={s}
                        onClick={() => changeStatus(activeLead, s)}
                        disabled={isUpdating}
                        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all duration-200 disabled:opacity-50 ${
                          active
                            ? STATUS_PILL_STYLES[s]
                            : "border-zinc-800/50 bg-zinc-900/30 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                        }`}
                      >
                        {isUpdating && active ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : null}
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Conversation Thread */}
            <div ref={scrollRef} className="custom-scrollbar flex-1 overflow-y-auto px-6 py-6">
              {activeLead.conversation_history.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <Inbox className="h-8 w-8 text-zinc-700" />
                  <p className="text-sm text-zinc-600">No messages found.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-5">
                  {activeLead.conversation_history.map((msg, i) => (
                    <SplitChatBubble key={i} message={msg} leadId={activeLead.lead_id} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Split Pane Chat Bubble (with Channel specific styles) ─── */

function SplitChatBubble({ message, leadId }: { message: ConversationMessage; leadId: string }) {
  const isUser = message.role === "user";
  const text = message.message ?? "";
  if (!text.trim()) return null;

  const ts = message.timestamp
    ? new Date(message.timestamp.seconds * 1000).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : null;

  // EMAIL STYLING
  if (message.channel === "email") {
    return (
      <div className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}>
        <div className="w-full max-w-[85%] rounded-xl border border-zinc-800/80 bg-zinc-900 p-4 shadow-md">
          <div className="mb-3 flex items-center justify-between border-b border-zinc-800 pb-2">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold text-zinc-300">From:</span>
                <span className="text-zinc-400">{isUser ? leadId : "AI Agent"}</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold text-zinc-300">To:</span>
                <span className="text-zinc-400">{!isUser ? leadId : "AI Agent"}</span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 text-[10px] text-zinc-500">
              <span className="flex items-center gap-1 rounded bg-zinc-800/50 px-1.5 py-0.5">
                <Mail className="h-3 w-3" /> Email
              </span>
              {ts && <span>{ts}</span>}
              {message.intent && !isUser && (
                <span className="text-cyan-500/80">{message.intent}</span>
              )}
            </div>
          </div>
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
            {text}
          </div>
        </div>
      </div>
    );
  }

  // WHATSAPP STYLING
  return (
    <div className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[75%] space-y-1 ${isUser ? "items-end" : "items-start"}`}>
        <div className={`flex items-center gap-1.5 text-[11px] font-medium ${isUser ? "justify-end text-emerald-500/80" : "text-zinc-500"}`}>
          {isUser ? (
            <>
              <Phone className="h-3 w-3" /> Lead
            </>
          ) : (
            <>
              <Bot className="h-3 w-3" /> AI Assistant
            </>
          )}
        </div>
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
            isUser
              ? "rounded-br-md border border-emerald-800/30 bg-emerald-950/40 text-emerald-100"
              : "rounded-bl-md bg-zinc-800 text-zinc-200"
          }`}
        >
          {text}
        </div>
        <div className={`flex items-center gap-2 text-[10px] text-zinc-600 ${isUser ? "justify-end" : ""}`}>
          {ts && (
            <span className="flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              {ts}
            </span>
          )}
          {message.intent && !isUser && (
            <span className="text-zinc-500">{message.intent}</span>
          )}
        </div>
      </div>
    </div>
  );
}
/* ═══════════════════════════════════════════════════════════════════
   CONVERSATION DRAWER (Legacy for Kanban)
   ═══════════════════════════════════════════════════════════════════ */

function ConversationDrawer({
  lead,
  updatingId,
  onClose,
  onChangeStatus,
}: {
  lead: Lead;
  updatingId: string | null;
  onClose: () => void;
  onChangeStatus: (lead: Lead, status: LeadStatus) => Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isUpdating = updatingId === lead.id;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lead.conversation_history]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const statuses: LeadStatus[] = ["new", "contacted", "interested", "hot", "paused"];

  return (
    <>
      <div className="animate-fade-in fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="animate-slide-in-right fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-zinc-800/80 bg-zinc-950/95 backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-zinc-800/60 px-6 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-zinc-500">Lead Conversation</p>
            <h2 className="mt-1 truncate text-base font-semibold text-white">{lead.lead_id}</h2>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800/60 text-zinc-500 transition-colors hover:bg-zinc-800/50 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b border-zinc-800/40 px-6 py-3.5">
          <p className="mb-2.5 text-xs font-medium text-zinc-500">Pipeline Stage</p>
          <div className="flex flex-wrap gap-1.5">
            {statuses.map((s) => {
              const active = lead.status === s;
              return (
                <button
                  key={s}
                  onClick={() => onChangeStatus(lead, s)}
                  disabled={isUpdating}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all duration-200 disabled:opacity-50 ${
                    active
                      ? STATUS_PILL_STYLES[s]
                      : "border-zinc-800/50 bg-zinc-900/30 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                  }`}
                >
                  {isUpdating && active ? <Loader2 className="h-3 w-3 animate-spin" /> : s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-4 border-b border-zinc-800/40 px-6 py-3">
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <TrendingUp className="h-3.5 w-3.5" />
            Score: <span className="font-bold text-zinc-300">{lead.lead_score}/10</span>
          </div>
          {lead.click_id && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <Hash className="h-3.5 w-3.5" />
              <span className="text-zinc-400">{lead.click_id}</span>
            </div>
          )}
        </div>
        <div ref={scrollRef} className="custom-scrollbar flex-1 overflow-y-auto px-6 py-5">
          {lead.conversation_history.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <MessageSquare className="h-8 w-8 text-zinc-700" />
              <p className="text-sm text-zinc-600">No messages in this conversation yet.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {lead.conversation_history.map((msg, i) => (
                <ChatBubble key={i} message={msg} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ChatBubble({ message }: { message: ConversationMessage }) {
  const isUser = message.role === "user";
  const text = message.message ?? "";
  if (!text.trim()) return null;
  const ts = message.timestamp
    ? new Date(message.timestamp.seconds * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[82%] space-y-1.5 ${isUser ? "items-end" : "items-start"}`}>
        <div className={`flex items-center gap-1.5 text-[11px] font-medium ${isUser ? "justify-end text-slate-400" : "text-zinc-500"}`}>
          {isUser ? (
            <>{message.channel === "email" ? <Mail className="h-3 w-3" /> : <Phone className="h-3 w-3" />} Lead</>
          ) : (
            <><Bot className="h-3 w-3" /> AI Assistant</>
          )}
        </div>
        <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${isUser ? "rounded-br-md bg-slate-700/50 text-slate-100" : "rounded-bl-md bg-zinc-800/70 text-zinc-200"}`}>
          {text}
        </div>
        <div className={`flex items-center gap-2 text-[10px] text-zinc-600 ${isUser ? "justify-end" : ""}`}>
          {ts && <span className="flex items-center gap-1"><Clock className="h-2.5 w-2.5" />{ts}</span>}
          {message.intent && !isUser && <span className="rounded border border-zinc-700/50 bg-zinc-800/40 px-1.5 py-0.5 text-[10px] text-zinc-500">{message.intent}</span>}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   TAB 2 — AI COMMAND CENTER
   ═══════════════════════════════════════════════════════════════════ */

function AiCommandCenter({
  pushToast,
}: {
  pushToast: (msg: string, type?: "success" | "error") => void;
}) {
  const [persona, setPersona] = useState("");
  const [savedPersona, setSavedPersona] = useState("");
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, "settings", "system"),
      (snapshot) => {
        const data = snapshot.data();
        const value = getString(data?.ai_persona) ?? DEFAULT_PERSONA;
        setPersona(value);
        setSavedPersona(value);
        setLoadingSettings(false);
      },
      (err) => {
        pushToast(`Failed to load settings: ${err.message}`, "error");
        setPersona(DEFAULT_PERSONA);
        setSavedPersona(DEFAULT_PERSONA);
        setLoadingSettings(false);
      },
    );
    return unsubscribe;
  }, [pushToast]);

  const isDirty = persona !== savedPersona;
  const charCount = persona.length;

  async function handleSave() {
    if (!isDirty || saving) return;
    setSaving(true);
    try {
      await setDoc(doc(db, "settings", "system"), { ai_persona: persona }, { merge: true });
      setSavedPersona(persona);
      setSaved(true);
      pushToast("System guidelines deployed successfully");
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      pushToast(`Save failed: ${(e as Error).message}`, "error");
    } finally {
      setSaving(false);
    }
  }

  if (loadingSettings) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="h-8 w-48 animate-pulse rounded-lg bg-zinc-800/50" />
        <div className="h-64 animate-pulse rounded-xl bg-zinc-800/30" />
        <div className="h-12 w-56 animate-pulse rounded-xl bg-zinc-800/30" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/15 to-blue-500/15 ring-1 ring-violet-400/15">
            <Sparkles className="h-5 w-5 text-violet-400" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-white">AI Persona Engine</h2>
            <p className="mt-0.5 text-sm text-zinc-500">
              Configure the behavioral guardrails, language style, and product context for your AI assistant.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 backdrop-blur-sm">
        <div className="flex items-center justify-between border-b border-zinc-800/50 px-5 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-300">
            <Brain className="h-4 w-4 text-zinc-500" />
            System Prompt
          </div>
          <span className="text-xs text-zinc-600">{charCount.toLocaleString()} characters</span>
        </div>
        <div className="p-4">
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            rows={14}
            spellCheck={false}
            className="w-full resize-none rounded-lg border border-zinc-800/50 bg-zinc-950/60 px-4 py-3 font-mono text-sm leading-relaxed text-zinc-200 placeholder-zinc-700 outline-none transition-colors focus:border-cyan-500/30 focus:ring-1 focus:ring-cyan-500/20"
            placeholder="Enter your AI persona instructions here..."
          />
        </div>
        <div className="flex items-center justify-between border-t border-zinc-800/50 px-5 py-3.5">
          <div className="text-xs text-zinc-600">
            {isDirty ? (
              <span className="flex items-center gap-1.5 text-amber-400/80">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Unsaved changes
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-emerald-500/70">
                <Check className="h-3 w-3" /> Up to date
              </span>
            )}
          </div>
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            className={`flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-all duration-300 ${
              isDirty ? "bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/30" : "bg-zinc-800/50 text-zinc-600"
            } disabled:cursor-not-allowed`}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
            {saving ? "Deploying..." : saved ? "Deployed!" : "Save System Guidelines"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   TAB 3 — MARKETING ATTRIBUTION
   ═══════════════════════════════════════════════════════════════════ */

function AttributionTab({ leads, loading }: { leads: Lead[]; loading: boolean }) {
  const qualifyingLeads = useMemo(
    () => leads.filter((l) => (l.status === "hot" || l.status === "interested") && l.click_id && l.click_id.trim().length > 0),
    [leads],
  );
  const trackedLeads = useMemo(
    () => leads.filter((l) => l.click_id && l.click_id.trim().length > 0),
    [leads],
  );
  const channelStats = useMemo(() => {
    const stats = { whatsapp: 0, email: 0 };
    for (const l of qualifyingLeads) {
      const lastChannel = [...l.conversation_history].reverse().find((m) => m.channel)?.channel;
      if (lastChannel === "whatsapp") stats.whatsapp++;
      else if (lastChannel === "email") stats.email++;
      else stats.whatsapp++;
    }
    return stats;
  }, [qualifyingLeads]);

  const conversionRate = trackedLeads.length > 0 ? Math.round((qualifyingLeads.length / trackedLeads.length) * 100) : 0;

  function downloadCSV() {
    const headers = ["Google Click ID", "Lead Identifier", "Conversion Stage", "Lead Score", "Timestamp"];
    const rows = qualifyingLeads.map((l) => [
      l.click_id ?? "", l.lead_id, l.status, l.lead_score.toString(), (l.last_interaction ?? new Date()).toISOString(),
    ]);
    const csv = [headers, ...rows].map((r) => r.map(escapeCSV).join(",")).join("\n");
    triggerDownload(csv, `conversions_${dateStamp()}.csv`, "text/csv");
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-zinc-800/30" />)}
        </div>
        <div className="h-64 animate-pulse rounded-xl bg-zinc-800/20" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500/15 to-orange-500/15 ring-1 ring-amber-400/15">
          <TrendingUp className="h-5 w-5 text-amber-400" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-white">Marketing Attribution</h2>
          <p className="mt-0.5 text-sm text-zinc-500">Offline conversion data for Meta Ads Manager &amp; Google Ads feedback loops.</p>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard icon={<Hash className="h-4 w-4" />} label="Tracked Leads" value={trackedLeads.length} />
        <MetricCard icon={<Zap className="h-4 w-4" />} label="Conversions" value={qualifyingLeads.length} variant="emerald" />
        <MetricCard icon={<TrendingUp className="h-4 w-4" />} label="Conv. Rate" value={conversionRate} suffix="%" />
        <MetricCard icon={<Download className="h-4 w-4" />} label="Export Ready" value={qualifyingLeads.length} variant="hot" />
      </div>

      <div className="mb-6 flex flex-wrap gap-3">
        <button
          onClick={downloadCSV}
          disabled={qualifyingLeads.length === 0}
          className="flex items-center gap-2 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.06] px-5 py-2.5 text-sm font-semibold text-cyan-300 transition-all duration-300 hover:border-cyan-400/40 hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download className="h-4 w-4" /> Download Conversion CSV
        </button>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ChannelBar label="WhatsApp" count={channelStats.whatsapp} total={qualifyingLeads.length} color="emerald" />
        <ChannelBar label="Email" count={channelStats.email} total={qualifyingLeads.length} color="blue" />
      </div>

      <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 backdrop-blur-sm">
        <div className="flex items-center justify-between border-b border-zinc-800/50 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-zinc-300">Qualifying Leads</h3>
          <span className="rounded-lg border border-zinc-700/50 bg-zinc-800/40 px-2 py-0.5 text-xs font-bold text-zinc-400">{qualifyingLeads.length}</span>
        </div>
        {qualifyingLeads.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <Inbox className="h-8 w-8 text-zinc-700" />
            <p className="text-sm text-zinc-600">No leads currently qualify for conversion export.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800/40 text-left text-xs font-medium text-zinc-500">
                  <th className="px-5 py-2.5">Click ID</th>
                  <th className="px-5 py-2.5">Lead</th>
                  <th className="px-5 py-2.5">Stage</th>
                  <th className="px-5 py-2.5">Score</th>
                  <th className="px-5 py-2.5">Last Active</th>
                </tr>
              </thead>
              <tbody>
                {qualifyingLeads.map((l) => (
                  <tr key={l.id} className="border-b border-zinc-800/20 transition-colors hover:bg-zinc-800/20">
                    <td className="px-5 py-3 font-mono text-xs text-cyan-400/80">{l.click_id}</td>
                    <td className="px-5 py-3 text-zinc-300">{maskLeadId(l.lead_id)}</td>
                    <td className="px-5 py-3"><span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_PILL_STYLES[l.status]}`}>{l.status}</span></td>
                    <td className="px-5 py-3 font-bold text-zinc-200">{l.lead_score}/10</td>
                    <td className="px-5 py-3 text-xs text-zinc-500">{l.last_interaction?.toLocaleDateString() ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ChannelBar({ label, count, total, color }: { label: string; count: number; total: number; color: "emerald" | "blue" }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const barColor = color === "emerald" ? "bg-emerald-500" : "bg-blue-500";
  const textColor = color === "emerald" ? "text-emerald-400" : "text-blue-400";
  const icon = color === "emerald" ? <Phone className="h-3.5 w-3.5" /> : <Mail className="h-3.5 w-3.5" />;
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className={`flex items-center gap-2 text-sm font-medium ${textColor}`}>{icon}{label}</div>
        <span className="text-xs text-zinc-500">{count} leads ({pct}%)</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800/60">
        <div className={`h-full rounded-full ${barColor} transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SKELETON & UTILS
   ═══════════════════════════════════════════════════════════════════ */

function PipelineSkeleton() {
  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-xl border border-zinc-800/40 bg-zinc-900/20 p-4">
            <div className="h-3 w-20 animate-pulse rounded bg-zinc-800/60" />
            <div className="mt-3 h-8 w-14 animate-pulse rounded-lg bg-zinc-800/40" />
          </div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-1 gap-4 xl:grid-cols-5">
        {PIPELINE_COLUMNS.map((col) => (
          <div key={col.status} className="flex min-h-[480px] flex-col rounded-xl border border-zinc-800/30 bg-zinc-900/15">
            <div className="flex items-center justify-between border-b border-zinc-800/30 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <span className={`h-2 w-2 rounded-full ${col.dotColor} opacity-40`} />
                <div className="h-3.5 w-16 animate-pulse rounded bg-zinc-800/50" />
              </div>
              <div className="h-6 w-6 animate-pulse rounded-lg bg-zinc-800/40" />
            </div>
            <div className="flex-1 space-y-2.5 p-2.5">
              {[1, 2].map((j) => (
                <div key={j} className="rounded-xl border border-zinc-800/30 bg-zinc-900/20 p-3.5">
                  <div className="flex justify-between">
                    <div className="space-y-2">
                      <div className="h-2.5 w-20 animate-pulse rounded bg-zinc-800/40" />
                      <div className="h-3.5 w-28 animate-pulse rounded bg-zinc-800/50" />
                    </div>
                    <div className="h-6 w-12 animate-pulse rounded-lg bg-zinc-800/40" />
                  </div>
                  <div className="mt-3 rounded-lg border border-zinc-800/20 bg-zinc-950/30 p-2.5">
                    <div className="h-2.5 w-12 animate-pulse rounded bg-zinc-800/30" />
                    <div className="mt-2 space-y-1.5">
                      <div className="h-2.5 w-full animate-pulse rounded bg-zinc-800/25" />
                      <div className="h-2.5 w-3/4 animate-pulse rounded bg-zinc-800/20" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function MetricCard({ icon, label, value, variant, suffix }: { icon: React.ReactNode; label: string; value: number; variant?: "hot" | "emerald" | "rose"; suffix?: string; }) {
  const styles = variant === "hot" ? "border-amber-400/25 bg-amber-400/[0.04] animate-pulse-glow" : variant === "emerald" ? "border-emerald-400/20 bg-emerald-400/[0.04]" : variant === "rose" ? "border-rose-400/15 bg-rose-400/[0.03]" : "border-zinc-800/80 bg-zinc-900/50";
  return (
    <div className={`rounded-xl border p-4 backdrop-blur-sm transition-all duration-300 hover:scale-[1.02] ${styles}`}>
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">{icon}{label}</div>
      <div className={`mt-2 text-3xl font-bold tracking-tight ${variant === "hot" ? "text-amber-300" : "text-white"}`}>{value}{suffix ?? ""}</div>
    </div>
  );
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function toLeadStatus(value: unknown): LeadStatus {
  if (value === "new" || value === "contacted" || value === "interested" || value === "hot" || value === "paused") return value;
  return "new";
}
function clampScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10, Math.round(value)));
}
function toDateOrNull(value: unknown): Date | null {
  if (value && typeof value === "object" && "seconds" in value) {
    return new Date((value as { seconds: number }).seconds * 1000);
  }
  return null;
}
function toConversation(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null).map((m) => ({
    role: m.role === "user" || m.role === "model" ? m.role : undefined,
    channel: m.channel === "whatsapp" || m.channel === "email" ? m.channel : undefined,
    message: getString(m.message) ?? getString(m.text) ?? "",
    intent: getString(m.intent) ?? undefined,
    timestamp: m.timestamp && typeof m.timestamp === "object" && "seconds" in (m.timestamp as Record<string, unknown>) ? (m.timestamp as { seconds: number; nanoseconds: number }) : undefined,
  }));
}
function maskLeadId(value: string): string {
  if (value.includes("@")) {
    const [name, domain] = value.split("@");
    const visible = name.length > 2 ? `${name.slice(0, 2)}***` : "***";
    return `${visible}@${domain}`;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 4) return `***${digits.slice(-4)}`;
  return value;
}
function getLatestMessage(messages: ConversationMessage[]): string {
  const latest = [...messages].reverse().find((m) => m.message && m.message.trim().length > 0);
  return latest?.message ?? "No conversation history yet.";
}
function escapeCSV(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n")) return `"${field.replace(/"/g, '""')}"`;
  return field;
}
function dateStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}
function triggerDownload(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}