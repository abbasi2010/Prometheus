import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, FileText, Globe, Highlighter, History, Home, MessageSquare, Mic, PanelLeft, PanelRight,
  Pin, Plus, RotateCw, Send, Settings, StickyNote, X,
} from "lucide-react";
import logoUrl from "../../../../assets/logo.svg";
import type { AgentEvent, Entry, FilingLink, Quote, ReaderDoc, SelectionInfo, TabInfo } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Chip } from "../components/ui/chip";
import { EmptyState } from "../components/ui/empty-state";
import { Skeleton } from "../components/ui/skeleton";
import { Tab } from "../components/ui/tab";
import { cn } from "../lib/utils";
import { nextWidth } from "../shell/drag";
import { money, multiple, percent, prettyDate, price } from "./format";
import { FeedView, hiddenTickers, hideTickers } from "./FeedView";
import { HowIWork } from "./HowIWork";
import { ModelView, type Assumption } from "./ModelView";
import { ReportView, type ReportDoc } from "./ReportView";

type Theme = "system" | "light" | "dark";
type View = "overview" | "research" | "notebook" | "archive";
type Company = { id: string; ticker: string; name: string; archived?: boolean };
type ChatStep = { text: string; state: "running" | "done" | "failed"; undoId?: string };
type ChatMessage = { id: string; role: "user" | "assistant"; text: string; status?: string; chips?: { label: string; url?: string }[]; steps?: ChatStep[] };
type Thread = { id: string; companyId: string; title: string; closed: boolean; updated: number; messages: ChatMessage[]; parentId?: string; status?: string };
type Snap = { text: string; at: number };
type FactPoint = { fy: string; end: string; value: number };
type FactsPayload = { error?: string; facts?: Record<string, { values?: FactPoint[] }> };
type NewsHit = { title: string; url: string; snippet: string; kind: string };
type Bundle = {
  quote: Quote;
  facts: FactsPayload;
  filings: FilingLink[];
  filingsError?: string;
  news: NewsHit[];
  newsError?: string;
  peers: { rows?: Quote[]; error?: string };
  profile?: { sic: string; sicDescription: string; industry: "pc" | "generic"; error?: string };
};

const seed: Company[] = [
  { id: "uber", ticker: "UBER", name: "Uber" },
  { id: "lyft", ticker: "LYFT", name: "Lyft" },
];

const filters = [
  { id: "all", label: "All" },
  { id: "annual", label: "Annual" },
  { id: "quarterly", label: "Quarterly" },
  { id: "current", label: "Current/8-K" },
  { id: "proxy", label: "Proxy" },
  { id: "other", label: "Other" },
] as const;

const topics = [
  { id: "business", label: "Business model", q: (name: string) => `How does ${name} make money?` },
  { id: "financials", label: "Financials", q: (name: string) => `What were ${name}'s latest fiscal-year revenue and net income?` },
  { id: "risks", label: "Risks", q: (name: string) => `What are the main risks in ${name}'s latest annual report?` },
  { id: "competition", label: "Competition and peers", q: (name: string) => `Who does ${name} compete with, and how do the peers compare on valuation?` },
  { id: "valuation", label: "Valuation", q: (name: string) => `What valuation multiples does ${name} trade at versus its peers?` },
  { id: "management", label: "Management", q: (name: string) => `What does ${name}'s latest proxy say about management and the board?` },
  { id: "sentiment", label: "Sentiment", q: (name: string) => `Find sources that illustrate bull and bear sentiment on ${name}.` },
  { id: "news", label: "News", q: (name: string) => `What is the recent news on ${name}?` },
];

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function toAddress(input: string): string {
  const text = input.trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w.-]+\.[a-z]{2,}([/?#].*)?$/i.test(text) && !/\s/.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

function makeThread(company: Company): Thread {
  return { id: rid(), companyId: company.id, title: company.name, closed: false, updated: Date.now(), messages: [] };
}

function covered(id: string, entries: Entry[]): boolean {
  const blob = entries.map((entry) => `${entry.type} ${entry.title} ${entry.text || ""} ${entry.note || ""} ${entry.tag || ""}`).join("\n").toLowerCase();
  if (id === "business") return /business|segment|makes money|10-k|annual/.test(blob);
  if (id === "financials") return /revenue|net income|margin|financial/.test(blob);
  if (id === "risks") return /risk/.test(blob);
  if (id === "competition") return /peer|compet/.test(blob);
  if (id === "valuation") return /valuation|p\/e|market cap|multiple/.test(blob);
  if (id === "management") return /management|governance|proxy|board|executive/.test(blob);
  if (id === "sentiment") return /bull|bear|sentiment/.test(blob);
  if (id === "news") return entries.some((entry) => entry.type === "page") || /news/.test(blob);
  return false;
}

const summaryThemes = ["Business", "Financials", "Risks", "Industry and competition", "Management", "Open questions"] as const;

function themeFor(entry: Entry): (typeof summaryThemes)[number] {
  const hay = `${entry.title} ${entry.text || ""} ${entry.note || ""} ${entry.tag || ""}`.toLowerCase();
  if (/risk|litigation|regulat/.test(hay)) return "Risks";
  if (/compet|peer|industry|market share/.test(hay)) return "Industry and competition";
  if (/management|ceo|cfo|compensation|board|executive/.test(hay)) return "Management";
  if (entry.type === "question" || entry.tag === "Question" || /\?/.test(entry.text || "")) return "Open questions";
  if (/revenue|income|margin|cash|eps|profit|debt|assets|financial/.test(hay)) return "Financials";
  return "Business";
}

function Spark({ values, up, width = 72 }: { values?: number[]; up: boolean; width?: number }) {
  if (!values || values.length < 2) return <span className="inline-block h-[22px]" style={{ width }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const height = 22;
  const path = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / (max - min || 1)) * (height - 2) - 1;
    return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={path} fill="none" stroke={up ? "var(--gain)" : "var(--loss)"} strokeWidth="1.5" />
    </svg>
  );
}

const ranges = [
  ["1d", "1D"],
  ["5d", "5D"],
  ["1m", "1M"],
  ["6m", "6M"],
  ["ytd", "YTD"],
  ["1y", "1Y"],
  ["5y", "5Y"],
] as const;

const headlines = [
  { ticker: "AAPL", name: "Apple" },
  { ticker: "WMT", name: "Walmart" },
  { ticker: "JNJ", name: "Johnson & Johnson" },
  { ticker: "NVDA", name: "Nvidia" },
  { ticker: "AMD", name: "AMD" },
  { ticker: "INTC", name: "Intel" },
  { ticker: "TSLA", name: "Tesla" },
  { ticker: "JPM", name: "JPMorgan" },
  { ticker: "BX", name: "Blackstone" },
  { ticker: "AMZN", name: "Amazon" },
  { ticker: "BRK-B", name: "Berkshire" },
];

type Series = { ticker: string; range: string; points: { t: number; price: number }[]; changePercent: number | null; asOf?: string; error?: string };
type Hit = { ticker: string; title: string };

function PriceChart({ points, range }: { points: { t: number; price: number }[]; range: string }) {
  const [cursor, setCursor] = useState<number | null>(null);
  if (points.length < 2) return null;
  const min = Math.min(...points.map((point) => point.price));
  const max = Math.max(...points.map((point) => point.price));
  const width = 640;
  const plot = 168;
  const height = 196;
  const up = points[points.length - 1].price >= points[0].price;
  const yOf = (value: number) => plot - ((value - min) / (max - min || 1)) * (plot - 20) - 8;
  const path = points.map((point, index) => {
    const x = (index / (points.length - 1)) * width;
    return `${index ? "L" : "M"}${x.toFixed(1)},${yOf(point.price).toFixed(1)}`;
  }).join(" ");
  const sample = cursor == null ? null : (() => {
    const pos = cursor * (points.length - 1);
    const left = Math.floor(pos);
    const right = Math.min(points.length - 1, left + 1);
    const mix = pos - left;
    const value = points[left].price + (points[right].price - points[left].price) * mix;
    const t = points[left].t + (points[right].t - points[left].t) * mix;
    return { x: cursor * width, y: yOf(value), price: value, t };
  })();
  const when = (t: number) => (range === "1d" || range === "5d" ? new Date(t).toLocaleString() : new Date(t).toLocaleDateString());
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
    const point = points[Math.round(frac * (points.length - 1))];
    const label = range === "1d" || range === "5d"
      ? new Date(point.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : new Date(point.t).toLocaleDateString([], { month: "short", day: "numeric" });
    return { x: frac * width, label };
  });
  const label = sample ? `${price(sample.price)} · ${when(sample.t)}` : "";
  const labelX = sample ? (sample.x > width - 168 ? sample.x - 8 : sample.x + 8) : 0;
  const labelAnchor = sample && sample.x > width - 168 ? "end" : "start";
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-52 w-full"
      onMouseLeave={() => setCursor(null)}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setCursor(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
      }}
    >
      <path d={path} fill="none" stroke={up ? "var(--gain)" : "var(--loss)"} strokeWidth="2.5" />
      {sample && (
        <>
          <line x1={sample.x} x2={sample.x} y1={8} y2={plot} stroke="currentColor" strokeOpacity="0.28" />
          <circle cx={sample.x} cy={sample.y} r="4.5" fill={up ? "var(--gain)" : "var(--loss)"} />
          <text x={labelX} y={Math.max(14, sample.y - 10)} textAnchor={labelAnchor} fontSize="12" fill="currentColor">{label}</text>
        </>
      )}
      {ticks.map((tick) => (
        <text key={tick.label + tick.x} x={tick.x} y={height - 4} textAnchor={tick.x === 0 ? "start" : tick.x === width ? "end" : "middle"} fontSize="11" fill="currentColor" opacity="0.62">{tick.label}</text>
      ))}
    </svg>
  );
}

