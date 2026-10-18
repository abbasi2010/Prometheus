import "./env";
import { existsSync } from "fs";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, session, type WebContents } from "electron";

app.setName("Prometheus");
import { join } from "path";
import { ask, overview, requestStop, summarize } from "./agent";
import { envPath, projectRoot } from "./paths";
import { loadWorkspace, saveWorkspace } from "./workspace";
import { groqKey, secEmail, tavilyKey } from "./env";
import { docFromText, loadDoc } from "./docs";
import { compare, priceSeries, quote } from "./market";
import type { Quote } from "../shared/types";
import { webSearch } from "./search";
import { companyProfile, financials, listAllFilings, resolveCompany, searchCompanies } from "./sec";
import { add, addHighlight, findEntry, highlightsFor, list, logPage, pin, remove, removeCompany, updateHighlight } from "./store";
import { getReport, listReports, saveReport, type Report } from "./reports";
import { proposeTeam, startTeam, stopJob, type TeamPlan } from "./team";
import { fillMissingPrices, loadFeed, ranked, resetFeedModel, undoVote, vote } from "./feed";
import { loadMemory, remember, updateNote } from "./memory";
import { confirm, setApply } from "./dialog";
import { mkdir, writeFile } from "fs/promises";
import {
  activeWebContents,
  activate,
  attach,
  closeTab,
  currentSelection,
  getSnapshot,
  go,
  navigate,
  newTab,
  openDoc,
  openLocal,
  ownsContents,
  proveNews,
  openReader,
  openWeb,
  refreshHighlights,
  rememberSelection,
  setBlocklist,
  switchGroup,
  setBounds,
  setPageLogger,
  setReaderLogger,
} from "./tabs";

function assertApp(sender: WebContents): void {
  const owner = BrowserWindow.fromWebContents(sender);
  if (!owner || sender.id !== owner.webContents.id) throw new Error("Blocked sender.");
}

function assertGuestOrApp(sender: WebContents): void {
  const owner = BrowserWindow.fromWebContents(sender);
  if (owner && sender.id === owner.webContents.id) return;
  if (ownsContents(sender)) return;
  throw new Error("Blocked sender.");
}

let windowRef: BrowserWindow | null = null;
let liveThread = "";

function emit(event: unknown): void {
  if (!event || typeof event !== "object") return;
  const body = event as { threadId?: string };
  windowRef?.webContents.send("agent:event", { ...body, threadId: body.threadId || liveThread });
}

function notebookChanged(): void {
  windowRef?.webContents.send("notebook:changed");
}

function createWindow(): void {
  const preload = join(__dirname, "../preload/index.js");
  if (!existsSync(preload)) console.error("Missing preload", preload);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === "media");
  });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "Prometheus",
    backgroundColor: "#0B0D10",
    icon: join(projectRoot(), "assets", "icon-512.png"),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on("preload-error", (_event, path, error) => {
    console.error("preload-error", path, error);
  });
  win.webContents.on("did-finish-load", () => {
    if (process.env.ANALYST_PROVE !== "1") return;
    setTimeout(() => {
      void proveNews("https://www.npr.org/sections/business/").then(async (result) => {
        console.log("PROVE", JSON.stringify(result));
        await mkdir(join(projectRoot(), "data"), { recursive: true });
        const shot = await win.capturePage();
        await writeFile(join(projectRoot(), "data", "prove-window.png"), shot.toPNG());
        const guest = activeWebContents();
        if (guest) {
          const page = await guest.capturePage();
          await writeFile(join(projectRoot(), "data", "prove-news.png"), page.toPNG());
        }
        console.log("PROVE saved screenshots");
      });
    }, 1200);
  });
  windowRef = win;
  setPageLogger((page) => {
    const company = activeCompany;
    if (!company) return;
    void logPage(company, page.title, page.url).then(() => notebookChanged());
  });
  setReaderLogger((doc) => {
    if (!activeCompany) return;
    void logPage(activeCompany, doc.title, doc.url, doc.id).then(() => notebookChanged());
  });
  attach(win);
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  win.on("closed", () => {
    windowRef = null;
  });
}

let activeCompany = "";

app.whenReady().then(async () => {
  setApply((command) => windowRef?.webContents.send("workspace:apply", command));
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      { label: "View", submenu: [{ role: "togglefullscreen" }] },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }] },
    ]),
  );
  const workspace = await loadWorkspace();
  nativeTheme.themeSource = workspace.theme || "system";
  if (workspace.blocklist?.length) setBlocklist(workspace.blocklist);
  const icon = nativeImage.createFromPath(join(projectRoot(), "assets", "icon-512.png"));
  if (!icon.isEmpty() && process.platform === "darwin") app.dock?.setIcon(icon);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

