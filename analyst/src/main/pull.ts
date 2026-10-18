import type { AgentEvent } from "../shared/types";
import { resolveCompany, listFilings } from "./sec";
import { openWeb } from "./tabs";

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function countFrom(word: string, fallback: number): number {
  const n = Number(word);
  if (Number.isFinite(n) && n > 0) return Math.min(6, Math.floor(n));
  return WORDS[word.toLowerCase()] ?? fallback;
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

/** When the user asks to open filings, don't wait on the model. */
export function parsePull(text: string): PullPlan | null {
  const lower = text.toLowerCase();
  const wantsK = /\b10\s*-?\s*k\b|\bannual report/.test(lower);
  const wantsQ = /\b10\s*-?\s*q\b|\bquarterly report/.test(lower);
  const wantsTranscript = /\bearnings call\b|\btranscript\b/.test(lower);
  if (!wantsK && !wantsQ && !wantsTranscript) return null;
  if (!/\b(give|pull|open|get|show|bring|fetch|load)\b/i.test(text) && !wantsK && !wantsQ) {
    if (!wantsTranscript || (!wantsK && !wantsQ)) return null;
  }
  let q = 0;
  const qNum = lower.match(/\blast\s+(\d+|one|two|three|four|five|six)\s+10\s*-?\s*qs?\b/);
  if (wantsQ) q = qNum ? countFrom(qNum[1], 3) : lower.match(/\b10\s*-?\s*qs?\b/) ? 3 : 1;
  let k = wantsK ? 1 : 0;
  const kNum = lower.match(/\blast\s+(\d+|one|two|three)\s+10\s*-?\s*ks?\b/);
  if (kNum) k = countFrom(kNum[1], 1);
  if (!k && !q && wantsTranscript) return null;
  return { k, q, wantsTranscript };
}

export async function runPull(
  text: string,
  companyTicker: string,
  emit: (event: AgentEvent) => void,
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

  emit({ type: "progress", text: `Fetching ${jobs.map((j) => j.label).join(" and ")} for ${row.title}…` });

  let opened = 0;
  for (const job of jobs) {
    const filings = await listFilings(label, job.form, job.count);
    for (const filing of filings) {
      emit({ type: "progress", text: `Opening ${filing.label}…` });
      openWeb(filing.url);
      emit({ type: "source", chip: { label: `${label} ${filing.label}`, url: filing.url } });
      opened += 1;
    }
  }

  let note = "";
  if (opened) {
    note = `Opened ${opened} SEC filing${opened === 1 ? "" : "s"} in new tabs. Use the tab strip above the page to switch between them.`;
    emit({ type: "token", text: note });
  } else {
    emit({ type: "error", text: "No filings matched that request." });
  }

  if (plan.wantsTranscript) {
    const extra =
      " Earnings call transcripts aren't available from the free sources in this app. Paste the transcript in the box on the left under \"Paste a transcript or note\" and it will open in the reader like any other source.";
    emit({ type: "token", text: extra });
    note += extra;
  }

  return { handled: true, note };
}
