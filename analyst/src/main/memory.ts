import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { dataDir } from "./paths";

export type MemoryNote = { id: string; company: string; text: string; at: number };
export type Interest = { industries: string[]; metrics: string[]; depth: string; jargon: string; sources: string[] };

type MemoryFile = { notes: MemoryNote[]; interest: Interest; ratings: { ticker: string; vote: "interested" | "not" | "known" }[] };

const empty = (): MemoryFile => ({
  notes: [],
  interest: { industries: [], metrics: [], depth: "standard", jargon: "plain", sources: [] },
  ratings: [],
});

let current = empty();
let loaded = false;

async function file(): Promise<string> {
  await mkdir(dataDir(), { recursive: true });
  return join(dataDir(), "memory.json");
}

export async function loadMemory(): Promise<MemoryFile> {
  if (loaded) return current;
  return rereadMemory();
}

export async function rereadMemory(): Promise<MemoryFile> {
  try {
    current = { ...empty(), ...(JSON.parse(await readFile(await file(), "utf8")) as MemoryFile) };
  } catch {
    if (!loaded) current = empty();
  }
  loaded = true;
  return current;
}

async function persist(): Promise<void> {
  await writeFile(await file(), JSON.stringify(current));
}

export async function remember(text: string, company = "*"): Promise<MemoryNote> {
  await loadMemory();
  const note = { id: `m${Date.now().toString(36)}`, company: company.trim().toUpperCase() || "*", text: text.trim(), at: Date.now() };
  current.notes.push(note);
  const lower = text.toLowerCase();
  if (/per-share|buyback|take rate|margin|cash flow/.test(lower)) {
    const metric = /buyback/.test(lower) ? "buybacks" : /per-share/.test(lower) ? "per-share growth" : /take rate/.test(lower) ? "take rate" : /margin/.test(lower) ? "margins" : "cash flow";
    if (!current.interest.metrics.includes(metric)) current.interest.metrics.push(metric);
  }
  await persist();
  return note;
}

export async function updateNote(id: string, text: string): Promise<void> {
  await loadMemory();
  const note = current.notes.find((item) => item.id === id);
  if (note) note.text = text;
  await persist();
}

export async function rateTicker(ticker: string, vote: "interested" | "not" | "known"): Promise<void> {
  await loadMemory();
  current.ratings = current.ratings.filter((item) => item.ticker !== ticker.toUpperCase());
  current.ratings.push({ ticker: ticker.toUpperCase(), vote });
  await persist();
}

export async function clearRating(ticker: string): Promise<void> {
  await loadMemory();
  current.ratings = current.ratings.filter((item) => item.ticker !== ticker.toUpperCase());
  await persist();
}

export async function memoryDigest(company: string): Promise<string> {
  const fileState = await loadMemory();
  const key = company.trim().toUpperCase();
  const notes = fileState.notes.filter((note) => note.company === "*" || note.company === key).slice(-8);
  const interest = fileState.interest.metrics.length ? `This investor cares about ${fileState.interest.metrics.join(", ")}.` : "";
  const lines = notes.map((note) => note.text);
  return [interest, ...lines].filter(Boolean).join("\n").slice(0, 800);
}

export async function ratings(): Promise<MemoryFile["ratings"]> {
  return (await loadMemory()).ratings;
}
