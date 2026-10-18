export type TabInfo = {
  id: string;
  kind: "web" | "reader";
  title: string;
  url: string;
  docId?: string;
  anchor?: string;
  active: boolean;
};

export type TabSnapshot = { tabs: TabInfo[] };

export type SelectionInfo = {
  text: string;
  context: string;
  url: string;
  title: string;
  anchor?: string;
  docId?: string;
};

export type Chip = {
  label: string;
  url?: string;
  docId?: string;
  anchor?: string;
};

export type AgentEvent = (
  | { type: "user"; text: string }
  | { type: "progress"; text: string }
  | { type: "step"; text: string; state: "running" | "done" | "failed"; undoId?: string }
  | { type: "token"; text: string }
  | { type: "replace"; text: string }
  | { type: "source"; chip: Chip }
  | { type: "error"; text: string }
  | { type: "done" }
  | { type: "summary-token"; text: string }
  | { type: "summary-done" }
  | { type: "team"; teamId: string; jobs: { id: string; title: string; question: string; sources: string; depth: string; status: string; threadId: string; reportId?: string }[] }
  | { type: "report"; report: { id: string; company: string; title: string; question: string; bottomLine: string; findings: { text: string; chips: Chip[] }[]; evidence: { metric: string; period: string; value: string; source: string; url?: string }[]; counter: string; unclear: string; followUps: string[]; at: number } }
  | { type: "ask-user"; prompt: string; kind: "choice" | "number"; options?: string[]; key: string }
) & { threadId?: string };

export type Quote = {
  ticker: string;
  name?: string;
  price?: number | null;
  currency?: string;
  from?: number | null;
  to?: number | null;
  changePercent?: number | null;
  marketCap?: number | null;
  closes?: number[];
  asOf?: string;
  trailingPE?: number | null;
  forwardPE?: number | null;
  priceToBook?: number | null;
  priceToSales?: number | null;
  error?: string;
};

export type FilingLink = {
  label: string;
  url: string;
  form: string;
  reportDate: string;
  filingDate?: string;
  description?: string;
  bucket?: "annual" | "quarterly" | "current" | "proxy" | "insider" | "other";
};

export type Paragraph = { id: string; text: string };
export type Section = { id: string; title: string; paragraphs: Paragraph[] };
export type ReaderDoc = {
  id: string;
  title: string;
  url: string;
  kind: "filing" | "paste";
  sections: Section[];
};

export type EntryType = "page" | "question" | "highlight" | "finding" | "source" | "note";

export type Entry = {
  id: string;
  company: string;
  at: number;
  type: EntryType;
  title: string;
  url?: string;
  text?: string;
  note?: string;
  tag?: string;
  anchor?: string;
  docId?: string;
  pinned?: boolean;
  by?: "agent" | "user";
};

export type HighlightInput = {
  company: string;
  text: string;
  context: string;
  note: string;
  tag: string;
  url: string;
  title: string;
  anchor?: string;
  docId?: string;
  by?: "agent" | "user";
};

export type EnvStatus = {
  groq: boolean;
  tavily: boolean;
  sec: boolean;
  envPath: string;
};
