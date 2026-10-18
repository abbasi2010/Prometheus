import "./env";
import { existsSync } from "fs";
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { ask, overview, summarize } from "./agent";
import { envPath, projectRoot } from "./paths";
import { groqKey, secEmail, tavilyKey } from "./env";
import { docFromText, loadDoc } from "./docs";
import { quote } from "./market";
import { listFilings, resolveCompany } from "./sec";
import { add, addHighlight, findEntry, list, logPage, pin, remove } from "./store";
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
  proveNews,
  openReader,
  openWeb,
  rememberSelection,
  setBounds,
  setPageLogger,
  setReaderLogger,
} from "./tabs";

let windowRef: BrowserWindow | null = null;

function emit(event: unknown): void {
  windowRef?.webContents.send("agent:event", event);
}

function notebookChanged(): void {
  windowRef?.webContents.send("notebook:changed");
}

function createWindow(): void {
  const preload = join(__dirname, "../preload/index.js");
  if (!existsSync(preload)) console.error("Missing preload", preload);
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "Analyst",
    backgroundColor: "#f4f2ec",
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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

app.whenReady().then(() => {
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
ipcMain.handle("tabs:openUrl", (_event, url: string) => openWeb(url));

ipcMain.on("selection:remember", (_event, selection) => rememberSelection(selection));
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

ipcMain.handle("company:quote", async (_event, ticker: string) => quote(ticker));

ipcMain.handle("company:filings", async (_event, ticker: string) => {
  const [annual, quarterly] = await Promise.all([
    listFilings(ticker, "10-K", 3),
    listFilings(ticker, "10-Q", 3),
  ]);
  return [...annual, ...quarterly];
});

ipcMain.handle("company:openFiling", (_event, url: string, _label: string) => {
  openWeb(url);
  return url;
});

ipcMain.handle("docs:get", async (_event, id: string) => loadDoc(id));
ipcMain.handle("docs:open", async (_event, id: string, anchor?: string) => openDoc(id, anchor));

ipcMain.on("agent:ask", async (_event, text: string, company: string) => {
  let ticker = (company || activeCompany).trim().toUpperCase();
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
  void ask(text, ticker, emit);
});

ipcMain.on("agent:overview", (_event, company: string) => {
  activeCompany = (company || "").trim().toUpperCase();
  void add({
    company: activeCompany || "GENERAL",
    type: "question",
    title: "Quick overview",
    text: `Quick overview of ${activeCompany}`,
  }).then(() => notebookChanged());
  void overview(activeCompany, emit);
});

ipcMain.on("agent:summary", (_event, company: string) => {
  void summarize((company || activeCompany).trim().toUpperCase(), emit);
});

ipcMain.handle("notebook:list", (_event, company: string) => list(company));
ipcMain.handle("notebook:remove", async (_event, id: string, company: string) => {
  await remove(id);
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
