import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, EnvStatus, Entry, FilingLink, HighlightInput, Quote, ReaderDoc, SelectionInfo, TabSnapshot } from "../shared/types";

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  env: (): Promise<EnvStatus> => ipcRenderer.invoke("env:status"),
  tabs: {
    snapshot: (): Promise<TabSnapshot> => ipcRenderer.invoke("tabs:snapshot"),
    newTab: (): Promise<TabSnapshot> => ipcRenderer.invoke("tabs:new"),
    close: (id: string): Promise<TabSnapshot> => ipcRenderer.invoke("tabs:close", id),
    activate: (id: string, anchor?: string): Promise<TabSnapshot> => ipcRenderer.invoke("tabs:activate", id, anchor),
    navigate: (id: string, input: string): Promise<TabSnapshot> => ipcRenderer.invoke("tabs:navigate", id, input),
    back: (): Promise<void> => ipcRenderer.invoke("tabs:back"),
    forward: (): Promise<void> => ipcRenderer.invoke("tabs:forward"),
    reload: (): Promise<void> => ipcRenderer.invoke("tabs:reload"),
    openUrl: (url: string, label?: string): Promise<TabSnapshot> => ipcRenderer.invoke("tabs:openUrl", url, label),
    group: (id: string): Promise<TabSnapshot> => ipcRenderer.invoke("tabs:group", id),
    onShortcut: (cb: (name: string) => void): (() => void) => listen("shortcut", cb),
    setBounds: (rect: { x: number; y: number; width: number; height: number }): void => {
      ipcRenderer.send("tabs:bounds", rect);
    },
    onChange: (cb: (snap: TabSnapshot) => void): (() => void) => listen("tabs:change", cb),
    onError: (cb: (payload: { url: string; text: string }) => void): (() => void) => listen("tabs:error", cb),
  },
  selection: {
    current: (): Promise<SelectionInfo | null> => ipcRenderer.invoke("selection:current"),
    remember: (selection: SelectionInfo): void => ipcRenderer.send("selection:remember", selection),
    onShow: (cb: (selection: SelectionInfo) => void): (() => void) => listen("selection:show", cb),
  },
  voice: {
    transcribe: (audio: ArrayBuffer): Promise<string> => ipcRenderer.invoke("voice:transcribe", audio),
  },
  onHighlight: (cb: () => void): (() => void) => listen("highlight:open", cb),
  company: {
    set: (ticker: string): void => ipcRenderer.send("company:set", ticker),
    resolve: (name: string): Promise<{ ticker: string; title: string } | null> => ipcRenderer.invoke("company:resolve", name),
    quote: (ticker: string): Promise<Quote> => ipcRenderer.invoke("company:quote", ticker),
    search: (query: string): Promise<{ ticker: string; title: string }[]> => ipcRenderer.invoke("company:search", query),
    series: (ticker: string, range: string): Promise<{ ticker: string; range: string; points: { t: number; price: number }[]; changePercent: number | null; asOf?: string }> =>
      ipcRenderer.invoke("company:series", ticker, range),
    filings: (ticker: string): Promise<FilingLink[]> => ipcRenderer.invoke("company:filings", ticker),
    bundle: (ticker: string): Promise<unknown> => ipcRenderer.invoke("company:bundle", ticker),
    openFiling: (url: string, label: string): Promise<string> => ipcRenderer.invoke("company:openFiling", url, label),
  },
  docs: {
    get: (id: string): Promise<ReaderDoc | null> => ipcRenderer.invoke("docs:get", id),
    open: (id: string, anchor?: string): Promise<void> => ipcRenderer.invoke("docs:open", id, anchor),
  },
  agent: {
    ask: (text: string, company: string, threadId?: string): void => ipcRenderer.send("agent:ask", text, company, threadId),
    stop: (threadId?: string): void => ipcRenderer.send("agent:stop", threadId),
    overview: (company: string): void => ipcRenderer.send("agent:overview", company),
    summary: (company: string): void => ipcRenderer.send("agent:summary", company),
    onEvent: (cb: (event: AgentEvent) => void): (() => void) => listen("agent:event", cb),
  },
  onCompanyResolved: (cb: (row: { ticker: string; title: string }) => void): (() => void) =>
    listen("company:resolved", cb),
  workspace: {
    get: () => ipcRenderer.invoke("workspace:get"),
    save: (partial: unknown) => ipcRenderer.invoke("workspace:save", partial),
    onApply: (cb: (command: { type: string; theme?: "system" | "light" | "dark"; name?: string }) => void): (() => void) =>
      listen("workspace:apply", cb),
  },
  confirm: (message: string): Promise<boolean> => ipcRenderer.invoke("app:confirm", message),
  capture: (name: string): Promise<boolean> => ipcRenderer.invoke("app:capture", name),
  openTestPage: (): Promise<unknown> => ipcRenderer.invoke("app:testPage"),
  notebook: {
    list: (company: string): Promise<Entry[]> => ipcRenderer.invoke("notebook:list", company),
    remove: (id: string, company: string): Promise<Entry[]> => ipcRenderer.invoke("notebook:remove", id, company),
    pin: (id: string, company: string): Promise<Entry[]> => ipcRenderer.invoke("notebook:pin", id, company),
    highlight: (input: HighlightInput): Promise<Entry[]> => ipcRenderer.invoke("notebook:highlight", input),
    finding: (company: string, text: string): Promise<Entry[]> => ipcRenderer.invoke("notebook:finding", company, text),
    note: (company: string, text: string): Promise<Entry[]> => ipcRenderer.invoke("notebook:note", company, text),
    clearCompany: (company: string): Promise<Entry[]> => ipcRenderer.invoke("notebook:clearCompany", company),
    paste: (company: string, title: string, text: string): Promise<string> => ipcRenderer.invoke("notebook:paste", company, title, text),
    open: (id: string): Promise<void> => ipcRenderer.invoke("notebook:open", id),
    onChange: (cb: () => void): (() => void) => listen("notebook:changed", cb),
  },
  team: {
    propose: (text: string, company: string) => ipcRenderer.invoke("team:propose", text, company),
    start: (plan: unknown) => ipcRenderer.invoke("team:start", plan),
  },
  reports: {
    list: (company: string) => ipcRenderer.invoke("reports:list", company),
    get: (id: string) => ipcRenderer.invoke("reports:get", id),
    save: (report: unknown) => ipcRenderer.invoke("reports:save", report),
  },
  feed: {
    ranked: () => ipcRenderer.invoke("feed:ranked"),
    refresh: () => ipcRenderer.invoke("feed:refresh"),
    vote: (ticker: string, choice: "interested" | "not" | "known") => ipcRenderer.invoke("feed:vote", ticker, choice),
    undo: (ticker: string) => ipcRenderer.invoke("feed:undo", ticker),
    reset: () => ipcRenderer.invoke("feed:reset"),
  },
  memory: {
    get: () => ipcRenderer.invoke("memory:get"),
    remember: (text: string, company: string) => ipcRenderer.invoke("memory:remember", text, company),
    update: (id: string, text: string) => ipcRenderer.invoke("memory:update", id, text),
  },
};

contextBridge.exposeInMainWorld("analyst", api);

export type AnalystApi = typeof api;