function CompanySearch({ placeholder, onPick }: { placeholder: string; onPick: (hit: Hit) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const text = query.trim();
    if (text.length < 1) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(() => {
      const search = window.analyst?.company.search;
      if (!search) return;
      void search(text).then((rows) => {
        setHits(rows);
        setOpen(true);
      });
    }, 140);
    return () => window.clearTimeout(handle);
  }, [query]);
  return (
    <div className="relative">
      <input
        value={query}
        placeholder={placeholder}
        className="h-8 w-full rounded-[8px] border border-line bg-card px-2 text-sm text-ink outline-none placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent"
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => { if (hits.length) setOpen(true); }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && hits[0]) {
            event.preventDefault();
            onPick(hits[0]);
            setQuery("");
            setOpen(false);
          }
        }}
      />
      {open && query.trim() && (
        <ul className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-[8px] border border-line bg-card py-1 shadow">
          {hits.length === 0 ? <li className="px-3 py-2 text-[13px] text-muted">No matching company</li> : hits.map((hit) => (
            <li key={hit.ticker}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-black/5 dark:hover:bg-white/8"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onPick(hit);
                  setQuery("");
                  setOpen(false);
                }}
              >
                <span className="w-16 shrink-0 font-medium">{hit.ticker}</span>
                <span className="truncate text-muted">{hit.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Belt({ rows, reverse, onPick }: { rows: { ticker: string; name: string }[]; reverse?: boolean; onPick: (row: { ticker: string; name: string }) => void }) {
  const loop = [...rows, ...rows];
  return (
    <div className="marquee overflow-hidden">
      <div className={cn("marquee-track flex w-max gap-3 px-3", reverse && "marquee-rev")}>
        {loop.map((item, index) => (
          <button key={`${item.ticker}-${index}`} type="button" className="flex w-48 shrink-0 items-center justify-between rounded-[8px] border border-line bg-card px-3 py-2 text-left transition-colors duration-150 hover:border-accent" onClick={() => onPick(item)}>
            <span className="truncate text-sm font-medium">{item.name}</span>
            <span className="ml-2 text-[12px] text-muted">{item.ticker}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function dayKey(at: number): string {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function Shell() {
  const [theme, setTheme] = useState<Theme>("system");
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [sidebar, setSidebar] = useState(true);
  const [panel, setPanel] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [panelWidth, setPanelWidth] = useState(380);
  const [screen, setScreen] = useState("home");
  const [view, setView] = useState<Record<string, View>>({});
  const [companies, setCompanies] = useState<Company[]>(seed);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [bundles, setBundles] = useState<Record<string, Bundle>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, Entry[]>>({});
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState("");
  const [rightMode, setRightMode] = useState<"agent" | "highlights">("agent");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [snaps, setSnaps] = useState<Record<string, Snap>>({});
  const [summaries, setSummaries] = useState<Record<string, Snap>>({});
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState("");
  const [chartRange, setChartRange] = useState<(typeof ranges)[number][0]>("1y");
  const [seriesMap, setSeriesMap] = useState<Record<string, Series>>({});
  const [homeDraft, setHomeDraft] = useState("");
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [address, setAddress] = useState("");
  const [pick, setPick] = useState<SelectionInfo | null>(null);
  const [plan, setPlan] = useState<{ threadId: string; steps: string[] } | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const [docFocus, setDocFocus] = useState<"library" | "web">("library");
  const [filingFilter, setFilingFilter] = useState<(typeof filters)[number]["id"]>("all");
  const [filingQuery, setFilingQuery] = useState("");
  const [showInsiders, setShowInsiders] = useState(false);
  const [notebookMode, setNotebookMode] = useState<"timeline" | "summary">("timeline");
  const [logFilter, setLogFilter] = useState("all");
  const [logQuery, setLogQuery] = useState("");
  const [asOf, setAsOf] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const [highlightTag, setHighlightTag] = useState("Evidence");
  const [tagFilter, setTagFilter] = useState("");
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState("");
  const [companyMenu, setCompanyMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const [teamPlan, setTeamPlan] = useState<{ teamId: string; company: string; assignments: { id: string; title: string; question: string; sources: string; depth: string; status: string; threadId: string; reportId?: string }[] } | null>(null);
  const [reports, setReports] = useState<ReportDoc[]>([]);
  const [activeReport, setActiveReport] = useState("");
  const [showModel, setShowModel] = useState(false);
  const [assumptions, setAssumptions] = useState<Assumption[]>([]);
  const [modelInputs, setModelInputs] = useState({ revenue0: 1_000_000_000, growth: [0.08, 0.08, 0.07, 0.06, 0.05], margin: [0.12, 0.13, 0.14, 0.14, 0.15], tax: 0.21, capexPct: [0.03, 0.03, 0.03, 0.03, 0.03], shares0: 1_000_000_000, buyback: [0.01, 0.01, 0.01, 0.01, 0.01], discount: null as number | null, multiple: null as number | null });
  const [askCard, setAskCard] = useState<{ prompt: string; kind: "choice" | "number"; options?: string[]; key: string } | null>(null);
  const [attached, setAttached] = useState("");
  const [reaction, setReaction] = useState("");
  const [feedPreview, setFeedPreview] = useState<{ ticker: string; reasons: string[] }[]>([]);
  const [booted, setBooted] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<TabInfo[]>([]);
  const focusRef = useRef(docFocus);
  const threadsRef = useRef(threads);
  const companiesRef = useRef(companies);
  tabsRef.current = tabs;
  focusRef.current = docFocus;
  threadsRef.current = threads;
  companiesRef.current = companies;

  const visibleCompanies = companies.filter((item) => !item.archived);
  const company = visibleCompanies.find((item) => item.id === screen) || null;
  const currentView: View = company ? view[company.id] || "overview" : "overview";
  const active = tabs.find((tab) => tab.active) || null;
  const quote = company ? quotes[company.ticker] : undefined;
  const bundle = company ? bundles[company.ticker] : undefined;
  const entries = company ? notes[company.ticker] || [] : [];
  const openThreads = threads.filter((thread) => company && thread.companyId === company.id && !thread.closed);
  const thread = threads.find((item) => item.id === activeThread) || null;
  const closedThreads = threads.filter((item) => item.closed);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && systemDark));
  }, [theme, systemDark]);

  useEffect(() => {
    let live = true;
    const start = () => {
      if (!window.analyst) {
        window.setTimeout(start, 40);
        return;
      }
      void window.analyst.workspace.get().then((saved) => {
        if (!live) return;
        const row = (saved || {}) as {
          theme?: Theme;
          sidebar?: boolean;
          panel?: boolean;
          sidebarWidth?: number;
          panelWidth?: number;
          screen?: string;
          view?: Record<string, View | "documents">;
          companies?: Company[];
          threads?: Thread[];
          snaps?: Record<string, Snap>;
          summaries?: Record<string, Snap>;
        };
        if (row.theme) setTheme(row.theme);
        if (typeof row.sidebar === "boolean") setSidebar(row.sidebar);
        if (typeof row.panel === "boolean") setPanel(row.panel);
        if (row.sidebarWidth) setSidebarWidth(row.sidebarWidth);
        if (row.panelWidth) setPanelWidth(row.panelWidth);
        if (row.companies?.length) setCompanies(row.companies);
        if (row.view) {
          const mapped: Record<string, View> = {};
          for (const [key, value] of Object.entries(row.view)) mapped[key] = value === "documents" ? "research" : value;
          setView(mapped);
        }
        if (row.snaps) setSnaps(row.snaps);
        if (row.summaries) setSummaries(row.summaries);
        const savedThreads = Array.isArray(row.threads) ? row.threads : [];
        const savedScreen = row.screen || "home";
        let nextThreads = savedThreads;
        if (savedScreen !== "home" && savedScreen !== "settings") {
          const list = row.companies?.length ? row.companies : seed;
          const owner = list.find((item) => item.id === savedScreen);
          const mine = nextThreads.filter((item) => item.companyId === savedScreen).sort((a, b) => b.updated - a.updated);
          if (owner && !mine.length) {
            const created = makeThread(owner);
            nextThreads = [...nextThreads, created];
            setActiveThread(created.id);
          } else if (mine[0]) {
            const pick = mine.find((item) => !item.closed) || mine[0];
            nextThreads = nextThreads.map((item) => (item.id === pick.id ? { ...item, closed: false } : item));
            setActiveThread(pick.id);
          }
        }
        setThreads(nextThreads);
        setScreen(savedScreen);
        setBooted(true);
      });
      const off = window.analyst.tabs.onChange((snap) => setTabs(snap.tabs));
      const keys = window.analyst.tabs.onShortcut((name) => {
        const open = tabsRef.current;
        if (name === "palette") { setPalette(true); setQuery(""); }
        if (name === "sidebar") setSidebar((value) => !value);
        if (name === "panel") setPanel((value) => !value);
        if (name === "address") addressRef.current?.focus();
        if (name === "new-tab") {
          void window.analyst.tabs.newTab();
          setDocFocus("web");
        }
        if (name === "close-tab" && focusRef.current === "web") {
          const current = open.find((tab) => tab.active);
          if (current) void window.analyst.tabs.close(current.id);
        }
        if (name === "reload" && focusRef.current === "web") void window.analyst.tabs.reload();
        if ((name === "prev-tab" || name === "next-tab") && focusRef.current === "web") {
          const index = open.findIndex((tab) => tab.active);
          const step = name === "next-tab" ? 1 : -1;
          const next = open[(index + step + open.length) % open.length];
          if (next) void window.analyst.tabs.activate(next.id);
        }
      });
      const agentOff = window.analyst.agent.onEvent((event) => applyEvent(event));
      const notesOff = window.analyst.notebook.onChange(() => {
        const current = companiesRef.current.find((item) => item.id === screenRef.current);
        if (current) void refreshNotes(current.ticker);
      });
      const highlightOff = window.analyst.onHighlight(() => {
        setPanel(true);
        setRightMode("highlights");
      });
      const selectionOff = window.analyst.selection.onShow((selection) => {
        if (selection?.text) setPick(selection);
      });
      const applyOff = window.analyst.workspace.onApply((command) => {
        if (command.type === "theme" && command.theme) setTheme(command.theme);
        if (command.type === "company" && command.name) void addCompany(command.name);
      });
      cleanups = [off, keys, agentOff, notesOff, highlightOff, selectionOff, applyOff];
    };
    let cleanups: (() => void)[] = [];
    start();
    return () => {
      live = false;
      cleanups.forEach((fn) => fn());
    };
  }, []);

  const screenRef = useRef(screen);
  screenRef.current = screen;

  useEffect(() => {
    if (!booted) return;
    const label = showModel ? "model" : activeReport ? "report" : screen;
    const timer = window.setTimeout(() => { void window.analyst?.capture(label); }, 700);
    return () => window.clearTimeout(timer);
  }, [booted, screen, currentView, showModel, activeReport]);

  useEffect(() => {
    void window.analyst?.memory.get().then((memory) => {
      const ratings = (memory as { ratings?: { ticker: string; vote: string }[] } | undefined)?.ratings || [];
      hideTickers(ratings.filter((rating) => rating.vote === "not" || rating.vote === "known").map((rating) => rating.ticker));
    }).finally(() => {
      void window.analyst?.feed.ranked().then((data) => {
        const rows = (data as { rows?: { ticker: string; reasons: string[] }[] } | undefined)?.rows || [];
        const hidden = hiddenTickers();
        setFeedPreview(rows.filter((row) => !hidden.has(row.ticker.toUpperCase())).slice(0, 5));
      });
    });
  }, [screen]);

  useEffect(() => {
    if (!booted) return;
    const timer = window.setTimeout(() => {
      void window.analyst?.workspace.save({ theme, sidebar, panel, sidebarWidth, panelWidth, screen, view, companies, threads, snaps, summaries });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [booted, theme, sidebar, panel, sidebarWidth, panelWidth, screen, view, companies, threads, snaps, summaries]);

  useEffect(() => {
    if (!booted || !company) return;
    if (threadsRef.current.some((item) => item.companyId === company.id)) return;
    const created = makeThread(company);
    setThreads((list) => (list.some((item) => item.companyId === company.id) ? list : [...list, created]));
    setActiveThread(created.id);
  }, [booted, company?.id]);

  useEffect(() => {
    if (!booted) return;
    for (const item of companiesRef.current) {
      void window.analyst?.company.quote(item.ticker).then((row) => {
        setQuotes((current) => ({ ...current, [item.ticker]: row }));
      }).catch((error: Error) => {
        setQuotes((current) => ({ ...current, [item.ticker]: { ticker: item.ticker, error: error.message } }));
      });
      void refreshNotes(item.ticker);
    }
  }, [booted, companies.map((item) => item.ticker).join("|")]);

  useEffect(() => {
    if (!company) return;
    void window.analyst?.tabs.group(company.id).then((snap) => setTabs(snap.tabs));
    if (!bundles[company.ticker]) void loadBundle(company.ticker);
  }, [company?.id]);

  useEffect(() => {
    if (!company) return;
    const load = window.analyst?.company.series;
    if (!load) return;
    const key = `${company.ticker}:${chartRange}`;
    let cancel = false;
    void load(company.ticker, chartRange).then((row) => {
      if (!cancel) setSeriesMap((current) => ({ ...current, [key]: row }));
    }).catch((error: Error) => {
      if (!cancel) setSeriesMap((current) => ({ ...current, [key]: { ticker: company.ticker, range: chartRange, points: [], changePercent: null, error: error.message } }));
    });
    return () => { cancel = true; };
  }, [company?.ticker, chartRange]);

  useEffect(() => {
    if (docFocus === "web") setAddress(active?.url || "");
    stripRef.current?.querySelector("[data-active='true']")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [docFocus, active?.id, active?.url]);

  useEffect(() => {
    const node = stageRef.current;
    const show = Boolean(company && currentView === "research" && docFocus === "web" && active?.kind === "web" && active.url);
    if (!node || !show) {
      window.analyst?.tabs.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    const send = () => {
      const rect = node.getBoundingClientRect();
      window.analyst.tabs.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    };
    send();
    const observer = new ResizeObserver(send);
    observer.observe(node);
    window.addEventListener("resize", send);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [company?.id, currentView, docFocus, active?.id, active?.url, sidebar, panel]);

  function applyEvent(event: AgentEvent) {
    const id = event.threadId || "";
    if (id.startsWith("overview:")) {
      const ticker = id.slice("overview:".length);
      setSnaps((current) => {
        const prev = current[ticker] || { text: "", at: 0 };
        if (event.type === "user") return { ...current, [ticker]: { text: "", at: 0 } };
        if (event.type === "token") return { ...current, [ticker]: { text: prev.text + event.text, at: prev.at } };
        if (event.type === "done") return { ...current, [ticker]: { text: prev.text, at: Date.now() } };
        if (event.type === "error") return { ...current, [ticker]: { text: prev.text || event.text, at: Date.now() } };
        return current;
      });
      return;
    }
    if (id.startsWith("summary:")) {
      const ticker = id.slice("summary:".length);
      if (event.type === "summary-token") {
        setSummaries((current) => {
          const prev = current[ticker] || { text: "", at: 0 };
          return { ...current, [ticker]: { text: prev.text + event.text, at: prev.at } };
        });
      }
      if (event.type === "summary-done") {
        setSummaries((current) => ({ ...current, [ticker]: { text: current[ticker]?.text || "", at: Date.now() } }));
        setSummaryBusy(false);
      }
      if (event.type === "error") {
        setSummaries((current) => ({ ...current, [ticker]: { text: event.text, at: Date.now() } }));
        setSummaryBusy(false);
      }
      return;
    }
    if (event.type === "team") {
      setTeamPlan((current) => current && current.teamId === event.teamId ? { ...current, assignments: event.jobs } : current);
      setThreads((list) => {
        const owner = company?.id || screenRef.current;
        const additions = event.jobs.filter((job) => !list.some((item) => item.id === job.threadId)).map((job) => ({
          id: job.threadId,
          companyId: owner,
          title: job.title,
          closed: false,
          updated: Date.now(),
          messages: [] as ChatMessage[],
          parentId: event.teamId,
          status: job.status,
        }));
        return [...additions, ...list.map((item) => {
          const job = event.jobs.find((row) => row.threadId === item.id);
          return job ? { ...item, status: job.status } : item;
        })];
      });
      return;
    }
    if (event.type === "report") {
      setReports((list) => [event.report, ...list.filter((item) => item.id !== event.report.id)]);
      setActiveReport((current) => current || event.report.id);
      setShowModel(false);
      setDocFocus("web");
      if (company) setView((all) => ({ ...all, [company.id]: "research" }));
      return;
    }
    if (event.type === "ask-user") {
      setAskCard({ prompt: event.prompt, kind: event.kind, options: event.options, key: event.key });
      setPanel(true);
      return;
    }
    if (!id) return;
    setThreads((list) => {
      const known = list.some((item) => item.id === id);
      const owner = companiesRef.current.find((item) => item.id === screenRef.current);
      const base = known ? list : [...list, {
        id,
        companyId: id.startsWith("home-") ? "home" : (owner?.id || "home"),
        title: id.startsWith("home-") ? "Home" : "Agent",
        closed: false,
        updated: Date.now(),
        messages: [] as ChatMessage[],
      }];
      return base.map((item) => {
      if (item.id !== id) return item;
      const messages: ChatMessage[] = item.messages.map((message) => ({
        ...message,
        chips: message.chips ? [...message.chips] : undefined,
        steps: message.steps ? message.steps.map((step) => ({ ...step })) : undefined,
      }));
      let title = item.title;
      if (event.type === "user") {
        const first = !messages.some((message) => message.role === "user");
        messages.push({ id: rid(), role: "user", text: event.text });
        if (first) title = event.text.split(/\s+/).slice(0, 6).join(" ");
      }
      if (event.type === "token" || event.type === "progress" || event.type === "source" || event.type === "step" || event.type === "replace") {
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") messages.push({ id: rid(), role: "assistant", text: "" });
        const bubble = messages[messages.length - 1];
        if (event.type === "token") bubble.text += event.text;
        if (event.type === "replace") bubble.text = event.text;
        if (event.type === "progress") bubble.status = event.text;
        if (event.type === "source") bubble.chips = [...(bubble.chips || []), event.chip];
        if (event.type === "step") {
          const steps = bubble.steps || [];
          const lastStep = steps[steps.length - 1];
          if (event.state === "running") {
            if (lastStep?.state === "running") steps[steps.length - 1] = { ...lastStep, state: "done" };
            steps.push({ text: event.text, state: "running" });
          } else if (event.undoId) {
            steps.push({ text: event.text, state: event.state, undoId: event.undoId });
          } else if (lastStep) {
            steps[steps.length - 1] = { text: event.text || lastStep.text, state: event.state };
          } else {
            steps.push({ text: event.text, state: event.state });
          }
          bubble.steps = steps;
        }
      }
      if (event.type === "error") messages.push({ id: rid(), role: "assistant", text: event.text });
      if (event.type === "done") {
        const last = messages[messages.length - 1];
        if (last?.role === "assistant") {
          last.status = "";
          if (last.steps) last.steps = last.steps.map((step) => (step.state === "running" ? { ...step, state: "done" } : step));
        }
      }
      return { ...item, title, messages, updated: Date.now() };
      });
    });
    if (event.type === "done" || event.type === "error") setBusy(false);
  }

  async function refreshNotes(ticker: string) {
    const rows = await window.analyst?.notebook.list(ticker);
    if (rows) setNotes((current) => ({ ...current, [ticker]: rows }));
  }

  async function loadBundle(ticker: string) {
    setLoading((current) => ({ ...current, [ticker]: true }));
    try {
      const data = (await window.analyst?.company.bundle(ticker)) as Bundle;
      if (!data) return;
      setBundles((current) => ({ ...current, [ticker]: data }));
      if (data.quote) setQuotes((current) => ({ ...current, [ticker]: data.quote }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "This couldn't be loaded.";
      setBundles((current) => ({
        ...current,
        [ticker]: { quote: { ticker, error: message }, facts: { error: message }, filings: [], filingsError: message, news: [], newsError: message, peers: { error: message } },
      }));
    } finally {
      setLoading((current) => ({ ...current, [ticker]: false }));
    }
  }

  function openCompany(id: string) {
    setScreen(id);
    setPanel(true);
    const mine = threadsRef.current.filter((item) => item.companyId === id).sort((a, b) => b.updated - a.updated);
    const pick = mine.find((item) => !item.closed) || mine[0];
    if (!pick) return;
    if (pick.closed) setThreads((list) => list.map((item) => (item.id === pick.id ? { ...item, closed: false } : item)));
    setActiveThread(pick.id);
    setRightMode("agent");
  }

  async function addCompany(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const row = await window.analyst?.company.resolve(trimmed);
    if (!row) {
      setAddError(`Couldn't find ${trimmed} in the SEC company list.`);
      return;
    }
    startProject({ ticker: row.ticker, name: row.title });
  }

  async function dismissCompany(item: Company, mode: "archive" | "delete") {
    const ok = await window.analyst?.confirm(mode === "delete" ? `Delete ${item.name} and its notes?` : `Archive ${item.name}? The notes stay saved.`);
    if (!ok) return;
    if (mode === "delete") {
      await window.analyst?.notebook.clearCompany(item.ticker);
      setThreads((list) => list.filter((thread) => thread.companyId !== item.id));
      setCompanies((list) => list.filter((row) => row.id !== item.id));
    } else {
      setCompanies((list) => list.map((row) => row.id === item.id ? { ...row, archived: true } : row));
    }
    if (screen === item.id) setScreen("home");
    setCompanyMenu(null);
  }

  function industryName(): string {
    if (bundle?.profile?.industry === "pc") return "Property and casualty insurance";
    const raw = bundle?.profile?.sicDescription || "";
    const name = raw.replace(/\bSIC\b|\bNEC\b/gi, "").replace(/\s+/g, " ").replace(/^[-,\s]+|[-,\s]+$/g, "");
    return name || "—";
  }

  function openModel() {
    const revenue = bundle?.facts?.facts?.revenue?.values?.[0]?.value;
    const shares = bundle?.facts?.facts?.["diluted shares"]?.values?.[0]?.value || bundle?.facts?.facts?.["shares outstanding"]?.values?.[0]?.value;
    const margin = bundle?.facts?.facts?.["operating income"]?.values?.[0]?.value;
    if (revenue) {
      setModelInputs((current) => ({
        ...current,
        revenue0: revenue,
        shares0: shares || current.shares0,
        margin: margin && revenue ? Array(5).fill(margin / revenue) : current.margin,
      }));
      setAssumptions((rows) => rows.length ? rows : [
        { id: rid(), name: "Starting revenue", value: revenue, unit: "dollars", source: "SEC company facts" },
        { id: rid(), name: "Share count", value: shares || 0, unit: "shares", source: shares ? "SEC company facts" : "Not in the company facts" },
      ]);
    }
    setShowModel(true);
    setActiveReport("");
    setPanel(true);
    setAskCard({ prompt: "What discount rate or exit multiple should this model use?", kind: "number", key: "discount or multiple" });
  }

  function startProject(row: { ticker: string; name?: string; title?: string }) {
    const ticker = row.ticker.toUpperCase();
    const id = ticker.toLowerCase();
    const name = row.name || row.title || ticker;
    setAddError("");
    setCompanies((list) => (list.some((item) => item.ticker === ticker) ? list : [...list, { id, ticker, name }]));
    openCompany(id);
    void loadBundle(ticker);
  }

  function sendHome(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const existing = threads.find((item) => item.companyId === "home" && !item.closed);
    const thread = existing || { id: `home-${rid()}`, companyId: "home", title: "Home", closed: false, updated: Date.now(), messages: [] as ChatMessage[] };
    if (!existing) setThreads((list) => [...list, thread]);
    setHomeDraft("");
    setBusy(true);
    setActiveThread(thread.id);
    window.analyst?.agent.ask(trimmed, "", thread.id);
  }

  function wantsPlan(text: string): boolean {
    return /^\/deep\b/i.test(text);
  }

  function launchTeam(source: NonNullable<typeof teamPlan>, onlyId = "") {
    if (!company) return;
    const parent = threads.find((item) => item.id === activeThread && item.companyId === company.id && !item.closed) || openThreads[0];
    const assignments = onlyId ? source.assignments.filter((job) => job.id === onlyId) : source.assignments;
    if (!assignments.length) return;
    const next = { ...source, parentThreadId: parent?.id || "", assignments };
    setTeamPlan(next);
    setThreads((list) => {
      const additions = assignments.filter((job) => !list.some((item) => item.id === job.threadId)).map((job) => ({
        id: job.threadId,
        companyId: company.id,
        title: job.title,
        closed: false,
        updated: Date.now(),
        messages: [] as ChatMessage[],
        parentId: source.teamId,
        status: "queued",
      }));
      return [...additions, ...list];
    });
    setPanel(true);
    setRightMode("agent");
    void window.analyst?.team.start(next);
  }

  async function send(text: string, force = false) {
    const trimmed = text.trim();
    if (!trimmed || busy || !company) return;
    const mention = trimmed.match(/@([A-Za-z.]{1,6})/);
    if (mention) setAttached((current) => `${current}\nMentioned ${mention[1].toUpperCase()}`.trim());
    if (/^\/compare\b/i.test(trimmed)) {
      send(`Compare ${company.name} with last year on the figures we have. ${trimmed.replace(/^\/compare\s*/i, "")}`, true);
      return;
    }
    if (/^\/explain\b/i.test(trimmed)) {
      send(`Explain this for ${company.name}: ${trimmed.replace(/^\/explain\s*/i, "")}`, true);
      return;
    }
    if (/^\/review\b/i.test(trimmed)) {
      send(`Review the notebook and reports for ${company.name}. ${trimmed.replace(/^\/review\s*/i, "")}`, true);
      return;
    }
    if (/^\/team\b/i.test(trimmed) || /\byou research\b/i.test(trimmed)) {
      const proposed = await window.analyst?.team.propose(trimmed, company.ticker) as { teamId: string; company: string; assignments: { id: string; title: string; question: string; sources: string; depth: string; status: string; threadId: string }[] } | undefined;
      if (proposed) setTeamPlan(proposed);
      setPanel(true);
      setRightMode("agent");
      return;
    }
    if (/^\/model\b/i.test(trimmed) || /build a model/i.test(trimmed)) {
      openModel();
      return;
    }
    if (/^\/save\b/i.test(trimmed)) {
      await window.analyst?.memory.remember(trimmed.replace(/^\/save\s*/i, ""), company.ticker);
      return;
    }
    let current = threads.find((item) => item.id === activeThread && item.companyId === company.id && !item.closed) || openThreads[0];
    if (!current) {
      current = makeThread(company);
      setThreads((list) => (list.some((item) => item.id === current.id) ? list : [...list, current]));
      setActiveThread(current.id);
    }
    const go = force || Boolean(plan && plan.threadId === current.id && trimmed === draft.trim());
    if (!go && wantsPlan(trimmed)) {
      setPlan({
        threadId: current.id,
        steps: [
          "Open the latest annual report and the recent quarterly reports",
          "Read the sections that answer the question",
          "Check each figure against the filing or a calculation",
          "Write the answer with the source named on each claim",
        ],
      });
      setDraft(trimmed);
      setRightMode("agent");
      setPanel(true);
      return;
    }
    const steps = go && plan?.threadId === current.id ? plan.steps.map((step) => step.trim()).filter(Boolean) : [];
    const asked = `${attached ? `Attached context:\n${attached}\n\n` : ""}${steps.length ? `${trimmed}\n\nFollow this plan:\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}` : trimmed}`;
    setPlan(null);
    setAttached("");
    setDraft("");
    setBusy(true);
    setRightMode("agent");
    setPanel(true);
    window.analyst?.agent.ask(asked, company.ticker, current.id);
  }

  async function keepSelection() {
    if (!pick?.text || !company) return;
    const rows = await window.analyst?.notebook.highlight({
      company: company.ticker,
      text: pick.text,
      context: pick.context,
      note: "",
      tag: "Evidence",
      url: pick.url,
      title: pick.title,
      anchor: pick.anchor,
      docId: pick.docId,
      by: "user",
    });
    if (rows) setNotes((current) => ({ ...current, [company.ticker]: rows }));
    const words = new Set(pick.text.toLowerCase().split(/\W+/).filter((word) => word.length > 5));
    const related = (rows || []).filter((entry) => entry.type === "highlight" && entry.text !== pick.text).find((entry) =>
      (entry.text || "").toLowerCase().split(/\W+/).some((word) => words.has(word)),
    );
    if (related) {
      const line = `This highlight connects to an earlier one in ${related.title}: “${(related.text || "").slice(0, 90)}”.`;
      setReaction(line);
      const threadId = activeThread;
      setThreads((list) => list.map((item) => item.id === threadId ? { ...item, messages: [...item.messages, { id: rid(), role: "assistant" as const, text: line }] } : item));
      setPanel(true);
      setRightMode("agent");
    }
    setPick(null);
  }

  async function toggleMic() {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
      return;
    }
    setVoiceError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setListening(false);
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        void blob.arrayBuffer().then((audio) => window.analyst?.voice.transcribe(audio)).then((text) => {
          if (text) setDraft((current) => (current.trim() ? `${current.trim()} ${text}` : text));
        }).catch((error: Error) => setVoiceError(error.message || "Transcription failed."));
      };
      recorderRef.current = recorder;
      setListening(true);
      recorder.start();
    } catch {
      setListening(false);
      setVoiceError("Microphone access was denied. Allow it in System Settings → Privacy & Security → Microphone.");
    }
  }

  function prefill(text: string) {
    setDraft(text);
    setPanel(true);
    setRightMode("agent");
    composerRef.current?.focus();
  }

  async function openLink(url: string, label: string) {
    if (!company || !url) return;
    setView((all) => ({ ...all, [company.id]: "research" }));
    const snap = await window.analyst?.tabs.openUrl(url, label);
    if (snap) setTabs(snap.tabs);
    setDocFocus("web");
  }

  async function jump(entry: Entry) {
    if (entry.url) {
      await openLink(entry.url, entry.title);
      return;
    }
    if (entry.docId) {
      if (company) setView((all) => ({ ...all, [company.id]: "research" }));
      await window.analyst?.docs.open(entry.docId, entry.anchor);
      setDocFocus("web");
    }
  }

  async function submitAddress(input: string) {
    const url = toAddress(input);
    if (!url) return;
    if (docFocus === "web" && active?.kind === "web") {
      const snap = await window.analyst?.tabs.navigate(active.id, input);
      if (snap) setTabs(snap.tabs);
      return;
    }
    const snap = await window.analyst?.tabs.openUrl(url);
    if (snap) setTabs(snap.tabs);
    setDocFocus("web");
  }

  function addAgent() {
    if (!company) return;
    const created = makeThread(company);
    setThreads((list) => [...list, created]);
    setActiveThread(created.id);
    setRightMode("agent");
  }

  function closeAgent(id: string) {
    const rest = openThreads.filter((item) => item.id !== id);
    setThreads((list) => list.map((item) => (item.id === id ? { ...item, closed: true } : item)));
    if (activeThread === id) setActiveThread(rest[0]?.id || "");
  }

  const facts = bundle?.facts;
  const revenue = facts?.facts?.revenue?.values?.[0];
  const priorRevenue = facts?.facts?.revenue?.values?.[1];
  const netIncome = facts?.facts?.["net income"]?.values?.[0];
  const growth = revenue && priorRevenue?.value ? ((revenue.value - priorRevenue.value) / Math.abs(priorRevenue.value)) * 100 : null;
  const factAt = (name: string) => facts?.facts?.[name]?.values?.[0];
  const ocf = factAt("operating cash flow");
  const capexPoint = factAt("capex");
  const diluted = factAt("diluted shares");
  const equity = factAt("equity");
  const premiums = factAt("net premiums earned");
  const losses = factAt("losses");
  const investment = factAt("investment income");
  const fcf = ocf && capexPoint ? ocf.value - Math.abs(capexPoint.value) : null;
  const fcfMargin = fcf != null && revenue?.value ? (fcf / Math.abs(revenue.value)) * 100 : null;
  const fcfShare = fcf != null && diluted?.value ? fcf / diluted.value : null;
  const lossRatio = premiums?.value && losses ? (losses.value / Math.abs(premiums.value)) * 100 : null;
  const bookValue = equity && diluted?.value ? equity.value / diluted.value : null;
  const cashYears = (facts?.facts?.["operating cash flow"]?.values || []).slice().reverse();
  const liveQuote = bundle?.quote || quote;
  const filings = (bundle?.filings || []).filter((filing) => filing.bucket !== "insider" || showInsiders);
  const latestFilings = (bundle?.filings || []).filter((filing) => filing.bucket !== "insider").slice(0, 5);
  const filingRows = filings.filter((filing) => {
    if (filingFilter === "other") return filing.bucket === "other" || filing.bucket === "insider";
    if (filingFilter !== "all" && filing.bucket !== filingFilter) return false;
    if (!showInsiders && filing.bucket === "insider") return false;
    const hay = `${filing.form} ${filing.description || ""} ${filing.label}`.toLowerCase();
    return !filingQuery || hay.includes(filingQuery.toLowerCase());
  });

  const stats = [
    { label: "Price", value: price(liveQuote?.price), asOf: liveQuote?.asOf, why: liveQuote?.error || "Yahoo didn't return a price." },
    { label: "1-year change", value: percent(liveQuote?.changePercent), asOf: liveQuote?.asOf, why: liveQuote?.error || "Yahoo didn't return a 1-year change.", tone: liveQuote?.changePercent },
    { label: "Market cap", value: money(liveQuote?.marketCap), asOf: liveQuote?.asOf, why: liveQuote?.error || "Market cap needs a price and a share count." },
    { label: "Trailing P/E", value: multiple(liveQuote?.trailingPE), asOf: liveQuote?.asOf || netIncome?.end, why: "Trailing P/E uses the price and the latest fiscal-year earnings, or Yahoo when it returns a multiple." },
    { label: "P/S", value: multiple(liveQuote?.priceToSales), asOf: revenue?.end, why: "Price to sales uses market cap and the latest fiscal-year revenue." },
    { label: "P/B", value: multiple(liveQuote?.priceToBook), asOf: equity?.end, why: "Price to book uses the price and book value per share." },
    { label: "FY revenue", value: money(revenue?.value), asOf: revenue?.end, why: facts?.error || "SEC company facts didn't include fiscal-year revenue." },
    { label: "FY net income", value: money(netIncome?.value), asOf: netIncome?.end, why: facts?.error || "SEC company facts didn't include fiscal-year net income." },
    { label: "Revenue growth", value: percent(growth), asOf: revenue?.end, why: facts?.error || (priorRevenue ? "Revenue growth couldn't be calculated." : "The prior fiscal year isn't in the SEC company facts."), tone: growth },
  ];

  const activity = Object.entries(notes).flatMap(([ticker, rows]) => rows.map((entry) => ({ ...entry, ticker }))).sort((a, b) => b.at - a.at).slice(0, 8);
  const tenKOpen = Boolean(active?.title && /10-K|20-F|40-F/i.test(active.title));
  const suggestions = [
    ...topics.slice(0, 4).map((topic) => ({ topic: topic.label, text: topic.q(company?.name || "this company") })),
    ...(tenKOpen ? [
      { topic: "This filing", text: "Summarize the risk factors in the open annual report." },
      { topic: "This filing", text: "What changed versus last year's annual report?" },
    ] : []),
  ];

  const visibleEntries = entries.filter((entry) => {
    if (asOf) {
      const cutoff = new Date(asOf);
      cutoff.setHours(23, 59, 59, 999);
      if (entry.at > cutoff.getTime()) return false;
    }
    if (logFilter !== "all" && entry.type !== logFilter) return false;
    const hay = `${entry.title} ${entry.text || ""} ${entry.note || ""} ${entry.tag || ""}`.toLowerCase();
    return !logQuery || hay.includes(logQuery.toLowerCase());
  });
  const days = [...new Set(entries.map((entry) => dayKey(entry.at)))].sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
  const grouped = new Map<string, Entry[]>();
  for (const entry of [...visibleEntries].sort((a, b) => a.at - b.at)) {
    const key = dayKey(entry.at);
    grouped.set(key, [...(grouped.get(key) || []), entry]);
  }
  const summary = company ? summaries[company.ticker] : undefined;
  const since = summary?.at ? entries.filter((entry) => entry.at > summary.at).length : 0;
  const highlights = entries.filter((entry) => entry.type === "highlight");
  const highlightTags = [...new Set(highlights.map((entry) => entry.tag).filter(Boolean))] as string[];
  const shownHighlights = highlights.filter((entry) => !tagFilter || entry.tag === tagFilter);
  const bySource = new Map<string, Entry[]>();
  for (const entry of shownHighlights) {
    const key = entry.title || entry.url || "Saved highlight";
    bySource.set(key, [...(bySource.get(key) || []), entry]);
  }
  const savedArticles = entries.filter((entry) => entry.url && !entry.url.includes("sec.gov") && (entry.type === "source" || entry.type === "page"));
  const pastes = entries.filter((entry) => entry.docId?.startsWith("paste") || (entry.type === "source" && entry.docId));
  const recentPages = entries.filter((entry) => entry.type === "page");
  const pins = entries.filter((entry) => entry.pinned || entry.type === "finding");

  function dragWidth(which: "sidebar" | "panel", event: { clientX: number; preventDefault: () => void }) {
    event.preventDefault();
    const startX = event.clientX;
    const start = which === "sidebar" ? sidebarWidth : panelWidth;
    const move = (ev: MouseEvent) => {
      const next = nextWidth(which, start, ev.clientX - startX);
      if (which === "sidebar") setSidebarWidth(next);
      else setPanelWidth(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const paletteRows = [
    ...companies.filter((item) => !query || `${item.name} ${item.ticker}`.toLowerCase().includes(query.toLowerCase())).map((item) => ({ label: item.name, run: () => openCompany(item.id) })),
    ...(query.trim() ? [{ label: `Ask the agent: ${query.trim()}`, run: () => { setPanel(true); if (company) send(query.trim(), true); else sendHome(query.trim()); } }] : []),
    ...(bundle?.filings || []).filter((filing) => query && `${filing.form} ${filing.description || ""}`.toLowerCase().includes(query.toLowerCase())).slice(0, 6).map((filing) => ({
      label: `${company?.ticker || ""} ${filing.form} ${prettyDate(filing.filingDate || filing.reportDate)}`,
      run: () => { if (company) void openLink(filing.url, `${company.ticker} ${filing.form}`); },
    })),
  ];

  return (
    <div className="grid h-full min-h-0 min-w-0 bg-canvas text-ink" style={{ gridTemplateColumns: [sidebar ? `${sidebarWidth}px` : "", "minmax(0,1fr)", panel ? `${panelWidth}px` : ""].filter(Boolean).join(" ") }}>
      {sidebar && (
        <aside className="relative flex min-h-0 flex-col border-r border-line bg-sidebar">
          <div className="flex items-center justify-between px-3 pt-3">
            <img src={logoUrl} alt="Prometheus" className="h-7 w-auto" />
            <Button variant="ghost" size="icon" title="Hide sidebar" onClick={() => setSidebar(false)}><PanelLeft className="size-4" /></Button>
          </div>
          <nav className="flex min-h-0 flex-1 flex-col gap-1 px-2 py-2">
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
            <button type="button" className={cn("flex items-center gap-2 rounded-[8px] px-2 py-2 text-left transition-colors duration-150 hover:bg-black/5 dark:hover:bg-white/8", screen === "home" && "bg-card text-accent")} onClick={() => { setScreen("home"); setPanel(true); }}>
              <Home className="size-4" /> Home
            </button>
            <button type="button" className={cn("flex items-center gap-2 rounded-[8px] px-2 py-2 text-left transition-colors duration-150 hover:bg-black/5 dark:hover:bg-white/8", screen === "feed" && "bg-card text-accent")} onClick={() => setScreen("feed")}>Feed</button>
            <button type="button" className={cn("flex items-center gap-2 rounded-[8px] px-2 py-2 text-left transition-colors duration-150 hover:bg-black/5 dark:hover:bg-white/8", screen === "how" && "bg-card text-accent")} onClick={() => setScreen("how")}>How I work</button>
            <p className="mt-4 px-2 text-[11px] font-medium uppercase tracking-wide text-muted">Companies</p>
            {visibleCompanies.map((item) => {
              const row = quotes[item.ticker];
              const up = (row?.changePercent || 0) >= 0;
              return (
                <div key={item.id} className="group relative" onContextMenu={(event) => { event.preventDefault(); setCompanyMenu({ id: item.id, x: event.clientX, y: event.clientY }); }}>
                  <button type="button" className={cn("w-full rounded-[8px] px-2 py-2 text-left transition-colors duration-150 hover:bg-black/5 dark:hover:bg-white/8", screen === item.id && "bg-card")} onClick={() => openCompany(item.id)}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{item.name}</span>
                      <Spark values={row?.closes} up={up} />
                    </span>
                    <span className="text-[12px] text-muted">
                      {row ? price(row.price) : "—"} · <span className={up ? "text-gain" : "text-loss"}>{row ? percent(row.changePercent) : "—"}</span>
                    </span>
                  </button>
                  <button type="button" aria-label={`Remove ${item.name}`} className="absolute right-1 top-1 hidden rounded-full p-1 text-muted hover:text-ink group-hover:block" onClick={() => setCompanyMenu({ id: item.id, x: 180, y: 120 })}><X className="size-3" /></button>
                </div>
              );
            })}
            </div>
            <div className="mt-1 px-1">
              <CompanySearch placeholder="Search company" onPick={(hit) => startProject({ ticker: hit.ticker, name: hit.title })} />
            </div>
            {addError && <p className="px-2 text-[12px] text-loss">{addError}</p>}
          </nav>
          <button type="button" className={cn("m-2 flex items-center gap-2 rounded-[8px] px-2 py-2 text-left transition-colors duration-150 hover:bg-black/5 dark:hover:bg-white/8", screen === "settings" && "bg-card")} onClick={() => { setScreen("settings"); setPanel(false); }}>
            <Settings className="size-4" /> Settings
          </button>
          <button type="button" aria-label="Resize sidebar" className="absolute bottom-0 right-0 top-0 w-1 cursor-col-resize hover:bg-accent" onMouseDown={(event) => dragWidth("sidebar", event)} />
        </aside>
      )}

      <main className="flex min-h-0 min-w-0 flex-col">
        <header className="flex h-12 items-center gap-2 border-b border-line px-2">
          {!sidebar && <Button variant="ghost" size="icon" title="Show sidebar" onClick={() => setSidebar(true)}><PanelLeft className="size-4" /></Button>}
          {screen === "home" && <h1 className="px-2 text-sm font-semibold">Home</h1>}
          {screen === "feed" && <h1 className="px-2 text-sm font-semibold">Feed</h1>}
          {screen === "how" && <h1 className="px-2 text-sm font-semibold">How I work</h1>}
          {screen === "settings" && <h1 className="px-2 text-sm font-semibold">Settings</h1>}
          {company && (
            <>
              <div className="min-w-0 px-1">
                <div className="truncate text-sm font-semibold">{company.name}</div>
                <div className="text-[12px] text-muted">{price(quote?.price)} · <span className={(quote?.changePercent || 0) >= 0 ? "text-gain" : "text-loss"}>{percent(quote?.changePercent)}</span></div>
              </div>
              <div className="mx-auto flex rounded-[8px] border border-line bg-sidebar p-0.5">
                {([["overview", "Overview"], ["research", "Research"], ["notebook", "Notebook"], ["archive", "Archive"]] as [View, string][]).map(([item, label]) => (
                  <button key={item} type="button" className={cn("rounded-[6px] px-3 py-1 text-[13px] transition-colors duration-150", currentView === item ? "bg-card text-ink" : "text-muted hover:text-ink")} onClick={() => setView((all) => ({ ...all, [company.id]: item }))}>{label}</button>
                ))}
              </div>
            </>
          )}
          <div className="ml-auto">
            <Button variant="ghost" size="icon" title={panel ? "Hide agent" : "Show agent"} onClick={() => setPanel((value) => !value)}><PanelRight className="size-4" /></Button>
          </div>
        </header>

        {screen === "home" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-col gap-3 border-b border-line py-4">
              <Belt rows={headlines.slice(0, 6)} onPick={(row) => startProject(row)} />
              <Belt rows={headlines.slice(6)} reverse onPick={(row) => startProject(row)} />
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
            <div className="mx-auto grid w-full max-w-6xl items-start gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-lg font-medium">Companies</h2>
                  <Button size="sm" onClick={() => setAdding((value) => !value)}>Add company</Button>
                </div>
                {adding && <div className="mb-3 max-w-md"><CompanySearch placeholder="Search ticker or company" onPick={(hit) => { setAdding(false); startProject({ ticker: hit.ticker, name: hit.title }); }} /></div>}
                {addError && <p className="mb-2 text-[13px] text-loss">{addError}</p>}
                <div className="grid grid-cols-2 gap-3">
                  {visibleCompanies.map((item) => {
                    const row = quotes[item.ticker];
                    const log = notes[item.ticker] || [];
                    const done = topics.filter((topic) => covered(topic.id, log)).length;
                    const last = log.reduce((max, entry) => Math.max(max, entry.at), 0);
                    const up = (row?.changePercent || 0) >= 0;
                    return (
                      <div key={item.id} className="group relative text-left" onContextMenu={(event) => { event.preventDefault(); setCompanyMenu({ id: item.id, x: event.clientX, y: event.clientY }); }}>
                        <button type="button" className="w-full text-left" onClick={() => openCompany(item.id)}>
                          <Card className="shadow-card transition-colors duration-150 hover:border-accent">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="font-medium">{item.name}</div>
                                <div className="text-[12px] text-muted">{item.ticker}</div>
                              </div>
                              <Spark values={row?.closes} up={up} />
                            </div>
                            <div className="num mt-3 text-sm">{row ? price(row.price) : <Skeleton className="h-5 w-16" />} <span className={up ? "text-gain" : "text-loss"}>{row ? percent(row.changePercent) : ""}</span></div>
                            <div className="mt-2 text-[12px] text-muted">{last ? `Last researched ${dayKey(last)}` : "Not researched yet"} · {done}/8 topics</div>
                          </Card>
                        </button>
                        <button type="button" aria-label={`Remove ${item.name}`} className="absolute right-2 top-2 hidden rounded-full bg-card p-1 text-muted group-hover:block" onClick={() => setCompanyMenu({ id: item.id, x: 240, y: 160 })}><X className="size-3" /></button>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="flex flex-col gap-3">
                <Card className="shadow-card">
                  <h3 className="text-sm font-medium">Feed</h3>
                  {feedPreview.length === 0 ? <p className="mt-2 text-[12px] leading-5 text-muted">The top of the feed shows up here after the cache has rankings.</p> : (
                    <ul className="mt-2 flex flex-col gap-1">{feedPreview.map((row) => <li key={row.ticker} className="text-[12px]">{row.ticker} · {row.reasons[0] || "Worth a look"}</li>)}</ul>
                  )}
                  <Button className="mt-3" size="sm" variant="outline" onClick={() => setScreen("feed")}>Open Feed</Button>
                </Card>
                <Card className="shadow-card">
                  <h3 className="text-sm font-medium">Recent activity</h3>
                  {activity.length === 0 ? (
                    <p className="mt-2 text-[12px] leading-5 text-muted">Questions, opened filings, and highlights will show up here.</p>
                  ) : (
                    <ul className="mt-2 flex flex-col gap-2">
                      {activity.slice(0, 6).map((entry) => (
                        <li key={entry.id} className="text-[12px] leading-4"><span className="text-muted">{entry.ticker}</span> · {entry.title}</li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </div>
            </div>
          </div>
        )}
        {screen === "feed" && <FeedView onOpen={(ticker) => startProject({ ticker, name: ticker })} onAsk={(ticker) => { startProject({ ticker, name: ticker }); setPanel(true); prefill(`What stands out in ${ticker}?`); }} />}
        {screen === "how" && <HowIWork />}

        {screen === "settings" && (
          <div className="mx-auto w-full max-w-lg px-6 py-8">
            <Card>
              <h2 className="text-sm font-medium">Appearance</h2>
              <div className="mt-3 flex gap-2">
                {(["system", "light", "dark"] as Theme[]).map((item) => (
                  <Chip key={item} active={theme === item} onClick={() => { void window.analyst?.confirm(`Change the theme to ${item}?`).then((ok) => { if (ok) setTheme(item); }); }}>{item}</Chip>
                ))}
              </div>
              <Button className="mt-4" variant="outline" size="sm" onClick={() => void window.analyst?.openTestPage()}>Open security test page</Button>
            </Card>
          </div>
        )}

        {company && showModel && (
          <ModelView assumptions={assumptions} inputs={modelInputs} year={new Date().getFullYear()} onAssumption={(row) => { setAssumptions((rows) => rows.map((item) => item.id === row.id ? row : item)); void window.analyst?.notebook.note(company.ticker, `${row.name} set to ${row.value} ${row.unit}`); }} onInputs={(next) => { setModelInputs(next); void window.analyst?.notebook.note(company.ticker, "Model inputs changed."); }} />
        )}
        {company && !showModel && activeReport && reports.find((item) => item.id === activeReport) && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-1 border-b border-line px-2 py-2">
              {reports.filter((item) => item.company === company.ticker).map((item) => (
                <button key={item.id} type="button" className={cn("rounded-[10px] px-2 py-1 text-[12px]", item.id === activeReport ? "bg-accent text-[#1c1408]" : "text-muted")} onClick={() => setActiveReport(item.id)}>{item.title}</button>
              ))}
              <button type="button" className="ml-auto text-[12px] text-muted" onClick={() => setActiveReport("")}>Close</button>
            </div>
          <ReportView
            report={reports.find((item) => item.id === activeReport) as ReportDoc}
            onChange={(report) => { setReports((list) => list.map((item) => item.id === report.id ? report : item)); void window.analyst?.reports.save(report); }}
            onOpen={(url, label) => void openLink(url, label)}
            onDiscuss={() => { setPanel(true); prefill(`Let's discuss ${reports.find((item) => item.id === activeReport)?.title || "this report"}. `); }}
            onPin={() => { const report = reports.find((item) => item.id === activeReport); if (report) void window.analyst?.notebook.finding(company.ticker, report.bottomLine); }}
          />
          </div>
        )}
        {company && !showModel && !activeReport && currentView === "overview" && (
          <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-3 overflow-auto px-6 py-4">
            <div className="col-span-2 grid grid-cols-3 gap-3">
              {stats.map((stat) => (
                <Card key={stat.label} className="p-3">
                  <div className="text-[12px] text-muted">{stat.label}</div>
                  {loading[company.ticker] && !bundle ? <Skeleton className="mt-2 h-7 w-24" /> : (
                    <div className={cn("mt-1 text-lg font-medium", stat.value === "—" ? "" : stat.tone != null && stat.tone >= 0 ? "text-gain" : stat.tone != null ? "text-loss" : "")} title={stat.value === "—" ? stat.why : undefined}>{stat.value}</div>
                  )}
                  {stat.asOf && stat.value !== "—" && <div className="mt-1 text-[11px] text-muted">as of {prettyDate(stat.asOf)}</div>}
                  {stat.value === "—" && !loading[company.ticker] && <button type="button" className="mt-1 text-[12px] text-accent" onClick={() => void loadBundle(company.ticker)}>Retry</button>}
                </Card>
              ))}
            </div>
            <Card className="col-span-2 shadow-card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">{company.name}</h3>
                  <p className="num text-lg">{price(quote?.price)} <span className={(quote?.changePercent || 0) >= 0 ? "text-gain" : "text-loss"}>{percent(quote?.changePercent)}</span></p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {ranges.map(([id, label]) => (
                    <Chip key={id} active={chartRange === id} onClick={() => setChartRange(id)}>{label}</Chip>
                  ))}
                </div>
              </div>
              {(() => {
                const series = seriesMap[`${company.ticker}:${chartRange}`];
                if (!series) return <Skeleton className="mt-3 h-44 w-full" />;
                if (series.points.length > 1) return <PriceChart points={series.points} range={chartRange} />;
                return <p className="mt-2 text-[13px] text-muted" title={series.error || "Yahoo didn't return a price history."}>— <button type="button" className="text-accent" onClick={() => { setSeriesMap((current) => { const next = { ...current }; delete next[`${company.ticker}:${chartRange}`]; return next; }); }}>Retry</button></p>;
              })()}
              {seriesMap[`${company.ticker}:${chartRange}`]?.asOf && <p className="mt-1 text-[11px] text-muted">as of {prettyDate(seriesMap[`${company.ticker}:${chartRange}`].asOf)}</p>}
            </Card>
            <Card>
              <h3 className="text-sm font-medium">Cash flow</h3>
              <p className="mt-1 text-[12px] text-muted">SEC company facts · {ocf?.end ? prettyDate(ocf.end) : "latest fiscal year"}</p>
              <div className="mt-3 grid grid-cols-3 gap-3">
                {[
                  ["Operating cash flow", money(ocf?.value), "SEC company facts didn't include operating cash flow."],
                  ["Capex", money(capexPoint ? -Math.abs(capexPoint.value) : null), "SEC company facts didn't include purchases of property and equipment."],
                  ["Free cash flow", money(fcf), "Free cash flow needs operating cash flow and capex."],
                  ["FCF margin", percent(fcfMargin), "FCF margin needs free cash flow and revenue."],
                  ["FCF per share", fcfShare == null ? "—" : price(fcfShare), "FCF per share needs free cash flow and diluted shares."],
                  ["Period", ocf?.end ? prettyDate(ocf.end) : "—", "The fiscal period wasn't in the company facts."],
                ].map(([label, value, why]) => (
                  <div key={label}>
                    <div className="text-[12px] text-muted">{label}</div>
                    <div className="mt-1 text-sm font-medium" title={value === "—" ? why : undefined}>{value}</div>
                    {value === "—" && !loading[company.ticker] && <button type="button" className="mt-1 text-[12px] text-accent" onClick={() => void loadBundle(company.ticker)}>Retry</button>}
                  </div>
                ))}
              </div>
              {cashYears.length > 1 && <div className="mt-3"><Spark values={cashYears.map((point) => point.value)} up={(cashYears.at(-1)?.value || 0) >= (cashYears[0]?.value || 0)} /></div>}
            </Card>
            <Card className="shadow-card">
              <h3 className="text-sm font-medium">Shares outstanding</h3>
              {(() => {
                const series = (bundle?.facts?.facts?.["shares outstanding"]?.values || bundle?.facts?.facts?.["diluted shares"]?.values || []).slice().reverse();
                const latest = series.at(-1);
                const first = series[0];
                const change = first?.value && latest ? ((latest.value - first.value) / Math.abs(first.value)) * 100 : null;
                return <>
                  <div className="num mt-2 text-lg">{latest ? latest.value.toLocaleString() : "—"}</div>
                  <p className="mt-1 text-[12px] text-muted">{latest ? `as of ${prettyDate(latest.end)}` : "—"}{change != null ? ` · ${percent(change)} since ${prettyDate(first.end)}` : ""}</p>
                  {series.length > 1 && <div className="mt-3"><Spark values={series.map((point) => point.value)} up={(change || 0) >= 0} width={220} /></div>}
                  {!latest && !loading[company.ticker] && <button type="button" className="mt-1 text-[12px] text-accent" onClick={() => void loadBundle(company.ticker)}>Retry</button>}
                </>;
              })()}
            </Card>
            <Card>
              <h3 className="text-sm font-medium">{bundle?.profile?.industry === "pc" ? "Property and casualty" : "Industry"}</h3>
              {bundle?.profile?.industry === "pc" ? (
                <div className="mt-3 grid grid-cols-3 gap-3">
                  {[
                    ["Net premiums earned", money(premiums?.value)],
                    ["Losses", money(losses?.value)],
                    ["Loss ratio", percent(lossRatio)],
                    ["Expense ratio", "—"],
                    ["Combined ratio", "—"],
                    ["Investment income", money(investment?.value)],
                    ["Book value per share", bookValue == null ? "—" : price(bookValue)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <div className="text-[12px] text-muted">{label}</div>
                      <div className="mt-1 text-sm font-medium" title={value === "—" ? "This figure isn't in the SEC company facts." : undefined}>{value}</div>
                      {value === "—" && !loading[company.ticker] && <button type="button" className="mt-1 text-[12px] text-accent" onClick={() => void loadBundle(company.ticker)}>Retry</button>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3">
                  <div className="text-sm">{industryName()}</div>
                  {!bundle?.profile?.sicDescription && !loading[company.ticker] && <button type="button" className="mt-1 text-[12px] text-accent" onClick={() => void loadBundle(company.ticker)}>Retry</button>}
                </div>
              )}
            </Card>
            <div className="flex flex-wrap gap-2">
              {[
                ["Pull latest filings", `Pull ${company.name}'s latest 10-K and the last three 10-Qs.`],
                ["Find news", `Find recent news on ${company.name} and say what kind each source is.`],
                ["Bull vs bear sources", `Find sources that illustrate the bull and bear sides of sentiment on ${company.name}.`],
                ["Compare to peers", `How does ${company.name} compare with its peers on valuation?`],
                ["Explain a term", `What are current liabilities, and what do they mean for ${company.name}?`],
              ].map(([label, prompt]) => (
                <Button key={label} variant="outline" size="sm" onClick={() => send(prompt)}>{label}</Button>
              ))}
            </div>
            <Card>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">Quick overview</h3>
                <Button variant="outline" size="sm" onClick={() => { setSnaps((current) => ({ ...current, [company.ticker]: { text: "", at: 0 } })); window.analyst?.agent.overview(company.ticker); }}>{snaps[company.ticker]?.text ? "Refresh" : "Generate"}</Button>
              </div>
              {snaps[company.ticker]?.text ? <p className="mt-3 max-w-[68ch] whitespace-pre-wrap text-[14px] leading-6">{snaps[company.ticker].text}</p> : <p className="mt-3 max-w-[68ch] text-[13px] leading-5 text-muted">A short snapshot from the quote, latest annual report, financials, news, and peers. Generated when you ask, then kept until you refresh it.</p>}
              {snaps[company.ticker]?.at ? <p className="mt-2 text-[11px] text-muted">as of {new Date(snaps[company.ticker].at).toLocaleString()}</p> : null}
            </Card>
            <Card>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Latest filings</h3>
                <button type="button" className="text-[13px] text-accent" onClick={() => { setView((all) => ({ ...all, [company.id]: "research" })); setDocFocus("library"); }}>View all</button>
              </div>
              {loading[company.ticker] && !bundle ? <Skeleton className="mt-3 h-24 w-full" /> : latestFilings.length === 0 ? <p className="mt-2 text-[13px] text-muted" title={bundle?.filingsError || "No filings were returned."}>— <button type="button" className="text-accent" onClick={() => void loadBundle(company.ticker)}>Retry</button></p> : (
                <FilingList rows={latestFilings} onOpen={(filing) => void openLink(filing.url, `${company.ticker} ${filing.form}`)} />
              )}
            </Card>
            <Card>
              <h3 className="text-sm font-medium">Recent news and sources</h3>
              {bundle?.newsError && !bundle.news.length ? <p className="mt-2 text-[13px] text-muted" title={bundle.newsError}>— <button type="button" className="text-accent" onClick={() => void loadBundle(company.ticker)}>Retry</button></p> : (
                <ul className="mt-3 flex flex-col gap-3">
                  {(bundle?.news || []).slice(0, 5).map((hit) => (
                    <li key={hit.url}>
                      <button type="button" className="text-left text-sm font-medium hover:text-accent" onClick={() => void openLink(hit.url, hit.title)}>{hit.title}</button>
                      <div className="mt-1"><Chip>{hit.kind}</Chip></div>
                      <p className="mt-1 max-w-[68ch] text-[13px] leading-5 text-muted">{hit.snippet}</p>
                    </li>
                  ))}
                  {!bundle?.news?.length && !loading[company.ticker] && <li className="text-[13px] text-muted">—</li>}
                </ul>
              )}
            </Card>
            <Card>
              <h3 className="text-sm font-medium">Peers</h3>
              {bundle?.peers?.error && !bundle.peers.rows?.length ? <p className="mt-2 text-[13px] text-muted" title={bundle.peers.error}>— <button type="button" className="text-accent" onClick={() => void loadBundle(company.ticker)}>Retry</button></p> : (
                <table className="mt-3 w-full text-left text-[13px]">
                  <thead className="text-muted"><tr><th className="py-1 font-medium">Ticker</th><th>Price</th><th>1Y</th><th>Market cap</th><th>Trailing P/E</th><th>Forward P/E</th><th>P/B</th></tr></thead>
                  <tbody>
                    {(bundle?.peers?.rows || []).map((row) => (
                      <tr key={row.ticker} className="border-t border-line">
                        <td className="py-1.5">{row.ticker}</td>
                        <td>{price(row.price)}</td>
                        <td className={row.changePercent == null ? "" : row.changePercent >= 0 ? "text-gain" : "text-loss"}>{percent(row.changePercent)}</td>
                        <td title={row.marketCap == null ? row.error || "Yahoo didn't return a market cap." : undefined}>{money(row.marketCap)}</td>
                        <td>{multiple(row.trailingPE)}</td>
                        <td>{multiple(row.forwardPE)}</td>
                        <td>{multiple(row.priceToBook)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card>
              <h3 className="text-sm font-medium">Research coverage</h3>
              <p className="mt-1 text-[12px] text-muted">What the log and highlights have touched. This is a checklist, not a view on the company.</p>
              <ul className="mt-3 grid grid-cols-2 gap-2">
                {topics.map((topic) => {
                  const done = covered(topic.id, entries);
                  return (
                    <li key={topic.id}>
                      <button type="button" className="flex w-full items-center justify-between rounded-[8px] border border-line px-3 py-2 text-left text-[13px] transition-colors duration-150 hover:border-accent" onClick={() => { if (!done) prefill(topic.q(company.name)); }}>
                        <span>{topic.label}</span>
                        <span className={done ? "text-gain" : "text-muted"}>{done ? "Covered" : "Not yet"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>
        )}

        {company && !showModel && !activeReport && currentView === "research" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-line px-2 py-2">
              <Button variant="ghost" size="icon" title="Back" disabled={docFocus !== "web"} onClick={() => void window.analyst?.tabs.back()}><ArrowLeft className="size-4" /></Button>
              <Button variant="ghost" size="icon" title="Forward" disabled={docFocus !== "web"} onClick={() => void window.analyst?.tabs.forward()}><ArrowRight className="size-4" /></Button>
              <Button variant="ghost" size="icon" title="Reload" disabled={docFocus !== "web"} onClick={() => void window.analyst?.tabs.reload()}><RotateCw className="size-4" /></Button>
              <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); void submitAddress(address); }}>
                <input ref={addressRef} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Search or enter a URL" className="h-8 w-full rounded-[8px] border border-line bg-card px-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-accent" />
              </form>
            </div>
            <div ref={stripRef} className="flex items-end gap-1 overflow-x-auto border-b border-line px-2 pt-2">
              <Tab pinned active={docFocus === "library"} onSelect={() => setDocFocus("library")}>Library</Tab>
              {tabs.map((tab) => (
                <Tab key={tab.id} active={docFocus === "web" && tab.active} onSelect={() => { setDocFocus("web"); void window.analyst?.tabs.activate(tab.id); }} onClose={() => void window.analyst?.tabs.close(tab.id)}>{tab.title || "New tab"}</Tab>
              ))}
              <Button variant="ghost" size="icon" title="New tab" onClick={() => { void window.analyst?.tabs.newTab(); setDocFocus("web"); }}><Plus className="size-4" /></Button>
            </div>
            {pick?.text && docFocus === "web" && (
              <div className="flex items-center gap-2 border-b border-line bg-card px-3 py-2">
                <p className="min-w-0 flex-1 truncate text-[13px] text-muted">“{pick.text.slice(0, 160)}”</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void keepSelection()}>Highlight</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => { setAttached(pick.text); prefill(`About this passage:\n“${pick.text}”\n\n`); setPick(null); setPanel(true); }}>Send to agent</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => { prefill(`About this passage:\n“${pick.text}”\n\n`); setPick(null); }}>Ask</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => { const question = `Explain this passage from ${pick.title}: “${pick.text.slice(0, 700)}”`; setPick(null); send(question, true); }}>Explain</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => { send(`Compare this passage with the same discussion last year:\n“${pick.text.slice(0, 700)}”`, true); setPick(null); }}>Compare to last year</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setPick(null)}>Dismiss</Button>
              </div>
            )}
            {docFocus === "library" ? (
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 py-4">
                <Card>
                  <h3 className="text-sm font-medium">Filings</h3>
                  <input value={filingQuery} onChange={(event) => setFilingQuery(event.target.value)} placeholder="Search filings" className="mt-3 h-8 w-full max-w-sm rounded-[8px] border border-line bg-canvas px-2 text-sm outline-none" />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {filters.map((filter) => <Chip key={filter.id} active={filingFilter === filter.id} onClick={() => setFilingFilter(filter.id)}>{filter.label}</Chip>)}
                    <Chip active={showInsiders} onClick={() => setShowInsiders((value) => !value)}>Insider forms</Chip>
                  </div>
                  {loading[company.ticker] && !bundle ? <Skeleton className="mt-3 h-28 w-full" /> : <FilingList rows={filingRows} onOpen={(filing) => void openLink(filing.url, `${company.ticker} ${filing.form}`)} />}
                  {!filingRows.length && !loading[company.ticker] && <p className="mt-3 text-[13px] text-muted">No filings in this filter.</p>}
                </Card>
                <Card>
                  <h3 className="text-sm font-medium">Reports</h3>
                  {reports.filter((item) => item.company === company.ticker).length === 0 ? <p className="mt-2 text-[13px] text-muted">Team reports open here when a research run finishes.</p> : (
                    <ul className="mt-2 flex flex-col gap-1">{reports.filter((item) => item.company === company.ticker).map((item) => <li key={item.id}><button type="button" draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", item.bottomLine)} className="text-left text-[13px] hover:text-accent" onClick={() => setActiveReport(item.id)}>{item.title}</button></li>)}</ul>
                  )}
                </Card>
                <Card>
                  <h3 className="text-sm font-medium">Saved articles</h3>
                  {savedArticles.length === 0 ? <p className="mt-2 text-[13px] text-muted">Pages you open from news and search land in Recent pages. Sources the agent saves show up here.</p> : (
                    <ul className="mt-2 flex flex-col gap-1">{savedArticles.map((entry) => <li key={entry.id}><button type="button" className="text-left text-[13px] hover:text-accent" onClick={() => void jump(entry)}>{entry.title}</button></li>)}</ul>
                  )}
                </Card>
                <Card>
                  <h3 className="text-sm font-medium">Pasted text</h3>
                  <p className="mt-1 text-[13px] text-muted">Transcripts and other text you paste open in a reader tab.</p>
                  <input value={pasteTitle} onChange={(event) => setPasteTitle(event.target.value)} placeholder="Title" className="mt-3 h-8 w-full max-w-sm rounded-[8px] border border-line bg-canvas px-2 text-sm outline-none" />
                  <textarea value={pasteBody} onChange={(event) => setPasteBody(event.target.value)} placeholder="Paste a transcript or notes" className="mt-2 h-24 w-full max-w-xl rounded-[8px] border border-line bg-canvas p-2 text-sm outline-none" />
                  <Button className="mt-2" variant="outline" size="sm" onClick={() => { if (!pasteBody.trim()) return; void window.analyst?.notebook.paste(company.ticker, pasteTitle || "Pasted text", pasteBody); setPasteBody(""); setPasteTitle(""); setDocFocus("web"); }}>Open as reader</Button>
                  {pastes.length > 0 && <ul className="mt-3 flex flex-col gap-1">{pastes.map((entry) => <li key={entry.id}><button type="button" className="text-[13px] hover:text-accent" onClick={() => void jump(entry)}>{entry.title}</button></li>)}</ul>}
                </Card>
                <Card>
                  <h3 className="text-sm font-medium">Recent pages</h3>
                  {recentPages.length === 0 ? <p className="mt-2 text-[13px] text-muted">Pages you open in Research are listed here.</p> : (
                    <ul className="mt-2 flex flex-col gap-1">{recentPages.slice(-8).reverse().map((entry) => <li key={entry.id}><button type="button" className="text-left text-[13px] hover:text-accent" onClick={() => void jump(entry)}>{entry.title}</button></li>)}</ul>
                  )}
                </Card>
              </div>
            ) : active?.kind === "reader" && active.docId ? <ReaderView docId={active.docId} /> : <div ref={stageRef} className="min-h-0 flex-1" />}
          </div>
        )}

        {company && !showModel && !activeReport && currentView === "notebook" && (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-[8px] border border-line bg-sidebar p-0.5">
                {(["timeline", "summary"] as const).map((item) => (
                  <button key={item} type="button" className={cn("rounded-[6px] px-3 py-1 text-[13px] capitalize transition-colors duration-150", notebookMode === item ? "bg-card" : "text-muted")} onClick={() => setNotebookMode(item)}>{item}</button>
                ))}
              </div>
              <span className="text-[12px] text-muted">{entries.length} items in the log</span>
              <label className="ml-auto flex items-center gap-2 text-[12px] text-muted">
                View as of
                <select value={asOf} onChange={(event) => setAsOf(event.target.value)} className="h-8 rounded-[8px] border border-line bg-card px-2 text-ink">
                  <option value="">Now</option>
                  {days.map((day) => <option key={day} value={day}>{day}</option>)}
                </select>
              </label>
            </div>
            {notebookMode === "timeline" ? (
              <>
                <div className="flex flex-wrap gap-2">
                  {["all", "question", "page", "highlight", "finding", "note", "source"].map((item) => (
                    <Chip key={item} active={logFilter === item} onClick={() => setLogFilter(item)}>{item}</Chip>
                  ))}
                </div>
                <input value={logQuery} onChange={(event) => setLogQuery(event.target.value)} placeholder="Search the log" className="h-8 max-w-sm rounded-[8px] border border-line bg-card px-2 text-sm outline-none" />
                {visibleEntries.length === 0 ? (
                  <EmptyState title="Nothing in the timeline yet" body="Ask the agent a question, open a filing, or save a highlight. Each one is recorded here." action="Ask a question" onAction={() => prefill(topics[0].q(company.name))} />
                ) : (
                  [...grouped.entries()].reverse().map(([day, rows]) => (
                    <div key={day}>
                      <h3 className="text-[12px] font-medium text-muted">{day}</h3>
                      <ul className="mt-2 flex flex-col gap-2">
                        {rows.map((entry) => (
                          <li key={entry.id} className="flex items-stretch gap-2">
                            <button type="button" className="flex min-w-0 flex-1 gap-3 rounded-[8px] border border-line bg-card px-3 py-2 text-left transition-colors duration-150 hover:border-accent" onClick={() => void jump(entry)}>
                              <LogIcon type={entry.type} />
                              <span className="min-w-0">
                                <span className="block text-sm">{entry.title}</span>
                                {entry.type === "highlight" && <span className="mt-1 block max-w-[68ch] text-[13px] leading-5 text-muted">“{entry.text}” {entry.by === "agent" ? "· added by agent" : entry.tag ? `· ${entry.tag}` : ""} {entry.note && entry.by !== "agent" ? `· ${entry.note}` : ""}</span>}
                                {entry.type !== "highlight" && entry.text && <span className="mt-1 block max-w-[68ch] text-[13px] leading-5 text-muted">{entry.text}</span>}
                              </span>
                            </button>
                            <Button type="button" variant="outline" size="sm" onClick={() => { void window.analyst?.notebook.pin(entry.id, company.ticker).then((next) => setNotes((current) => ({ ...current, [company.ticker]: next }))); }}>{entry.pinned ? "Unpin" : "Pin"}</Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
                <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (!noteDraft.trim()) return; void window.analyst?.notebook.note(company.ticker, noteDraft.trim()).then((rows) => setNotes((current) => ({ ...current, [company.ticker]: rows }))); setNoteDraft(""); }}>
                  <input value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="Add a note" className="h-8 flex-1 rounded-[8px] border border-line bg-card px-2 text-sm outline-none" />
                  <Button type="submit" variant="outline">Add note</Button>
                </form>
              </>
            ) : (
              <Card>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium">Summary</h3>
                  <Button variant="outline" size="sm" disabled={summaryBusy} onClick={() => { setSummaries((current) => ({ ...current, [company.ticker]: { text: "", at: 0 } })); setSummaryBusy(true); window.analyst?.agent.summary(company.ticker); }}>Regenerate</Button>
                </div>
                {asOf && <p className="mt-2 text-[12px] text-muted">Summary as of an earlier time is incomplete. The timeline is filtered. Regenerate writes from the full log.</p>}
                <div className="mt-4 flex flex-col gap-4">
                  {summaryThemes.map((theme) => {
                    const rows = entries.filter((entry) => (entry.text || entry.title) && themeFor(entry) === theme);
                    return (
                      <div key={theme}>
                        <h4 className="text-[12px] font-medium text-muted">{theme}</h4>
                        {rows.length === 0 ? <p className="mt-1 text-[13px] text-muted">—</p> : (
                          <ul className="mt-1 flex flex-col gap-1">
                            {rows.slice(-6).map((entry) => (
                              <li key={entry.id} className="flex items-start gap-2">
                                <button type="button" className="min-w-0 flex-1 py-0.5 text-left text-[14px] leading-6 hover:text-accent" onClick={() => void jump(entry)}>{entry.type === "highlight" ? `“${(entry.text || "").slice(0, 180)}”` : (entry.text || entry.title).slice(0, 180)}</button>
                                <Button type="button" variant="outline" size="sm" onClick={() => { void window.analyst?.notebook.pin(entry.id, company.ticker).then((next) => setNotes((current) => ({ ...current, [company.ticker]: next }))); }}>{entry.pinned ? "Unpin" : "Pin"}</Button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
                {summary?.text ? <p className="mt-4 max-w-[68ch] text-[13px] leading-5 text-muted">{summary.text.slice(0, 500)}</p> : null}
                {summary?.at ? <p className="mt-3 text-[11px] text-muted">Generated {new Date(summary.at).toLocaleString()}{since > 0 ? ` · ${since} new items since` : ""}</p> : null}
              </Card>
            )}
          </div>
        )}

        {company && !showModel && !activeReport && currentView === "archive" && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-6 py-4">
            {pins.length === 0 ? (
              <EmptyState title="Nothing pinned" body="Pinned findings from the log collect here so you can come back to them." action="Open the notebook" onAction={() => setView((all) => ({ ...all, [company.id]: "notebook" }))} />
            ) : pins.map((entry) => (
              <Card key={entry.id}>
                <button type="button" className="text-left" onClick={() => void jump(entry)}>
                  <div className="text-sm font-medium">{entry.title}</div>
                  {entry.text && <p className="mt-1 max-w-[68ch] text-[13px] leading-5 text-muted">{entry.text}</p>}
                </button>
              </Card>
            ))}
          </div>
        )}
      </main>

      {panel && !company && (
        <aside className="relative flex min-h-0 flex-col border-l border-line bg-sidebar">
          <div className="border-b border-line px-3 py-2 text-sm font-medium">Agent</div>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
            {(threads.find((item) => item.companyId === "home" && !item.closed)?.messages || []).filter((message) => !/Tool choice is none/.test(message.text)).map((message) => (
              <p key={message.id} className={cn("mb-2 text-[13px] leading-5", message.role === "user" ? "text-muted" : "text-ink")}>{message.text || message.status}</p>
            ))}
          </div>
          <form className="border-t border-line p-2" onSubmit={(event) => { event.preventDefault(); sendHome(homeDraft); }}>
            <textarea value={homeDraft} rows={3} onChange={(event) => setHomeDraft(event.target.value)} placeholder="Ask a question" className="w-full resize-none rounded-[12px] border border-line bg-card p-2 text-sm outline-none" />
            <div className="mt-2 flex justify-end"><Button type="submit" disabled={!homeDraft.trim() || busy}>Send</Button></div>
          </form>
        </aside>
      )}
      {company && panel && (
        <aside className="relative flex min-h-0 flex-col border-l border-line bg-sidebar">
          <button type="button" aria-label="Resize agent panel" className="absolute bottom-0 left-0 top-0 w-1 cursor-col-resize hover:bg-accent" onMouseDown={(event) => dragWidth("panel", event)} />
          <div className="flex items-center gap-1 border-b border-line px-2 py-2">
            <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
              {openThreads.map((item) => (
                <Tab key={item.id} active={rightMode === "agent" && item.id === activeThread} onSelect={() => { setActiveThread(item.id); setRightMode("agent"); }} onClose={() => closeAgent(item.id)}>
                  {item.title === company.name ? company.ticker : `${company.ticker} · ${item.title}`}
                </Tab>
              ))}
              <Button variant="ghost" size="icon" title="New agent" onClick={addAgent}><Plus className="size-4" /></Button>
            </div>
            <div className="relative">
              <Button variant="ghost" size="icon" title="History" onClick={() => setHistoryOpen((value) => !value)}><History className="size-4" /></Button>
              {historyOpen && (
                <div className="absolute right-0 z-10 mt-1 w-56 rounded-[8px] border border-line bg-card p-1 shadow-sm">
                  {closedThreads.length === 0 ? <p className="px-2 py-1 text-[12px] text-muted">Closed agents show up here.</p> : closedThreads.map((item) => (
                    <button key={item.id} type="button" className="block w-full truncate rounded-[6px] px-2 py-1.5 text-left text-[13px] hover:bg-black/5 dark:hover:bg-white/8" onClick={() => { setHistoryOpen(false); setScreen(item.companyId); setPanel(true); setThreads((list) => list.map((row) => row.id === item.id ? { ...row, closed: false, updated: Date.now() } : row)); setActiveThread(item.id); setRightMode("agent"); }}>
                      {companies.find((row) => row.id === item.companyId)?.ticker || ""} · {item.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex rounded-[8px] border border-line bg-canvas p-0.5">
              <button type="button" className={cn("rounded-[6px] px-2 py-1 text-[12px] transition-colors duration-150", rightMode === "agent" ? "bg-card text-accent" : "text-muted")} onClick={() => setRightMode("agent")}>Agent</button>
              <button type="button" className={cn("rounded-[6px] px-2 py-1 text-[12px] transition-colors duration-150", rightMode === "highlights" ? "bg-card text-accent" : "text-muted")} onClick={() => setRightMode("highlights")}>Highlights</button>
            </div>
          </div>
          {rightMode === "agent" ? (
            <>
              {reaction && <p className="border-b border-line px-3 py-1 text-[12px] text-muted">{reaction}</p>}
              {thread?.status && <p className="px-3 pt-2 text-[12px] text-muted">{thread.title} is {thread.status}{thread.status === "waiting" ? " · waiting for capacity" : ""}</p>}
              <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
                {!thread || thread.messages.length === 0 ? (
                  <div className="flex flex-col gap-3">
                    <EmptyState title={`Ask about ${company.name}`} body="Questions stay in this agent. Enter sends, Shift+Enter adds a line." />
                    {suggestions.map((item) => (
                      <button key={item.text} type="button" className="rounded-[8px] border border-line bg-card px-3 py-2 text-left transition-colors duration-150 hover:border-accent" onClick={() => send(item.text)}>
                        <span className="text-[11px] uppercase tracking-wide text-muted">{item.topic}</span>
                        <span className="mt-1 block text-[13px]">{item.text}</span>
                      </button>
                    ))}
                  </div>
                ) : thread.messages.filter((message) => !/Tool choice is none/.test(message.text)).map((message) => (
                  <div key={message.id} className={cn("mb-3 max-w-[68ch] rounded-[8px] px-3 py-2 text-[14px] leading-6", message.role === "user" ? "ml-6 bg-bubble" : "bg-card")}>
                    {message.steps && message.steps.length > 0 && (
                      <ol className="mb-2 flex flex-col gap-1">
                        {message.steps.map((step, index) => (
                          <li key={`${step.text}-${index}`} className="text-[12px] leading-4 text-muted">
                            {step.state === "failed" ? "×" : step.state === "running" ? "…" : "✓"} {step.text}
                            {step.undoId && (
                              <button type="button" className="ml-2 text-accent" onClick={() => {
                                if (!company) return;
                                void window.analyst?.notebook.remove(step.undoId || "", company.ticker).then((rows) => setNotes((current) => ({ ...current, [company.ticker]: rows })));
                              }}>Undo</button>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                    <p className="whitespace-pre-wrap">{message.text}</p>
                    {message.status && <p className="mt-1 text-[12px] text-muted">{message.status}</p>}
                    {message.chips && message.chips.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {message.chips.map((chip, index) => <Chip key={`${chip.url || chip.label}-${index}`} onClick={() => chip.url && void openLink(chip.url, chip.label)}>{chip.label}</Chip>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {plan && thread && plan.threadId === thread.id && (
                <div className="border-t border-line px-3 py-2">
                  <p className="text-[12px] font-medium text-muted">Plan</p>
                  {plan.steps.map((step, index) => (
                    <input key={index} value={step} onChange={(event) => setPlan((current) => current && { ...current, steps: current.steps.map((item, at) => at === index ? event.target.value : item) })} className="mt-1 h-8 w-full rounded-[8px] border border-line bg-card px-2 text-[13px] outline-none focus-visible:outline-2 focus-visible:outline-accent" />
                  ))}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button type="button" size="sm" onClick={() => send(draft, true)}>Go</Button>
                    {plan.steps.length < 6 && <Button type="button" variant="outline" size="sm" onClick={() => setPlan((current) => current && { ...current, steps: [...current.steps, ""] })}>Add step</Button>}
                    {plan.steps.length > 3 && <Button type="button" variant="outline" size="sm" onClick={() => setPlan((current) => current && { ...current, steps: current.steps.slice(0, -1) })}>Remove step</Button>}
                    <Button type="button" variant="ghost" size="sm" onClick={() => setPlan(null)}>Cancel</Button>
                  </div>
                </div>
              )}
              {teamPlan && (
                <div className="border-t border-line px-3 py-2">
                  <p className="text-[12px] font-medium">Team plan</p>
                  {teamPlan.assignments.map((job, index) => (
                    <div key={job.id} className="mt-2">
                      <input className="h-7 w-full rounded-[8px] border border-line bg-card px-2 text-[12px]" value={job.title} onChange={(event) => setTeamPlan((plan) => plan && { ...plan, assignments: plan.assignments.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item) })} />
                      <textarea className="mt-1 w-full rounded-[8px] border border-line bg-card p-2 text-[12px]" value={job.question} onChange={(event) => setTeamPlan((plan) => plan && { ...plan, assignments: plan.assignments.map((item, itemIndex) => itemIndex === index ? { ...item, question: event.target.value } : item) })} />
                      <p className="text-[11px] text-muted">{job.status}{job.status === "waiting" ? " · waiting for capacity" : ""}</p>
                      <div className="mt-1 flex gap-2">
                        <button type="button" className="text-[11px] text-accent" onClick={() => window.analyst?.agent.stop(job.threadId)}>Stop</button>
                        <button type="button" className="text-[11px] text-accent" onClick={() => teamPlan && launchTeam(teamPlan, job.id)}>Re-run</button>
                      </div>
                    </div>
                  ))}
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={() => teamPlan && launchTeam(teamPlan)}>Go</Button>
                    <Button size="sm" variant="outline" onClick={() => setTeamPlan(null)}>Cancel</Button>
                  </div>
                </div>
              )}
              {askCard && (
                <div className="border-t border-line px-3 py-2">
                  <p className="text-[13px]">{askCard.prompt}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {askCard.kind === "choice" ? askCard.options?.map((option) => <Button key={option} size="sm" variant="outline" onClick={() => { setAssumptions((rows) => [...rows, { id: rid(), name: askCard.key, value: 0, unit: option, source: "Your answer" }]); setAskCard(null); }}>{option}</Button>) : (
                      <form onSubmit={(event) => { event.preventDefault(); const field = event.currentTarget.elements.namedItem("value") as HTMLInputElement; setAssumptions((rows) => [...rows, { id: rid(), name: askCard.key, value: Number(field.value), unit: "your input", source: "Your answer" }]); setAskCard(null); }}>
                        <input name="value" className="h-8 rounded-[8px] border border-line bg-card px-2 text-[13px]" />
                        <Button className="ml-2" size="sm" type="submit">Save</Button>
                      </form>
                    )}
                  </div>
                </div>
              )}
              {attached && <p className="border-t border-line px-3 py-1 text-[12px] text-muted">Attached: {attached.slice(0, 80)}</p>}
              <form className="border-t border-line p-2" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setAttached(event.dataTransfer.getData("text/plain")); }} onSubmit={(event) => { event.preventDefault(); send(draft); }}>
                <textarea
                  ref={composerRef}
                  value={draft}
                  rows={3}
                  placeholder={`Ask about ${company.name}`}
                  className="w-full resize-none rounded-[8px] border border-line bg-card p-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-accent"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                      event.preventDefault();
                      send(draft);
                    }
                  }}
                />
                <div className="mt-2 flex items-center justify-end gap-2">
                  {voiceError && <p className="mr-auto text-[12px] text-loss">{voiceError}</p>}
                  <Button type="button" variant={listening ? "default" : "outline"} title="Dictate into the box. It is not sent until you press Send." onClick={() => void toggleMic()}><Mic className="size-3.5" /> {listening ? "Listening" : "Mic"}</Button>
                  {busy && <Button type="button" variant="outline" onClick={() => window.analyst?.agent.stop()}>Stop</Button>}
                  <Button type="submit" disabled={!draft.trim() || busy}><Send className="size-3.5" /> Send</Button>
                </div>
              </form>
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <select value={highlightTag} onChange={(event) => setHighlightTag(event.target.value)} className="h-8 rounded-[8px] border border-line bg-card px-2 text-[13px]">
                  {["Evidence", "Risk", "Question"].map((tag) => <option key={tag}>{tag}</option>)}
                </select>
                <Button variant="outline" size="sm" onClick={() => {
                  void window.analyst?.selection.current().then((selection) => {
                    if (!selection?.text) return;
                    void window.analyst.notebook.highlight({ company: company.ticker, text: selection.text, context: selection.context, note: "", tag: highlightTag, url: selection.url, title: selection.title, anchor: selection.anchor, docId: selection.docId }).then((rows) => setNotes((current) => ({ ...current, [company.ticker]: rows })));
                  });
                }}>Save selection</Button>
              </div>
              <div className="mb-3 flex flex-wrap gap-1">
                <Chip active={!tagFilter} onClick={() => setTagFilter("")}>All tags</Chip>
                {highlightTags.map((tag) => <Chip key={tag} active={tagFilter === tag} onClick={() => setTagFilter(tag)}>{tag}</Chip>)}
              </div>
              {shownHighlights.length === 0 ? (
                <EmptyState title="No highlights yet" body="Select text in a filing or page, then save it here. Highlights group by the source they came from." action="Open filings" onAction={() => { setView((all) => ({ ...all, [company.id]: "research" })); setDocFocus("library"); }} />
              ) : [...bySource.entries()].map(([source, rows]) => (
                <div key={source} className="mb-4">
                  <h3 className="text-[12px] font-medium text-muted">{source}</h3>
                  {rows.map((entry) => (
                    <div key={entry.id} className="mt-2 rounded-[8px] border border-line bg-card px-3 py-2 transition-colors duration-150 hover:border-accent">
                      <button type="button" className="block w-full text-left" onClick={() => void jump(entry)}>
                        <span className="text-[11px] uppercase tracking-wide text-accent">{entry.by === "agent" ? "added by agent" : entry.tag}</span>
                        <span className="mt-1 block text-[13px] leading-5">“{entry.text}”</span>
                        {entry.note && entry.by !== "agent" && <span className="mt-1 block text-[12px] text-muted">{entry.note}</span>}
                      </button>
                      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { void window.analyst?.notebook.pin(entry.id, company.ticker).then((next) => setNotes((current) => ({ ...current, [company.ticker]: next }))); }}>{entry.pinned ? "Unpin" : "Pin"}</Button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </aside>
      )}

      {companyMenu && (
        <div className="fixed z-30" style={{ left: companyMenu.x, top: companyMenu.y }} onMouseLeave={() => setCompanyMenu(null)}>
          <div className="rounded-[12px] border border-line bg-card p-1 shadow-card">
            <button type="button" className="block w-full rounded-[8px] px-3 py-1.5 text-left text-[13px] hover:bg-white/5" onClick={() => { const item = companies.find((row) => row.id === companyMenu.id); if (item) void dismissCompany(item, "archive"); }}>Archive</button>
            <button type="button" className="block w-full rounded-[8px] px-3 py-1.5 text-left text-[13px] text-loss hover:bg-white/5" onClick={() => { const item = companies.find((row) => row.id === companyMenu.id); if (item) void dismissCompany(item, "delete"); }}>Delete</button>
          </div>
        </div>
      )}
      {palette && (
        <div className="fixed inset-0 z-20 flex items-start justify-center bg-black/30 pt-24" onClick={() => setPalette(false)}>
          <div className="w-[420px] rounded-[8px] border border-line bg-card p-2" onClick={(event) => event.stopPropagation()}>
            <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Jump to a company or ask" className="h-9 w-full bg-transparent px-2 text-sm outline-none" onKeyDown={(event) => { if (event.key === "Escape") setPalette(false); if (event.key === "Enter" && paletteRows[0]) { paletteRows[0].run(); setPalette(false); } }} />
            <ul className="mt-1">
              {paletteRows.map((row) => <li key={row.label}><button type="button" className="w-full rounded-[6px] px-2 py-1.5 text-left text-[13px] hover:bg-black/5 dark:hover:bg-white/8" onClick={() => { row.run(); setPalette(false); }}>{row.label}</button></li>)}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function ReaderView({ docId }: { docId: string }) {
  const [doc, setDoc] = useState<ReaderDoc | null>(null);
  useEffect(() => {
    void window.analyst?.docs.get(docId).then((row) => setDoc(row));
  }, [docId]);
  if (!doc) return <Skeleton className="m-6 h-40" />;
  return (
    <article
      className="relative min-h-0 flex-1 overflow-auto px-8 py-6"
      onMouseUp={() => {
        const text = window.getSelection()?.toString().replace(/\s+/g, " ").trim() || "";
        if (text.length < 2 || !doc) return;
        window.analyst?.selection.remember({ text, context: text, url: "", title: doc.title, docId: doc.id });
      }}
    >
      <h2 className="text-lg font-medium">{doc.title}</h2>
      {doc.sections.map((section) => (
        <section key={section.id} className="mt-6 max-w-[68ch]">
          <h3 className="text-sm font-medium">{section.title}</h3>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph.id} id={paragraph.id} className="mt-2 text-[14px] leading-6">{paragraph.text}</p>
          ))}
        </section>
      ))}
    </article>
  );
}

function FilingList({ rows, onOpen }: { rows: FilingLink[]; onOpen: (filing: FilingLink) => void }) {
  return (
    <ul className="mt-3 flex flex-col">
      {rows.map((filing) => (
        <li key={filing.url}>
          <button type="button" draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", `${filing.form} ${filing.description || filing.label}`)} className="flex w-full items-baseline gap-3 border-t border-line py-2 text-left transition-colors duration-150 hover:text-accent" onClick={() => onOpen(filing)}>
            <Chip className="pointer-events-none">{filing.form}</Chip>
            <span className="min-w-0 flex-1 text-[13px]">{filing.description || filing.label}</span>
            <span className="text-[12px] text-muted">{prettyDate(filing.reportDate)}</span>
            <span className="text-[12px] text-muted">{prettyDate(filing.filingDate || filing.reportDate)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function LogIcon({ type }: { type: Entry["type"] }) {
  const className = "mt-0.5 size-4 shrink-0 text-muted";
  if (type === "question") return <MessageSquare className={className} />;
  if (type === "highlight") return <Highlighter className={className} />;
  if (type === "finding") return <Pin className={className} />;
  if (type === "note") return <StickyNote className={className} />;
  if (type === "page") return <Globe className={className} />;
  return <FileText className={className} />;
}