ipcMain.handle("env:status", () => ({
  groq: Boolean(groqKey()),
  tavily: Boolean(tavilyKey()),
  sec: Boolean(secEmail()),
  envPath: envPath(),
}));

ipcMain.handle("tabs:snapshot", () => getSnapshot());
ipcMain.handle("tabs:new", () => newTab());
ipcMain.handle("tabs:close", (_event, id: string) => closeTab(id));
ipcMain.handle("tabs:activate", (_event, id: string, anchor?: string) => activate(id, anchor));
ipcMain.handle("tabs:navigate", (_event, id: string, input: string) => navigate(id, input));
ipcMain.handle("tabs:back", () => go("back"));
ipcMain.handle("tabs:forward", () => go("forward"));
ipcMain.handle("tabs:reload", () => go("reload"));
ipcMain.on("tabs:bounds", (_event, rect: { x: number; y: number; width: number; height: number }) => setBounds(rect));
ipcMain.handle("tabs:openUrl", (_event, url: string, label?: string) => openWeb(url, label || ""));
ipcMain.handle("tabs:group", (_event, id: string) => switchGroup(id));
ipcMain.handle("workspace:get", (event) => {
  assertApp(event.sender);
  return loadWorkspace();
});
ipcMain.handle("workspace:save", async (event, partial) => {
  assertApp(event.sender);
  const saved = await saveWorkspace(partial);
  if (partial?.theme) nativeTheme.themeSource = partial.theme;
  if (Array.isArray(partial?.blocklist)) setBlocklist(partial.blocklist);
  return saved;
});
ipcMain.handle("app:confirm", async (event, message: string) => {
  assertApp(event.sender);
  return confirm(String(message || "Continue?"));
});
ipcMain.handle("app:testPage", (event) => {
  assertApp(event.sender);
  return openLocal(join(projectRoot(), "assets", "injection.html"), "Security test page");
});

ipcMain.on("selection:remember", (event, selection) => {
  assertGuestOrApp(event.sender);
  rememberSelection(selection);
});
ipcMain.handle("highlights:for", (event, url: string) => {
  assertGuestOrApp(event.sender);
  return highlightsFor(String(url || ""));
});
ipcMain.on("highlight:save", (event, input) => {
  assertGuestOrApp(event.sender);
  void addHighlight({
    company: activeCompany || "GENERAL",
    text: String(input?.text || ""),
    context: String(input?.context || ""),
    note: "",
    tag: "Evidence",
    url: String(input?.url || ""),
    title: String(input?.title || "Highlight"),
  }).then(() => {
    refreshHighlights();
    notebookChanged();
  });
});
ipcMain.on("highlight:update", (event, input) => {
  assertGuestOrApp(event.sender);
  void updateHighlight(String(input?.id || ""), String(input?.note || ""), String(input?.tag || "Evidence")).then(() => {
    refreshHighlights();
    notebookChanged();
  });
});
ipcMain.on("highlight:remove", (event, id: string) => {
  assertGuestOrApp(event.sender);
  void confirm("Remove this highlight?").then(async (ok) => {
    if (!ok) return;
    await remove(String(id));
    refreshHighlights();
    notebookChanged();
  });
});
ipcMain.handle("selection:current", () => currentSelection());

ipcMain.on("company:set", (_event, ticker: string) => {
  activeCompany = (ticker || "").trim().toUpperCase();
});

ipcMain.handle("company:resolve", async (_event, name: string) => {
  const row = await resolveCompany(name);
  if (!row) return null;
  activeCompany = row.ticker.toUpperCase();
  return { ticker: row.ticker, title: row.title };
});

ipcMain.handle("company:quote", async (event, ticker: string) => {
  assertApp(event.sender);
  return quote(ticker);
});

ipcMain.handle("company:search", async (event, query: string) => {
  assertApp(event.sender);
  return searchCompanies(String(query || ""));
});

ipcMain.handle("company:series", async (event, ticker: string, range: string) => {
  assertApp(event.sender);
  return priceSeries(ticker, range || "1y");
});

ipcMain.handle("company:filings", async (_event, ticker: string) => listAllFilings(ticker));

function roundMultiple(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0 || value > 500) return null;
  return Math.round(value * 10) / 10;
}

