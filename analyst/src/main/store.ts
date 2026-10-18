import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { Entry, EntryType, HighlightInput } from "../shared/types";
import { dataDir } from "./paths";

let entries: Entry[] = [];
let loaded = false;
let writing: Promise<void> = Promise.resolve();

async function file(): Promise<string> {
  await mkdir(dataDir(), { recursive: true });
  return join(dataDir(), "notebook.json");
}

async function ensure(): Promise<void> {
  if (loaded) return;
  try {
    entries = JSON.parse(await readFile(await file(), "utf8")) as Entry[];
  } catch {
    entries = [];
  }
  loaded = true;
}

function persist(): void {
  const copy = JSON.stringify(entries);
  writing = writing.then(async () => {
    await writeFile(await file(), copy);
  });
}

function id(): string {
  return `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function list(company: string): Promise<Entry[]> {
  await ensure();
  const key = company.trim().toUpperCase();
  return entries.filter((entry) => entry.company === key).sort((a, b) => a.at - b.at);
}

export async function add(partial: Omit<Entry, "id" | "at"> & { at?: number }): Promise<Entry> {
  await ensure();
  const entry: Entry = {
    ...partial,
    company: partial.company.trim().toUpperCase(),
    id: id(),
    at: partial.at ?? Date.now(),
  };
  entries.push(entry);
  persist();
  return entry;
}

export async function remove(entryId: string): Promise<void> {
  await ensure();
  entries = entries.filter((entry) => entry.id !== entryId);
  persist();
}

export async function pin(entryId: string): Promise<Entry | null> {
  await ensure();
  const entry = entries.find((item) => item.id === entryId);
  if (!entry) return null;
  entry.pinned = !entry.pinned;
  persist();
  return entry;
}

export async function addHighlight(input: HighlightInput): Promise<Entry> {
  const web = !input.docId && input.url;
  const url = web ? textFragment(input.url, input.text) : input.url;
  return add({
    company: input.company,
    type: "highlight",
    title: input.title || input.url || "Highlight",
    url,
    text: input.text,
    note: input.note,
    tag: input.tag,
    anchor: input.anchor,
    docId: input.docId,
    pinned: false,
  });
}

function textFragment(url: string, text: string): string {
  const piece = text.replace(/\s+/g, " ").trim().slice(0, 80);
  const base = url.split("#")[0];
  return `${base}#:~:text=${encodeURIComponent(piece)}`;
}

export async function digest(company: string): Promise<string> {
  const rows = (await list(company)).slice(-12);
  if (!rows.length) return "";
  return rows
    .map((entry) => {
      const when = new Date(entry.at).toLocaleString();
      if (entry.type === "page") return `${when} opened ${entry.title}`;
      if (entry.type === "question") return `${when} asked: ${(entry.text || "").slice(0, 160)}`;
      if (entry.type === "highlight") {
        return `${when} highlighted (${entry.tag || "untagged"}) "${(entry.text || "").slice(0, 140)}" in ${entry.title}`;
      }
      if (entry.type === "finding") return `${when} pinned finding: ${(entry.text || "").slice(0, 180)}`;
      return `${when} saved source: ${entry.title}`;
    })
    .join("\n")
    .slice(-1800);
}

export async function logPage(company: string, title: string, url: string, docId?: string): Promise<void> {
  if (!company || !url) return;
  const rows = await list(company);
  const last = [...rows].reverse().find((entry) => entry.type === "page");
  if (last && last.url === url && Date.now() - last.at < 2 * 60 * 1000) return;
  await add({ company, type: "page" satisfies EntryType, title: title || url, url, docId });
}

export async function findEntry(entryId: string): Promise<Entry | null> {
  await ensure();
  return entries.find((entry) => entry.id === entryId) || null;
}
