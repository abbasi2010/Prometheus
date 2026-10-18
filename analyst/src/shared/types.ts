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

export type AgentEvent =
  | { type: "user"; text: string }
  | { type: "progress"; text: string }
  | { type: "token"; text: string }
  | { type: "source"; chip: Chip }
  | { type: "error"; text: string }
  | { type: "done" }
  | { type: "summary-token"; text: string }
  | { type: "summary-done" };

export type Quote = {
  ticker: string;
  name?: string;
  price?: number | null;
  currency?: string;
  from?: number | null;
  to?: number | null;
  changePercent?: number | null;
  marketCap?: number | null;
  trailingPE?: number | null;
  forwardPE?: number | null;
  priceToBook?: number | null;
  error?: string;
};

export type FilingLink = {
  label: string;
  url: string;
  form: string;
  reportDate: string;
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

export type EntryType = "page" | "question" | "highlight" | "finding" | "source";

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
};

export type EnvStatus = {
  groq: boolean;
  tavily: boolean;
  sec: boolean;
  envPath: string;
};