function enrichQuote(row: Quote, facts: { facts?: Record<string, { values?: { value: number }[] }> } | null): Quote {
  const value = (name: string) => facts?.facts?.[name]?.values?.[0]?.value;
  const revenue = value("revenue");
  const income = value("net income");
  const equity = value("equity");
  const shares = value("shares outstanding") || value("diluted shares");
  const price = row.price ?? null;
  const marketCap = row.marketCap || (price && shares ? price * shares : null);
  const eps = income != null && shares ? income / shares : null;
  return {
    ...row,
    marketCap: marketCap ?? null,
    trailingPE: row.trailingPE ?? roundMultiple(price && eps ? price / eps : null),
    priceToBook: row.priceToBook ?? roundMultiple(price && equity && shares ? price / (equity / shares) : null),
    priceToSales: row.priceToSales ?? roundMultiple(marketCap && revenue ? marketCap / revenue : null),
  };
}

ipcMain.handle("company:bundle", async (_event, ticker: string) => {
  const symbol = ticker.trim().toUpperCase();
  const [quoteR, factsR, filingsR, newsR, peersR, profileR] = await Promise.allSettled([
    quote(symbol),
    financials(symbol),
    listAllFilings(symbol),
    webSearch(`${symbol} company news`),
    compare(symbol),
    companyProfile(symbol),
  ]);
  const why = (result: PromiseSettledResult<unknown>) =>
    result.status === "rejected" ? (result.reason instanceof Error ? result.reason.message : "Unavailable.") : "";
  const facts = factsR.status === "fulfilled" ? (factsR.value as { facts?: Record<string, { values?: { value: number }[] }> }) : null;
  const rawQuote = quoteR.status === "fulfilled" ? quoteR.value : { ticker: symbol, error: why(quoteR) };
  return {
    quote: enrichQuote(rawQuote, facts),
    facts: factsR.status === "fulfilled" ? factsR.value : { error: why(factsR) },
    filings: filingsR.status === "fulfilled" ? filingsR.value : [],
    filingsError: why(filingsR),
    news: newsR.status === "fulfilled" ? newsR.value : [],
    newsError: why(newsR),
    peers: peersR.status === "fulfilled" ? peersR.value : { rows: [], error: why(peersR) },
    profile: profileR.status === "fulfilled" ? profileR.value : { sic: "", sicDescription: "", industry: "generic", error: why(profileR) },
  };
});

ipcMain.handle("company:openFiling", (_event, url: string, label: string) => {
  openWeb(url, label);
  return url;
});

ipcMain.handle("docs:get", async (_event, id: string) => loadDoc(id));
ipcMain.handle("docs:open", async (_event, id: string, anchor?: string) => openDoc(id, anchor));

