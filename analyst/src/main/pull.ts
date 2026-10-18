import type { AgentEvent } from "../shared/types";
import { resolveCompany, listFilings } from "./sec";
import { openWeb } from "./tabs";
import { findTranscripts } from "./transcript";

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function countFrom(word: string, fallback: number, cap = 4): number {
  const n = Number(word);
  const value = Number.isFinite(n) && n > 0 ? Math.floor(n) : WORDS[word.toLowerCase()] ?? fallback;
  return Math.max(1, Math.min(cap, value));
}

export function companyHint(text: string): string {
  const possessive = text.match(/\b([A-Za-z][\w .&'-]{0,40})'s\b/);
  if (possessive) return possessive[1].replace(/\s+/g, " ").trim();
  const forCo = text.match(/\b(?:for|on)\s+([A-Za-z][\w .&'-]{0,40})\b/i);
  if (forCo) return forCo[1].replace(/\s+/g, " ").trim();
  const ticker = text.match(/\b([A-Z]{1,5})\b/);
  if (ticker && ticker[1].length >= 2) return ticker[1];
  return "";
}

export type PullPlan = { k: number; q: number; wantsTranscript: boolean };

const COUNT = "(\\d+|one|two|three|four|five|six)";

/** When the user asks to open filings, don't wait on the model. */
export function parsePull(text: string): PullPlan | null {
  const lower = text.toLowerCase();
  const wantsK = /\b10\s*-?\s*k\b|\bannual reports?\b/.test(lower);
  const wantsQ = /\b10\s*-?\s*qs?\b|\bquarterly reports?\b/.test(lower);
  const wantsTranscript = /\bearnings call\b|\btranscript\b/.test(lower);
  if (!wantsK && !wantsQ && !wantsTranscript) return null;
  if (!/\b(give|pull|open|get|show|bring|fetch|load|latest|last)\b/i.test(text) && !wantsK && !wantsQ) return null;

  let k = 0;
  if (wantsK) {
    const years = lower.match(new RegExp(`(?:last|latest|past)\\s+${COUNT}\\s+years?`));
    const direct = lower.match(new RegExp(`(?:last|latest)\\s+${COUNT}\\s+10\\s*-?\\s*ks?`));
    k = years ? countFrom(years[1], 1) : direct ? countFrom(direct[1], 1) : 1;
  }
  let q = 0;
  if (wantsQ) {
    const direct = lower.match(new RegExp(`(?:last|latest)\\s+${COUNT}\\s+10\\s*-?\\s*qs?`));
    q = direct ? countFrom(direct[1], 3) : 1;
  }
  if (!k && !q && !wantsTranscript) return null;
  return { k, q, wantsTranscript };
}

function step(emit: (event: AgentEvent) => void, text: string, state: "running" | "done" | "failed" = "running"): void {
  emit({ type: "step", text, state });
}

export async function runPull(
  text: string,
  companyTicker: string,
  emit: (event: AgentEvent) => void,
  halt: () => boolean = () => false,
): Promise<{ handled: boolean; note: string }> {
  const plan = parsePull(text);
  if (!plan) return { handled: false, note: "" };

  let name = companyTicker.trim();
  if (!name) name = companyHint(text);
  if (!name) {
    emit({ type: "error", text: "Pick a company on the left, or say the name in your question (for example Uber's 10-K)." });
    return { handled: true, note: "" };
  }

  const row = await resolveCompany(name);
  if (!row) {
    emit({ type: "error", text: `Couldn't find ${name} in the SEC company list.` });
    return { handled: true, note: "" };
  }

  const label = row.ticker;
  const jobs: { form: "10-K" | "10-Q"; count: number; label: string }[] = [];
  if (plan.k) jobs.push({ form: "10-K", count: plan.k, label: `${plan.k} 10-K` });
  if (plan.q) jobs.push({ form: "10-Q", count: plan.q, label: `${plan.q} 10-Q` });

  let opened = 0;
  const openedLabels: string[] = [];
  if (jobs.length) {
    step(emit, `Fetching ${jobs.map((job) => job.label).join(" and ")} for ${row.title}`);
    for (const job of jobs) {
      if (halt()) return stopped(emit, openedLabels);
      const filings = await listFilings(label, job.form, job.count);
      for (const filing of filings) {
        if (halt()) return stopped(emit, openedLabels);
        step(emit, `Opening ${filing.label}`);
        openWeb(filing.url, `${label} ${filing.label}`);
        emit({ type: "source", chip: { label: `${label} ${filing.label}`, url: filing.url } });
        opened += 1;
        openedLabels.push(`${label} ${filing.label}`);
        step(emit, `Opened ${filing.label}`, "done");
      }
    }
  }

  let transcriptNote = "";
  if (plan.wantsTranscript) {
    if (halt()) return stopped(emit, openedLabels);
    step(emit, `Looking for ${label}'s latest earnings-call transcript`);
    const found = await findTranscripts(label);
    if (halt()) return stopped(emit, openedLabels);
    for (const page of found.pages.slice(0, 1)) {
      openWeb(page.url, page.title);
      emit({ type: "source", chip: { label: page.title, url: page.url } });
      openedLabels.push(page.title);
    }
    if (found.pages.length) {
      transcriptNote = `Opened a public transcript page: ${found.pages[0].title}.`;
      step(emit, transcriptNote, "done");
    } else {
      transcriptNote = found.missing;
      step(emit, transcriptNote, "failed");
    }
  }

  const filingNote = opened
    ? `Opened ${opened} SEC filing${opened === 1 ? "" : "s"} in new tabs.`
    : jobs.length
      ? "No filings matched that request."
      : "";
  const note = [filingNote, transcriptNote].filter(Boolean).join(" ");
  const wantsMore = /\b(summar|highlight|key point|comment on|read (it|them|the)|explain)\b/i.test(text);
  if (!opened && jobs.length && !plan.wantsTranscript) {
    emit({ type: "error", text: "No filings matched that request." });
    return { handled: true, note: "" };
  }
  if (wantsMore) return { handled: false, note };
  if (note) emit({ type: "token", text: note });
  return { handled: true, note };
}

function stopped(emit: (event: AgentEvent) => void, opened: string[]): { handled: boolean; note: string } {
  const note = opened.length
    ? `Stopped. Already opened: ${opened.join(", ")}.`
    : "Stopped before any documents opened.";
  step(emit, note, "done");
  emit({ type: "token", text: note });
  return { handled: true, note };
}
