import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { dataDir } from "./paths";
import { captureGroups, restoreGroups, type SavedTab } from "./tabs";

export type Workspace = {
  theme: "system" | "light" | "dark";
  sidebar: boolean;
  panel: boolean;
  screen: string;
  view: Record<string, "overview" | "research" | "notebook" | "archive" | "documents">;
  companies?: { id: string; ticker: string; name: string }[];
  threads?: unknown;
  snaps?: unknown;
  summaries?: unknown;
  sidebarWidth?: number;
  panelWidth?: number;
  blocklist?: string[];
  groups: Record<string, SavedTab[]>;
};

const empty: Workspace = {
  theme: "system",
  sidebar: true,
  panel: true,
  screen: "home",
  view: {},
  groups: {},
};

let current: Workspace = { ...empty };
let booted = false;

function file(): string {
  return join(dataDir(), "workspace.json");
}

export async function loadWorkspace(): Promise<Workspace> {
  if (booted) return current;
  try {
    current = { ...empty, ...(JSON.parse(await readFile(file(), "utf8")) as Workspace) };
  } catch {
    current = { ...empty };
  }
  booted = true;
  if (Object.keys(current.groups || {}).length) {
    restoreGroups(current.groups, current.screen === "home" || current.screen === "settings" ? "home" : current.screen);
  }
  return current;
}

export async function saveWorkspace(partial: Partial<Workspace>): Promise<Workspace> {
  current = { ...current, ...partial, groups: captureGroups() };
  await mkdir(dataDir(), { recursive: true });
  await writeFile(file(), JSON.stringify(current));
  return current;
}