ipcMain.handle("voice:transcribe", async (event, data: ArrayBuffer) => {
  assertApp(event.sender);
  const key = groqKey();
  if (!key) throw new Error("Add GROQ_API_KEY to analyst/.env.");
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/webm" }), "speech.webm");
  form.append("model", "whisper-large-v3-turbo");
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Transcription failed (${response.status}).`);
  const body = (await response.json()) as { text?: string };
  return String(body.text || "").trim();
});

ipcMain.on("agent:stop", (event, threadId?: string) => {
  assertApp(event.sender);
  const id = String(threadId || liveThread || "*");
  requestStop(id);
  stopJob(id);
});

ipcMain.on("agent:ask", async (event, text: string, company: string, threadId?: string) => {
  assertApp(event.sender);
  liveThread = threadId || "";
  let ticker = (company || "").trim().toUpperCase();
  if (!ticker) {
    const { companyHint } = await import("./pull");
    const hint = companyHint(text);
    if (hint) {
      const row = await resolveCompany(hint);
      if (row) {
        ticker = row.ticker.toUpperCase();
        activeCompany = ticker;
        windowRef?.webContents.send("company:resolved", { ticker: row.ticker, title: row.title });
      }
    }
  } else {
    activeCompany = ticker;
  }
  void add({
    company: activeCompany || "GENERAL",
    type: "question",
    title: "Question",
    text,
  }).then(() => notebookChanged());
  void ask(text, ticker, emit, liveThread);
});

ipcMain.on("agent:overview", (_event, company: string) => {
  activeCompany = (company || "").trim().toUpperCase();
  liveThread = `overview:${activeCompany}`;
  void add({
    company: activeCompany || "GENERAL",
    type: "question",
    title: "Quick overview",
    text: `Quick overview of ${activeCompany}`,
  }).then(() => notebookChanged());
  void overview(activeCompany, emit);
});

ipcMain.on("agent:summary", (_event, company: string) => {
  const ticker = (company || activeCompany).trim().toUpperCase();
  liveThread = `summary:${ticker}`;
  void summarize(ticker, emit);
});

ipcMain.handle("notebook:list", (_event, company: string) => list(company));
ipcMain.handle("app:capture", async (event, name: string) => {
  assertApp(event.sender);
  const shot = await windowRef?.webContents.capturePage();
  if (!shot) return false;
  await mkdir(join(projectRoot(), "data"), { recursive: true });
  const safe = String(name || "screen").replace(/[^a-z0-9-]+/gi, "-").slice(0, 40);
  await writeFile(join(projectRoot(), "data", `prove-${safe}.png`), shot.toPNG());
  return true;
});
ipcMain.handle("notebook:clearCompany", async (event, company: string) => {
  assertApp(event.sender);
  await removeCompany(company);
  notebookChanged();
  return list(company);
});
ipcMain.handle("team:propose", async (event, text: string, company: string) => {
  assertApp(event.sender);
  return proposeTeam(String(text || ""), String(company || activeCompany || ""));
});
ipcMain.handle("team:start", async (event, plan: TeamPlan) => {
  assertApp(event.sender);
  startTeam(plan, emit);
  return true;
});
ipcMain.handle("reports:list", async (event, company: string) => {
  assertApp(event.sender);
  return listReports(company);
});
ipcMain.handle("reports:get", async (event, id: string) => {
  assertApp(event.sender);
  return getReport(id);
});
ipcMain.handle("reports:save", async (event, report: Report) => {
  assertApp(event.sender);
  return saveReport(report);
});
ipcMain.handle("feed:ranked", async (event) => {
  assertApp(event.sender);
  return ranked();
});
ipcMain.handle("feed:refresh", async (event) => {
  assertApp(event.sender);
  void fillMissingPrices((text) => emit({ type: "progress", text }));
  return ranked();
});
ipcMain.handle("feed:vote", async (event, ticker: string, choice: "interested" | "not" | "known") => {
  assertApp(event.sender);
  await vote(ticker, choice);
  return ranked();
});
ipcMain.handle("feed:undo", async (event, ticker: string) => {
  assertApp(event.sender);
  await undoVote(ticker);
  return ranked();
});
ipcMain.handle("feed:reset", async (event) => {
  assertApp(event.sender);
  await resetFeedModel();
  return ranked();
});
ipcMain.handle("memory:get", async (event) => {
  assertApp(event.sender);
  return loadMemory();
});
ipcMain.handle("memory:remember", async (event, text: string, company: string) => {
  assertApp(event.sender);
  return remember(text, company);
});
ipcMain.handle("memory:update", async (event, id: string, text: string) => {
  assertApp(event.sender);
  await updateNote(id, text);
  return loadMemory();
});
ipcMain.handle("notebook:remove", async (event, id: string, company: string) => {
  assertApp(event.sender);
  const ok = await confirm("Remove this note?");
  if (!ok) return list(company);
  await remove(id);
  refreshHighlights();
  notebookChanged();
  return list(company);
});
ipcMain.handle("notebook:pin", async (_event, id: string, company: string) => {
  await pin(id);
  return list(company);
});
ipcMain.handle("notebook:highlight", async (_event, input) => {
  const company = (input.company || activeCompany || "GENERAL").trim().toUpperCase();
  await addHighlight({ ...input, company });
  notebookChanged();
  return list(company);
});
ipcMain.handle("notebook:note", async (_event, company: string, text: string) => {
  const ticker = (company || activeCompany || "GENERAL").trim().toUpperCase();
  await add({ company: ticker, type: "note", title: "Note", text });
  notebookChanged();
  return list(ticker);
});

ipcMain.handle("notebook:finding", async (_event, company: string, text: string) => {
  const ticker = (company || activeCompany || "GENERAL").trim().toUpperCase();
  await add({ company: ticker, type: "finding", title: "Pinned finding", text, pinned: true });
  return list(ticker);
});
ipcMain.handle("notebook:paste", async (_event, company: string, title: string, text: string) => {
  const doc = docFromText(`paste-${Date.now().toString(36)}`, title || "Pasted text", "", "paste", text);
  openReader(doc);
  const ticker = (company || activeCompany || "").trim().toUpperCase();
  if (ticker) {
    await add({ company: ticker, type: "source", title: doc.title, text: text.slice(0, 180), docId: doc.id });
    notebookChanged();
  }
  return doc.id;
});
ipcMain.handle("notebook:open", async (_event, id: string) => {
  const entry = await findEntry(id);
  if (!entry) return;
  if (entry.docId) {
    await openDoc(entry.docId, entry.anchor);
    return;
  }
  if (entry.url) openWeb(entry.url);
});
