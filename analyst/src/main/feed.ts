import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { UNIVERSE } from "../shared/universe";
import { dataDir } from "./paths";
import { priceSeries } from "./market";
import { companyProfile, financials } from "./sec";
import { clearRating, rateTicker, rereadMemory } from "./memory";
import { groqKey } from "./env";
import OpenAI from "openai";
import { llm } from "../shared/config";

export type Features = {
  ticker: string;
  industry: string;
  ret: number | null;
  drawdown: number | null;
  growth: number | null;
  buyback: number | null;
  margin: number | null;
  closes: number[];
  missing: string[];
  story?: string;
  storyScore?: number;
};

type Weights = { bias: number; ret: number; drawdown: number; growth: number; buyback: number; margin: number };
type Cache = { at: number; features: Features[]; weights: Weights; progress: string; dismissed?: string[] };

const PRIOR: Weights = { bias: -0.15, ret: 0.15, drawdown: 0.45, growth: 0.55, buyback: 0.7, margin: 0.4 };
let cache: Cache = { at: 0, features: [], weights: { ...PRIOR }, progress: "Not built yet", dismissed: [] };
let running = false;
let dismissedDirty = false;

function file(): string {
  return join(dataDir(), "feed-cache.json");
}

export async function loadFeed(): Promise<Cache> {
  try {
    cache = { dismissed: [], ...(JSON.parse(await readFile(file(), "utf8")) as Cache) };
  } catch {
    cache = { at: 0, features: [], weights: { ...PRIOR }, progress: "Not built yet" };
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!dismissedDirty) {
    try {
      const onDisk = JSON.parse(await readFile(file(), "utf8")) as Cache;
      cache.dismissed = onDisk.dismissed || cache.dismissed || [];
    } catch {
      cache.dismissed = cache.dismissed || [];
    }
  }
  await mkdir(dataDir(), { recursive: true });
  await writeFile(file(), JSON.stringify(cache));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function percentLabel(value: number): string {
  return `${Math.round(Math.abs(value) * 1000) / 10}%`;
}

function signedPercent(value: number): string {
  const points = Math.round(value * 1000) / 10;
  return `${points > 0 ? "+" : ""}${points}%`;
}

function rankOf(value: number | null, samples: number[]): number {
  if (value == null || !samples.length) return 0.5;
  const below = samples.filter((item) => item < value).length;
  return below / samples.length;
}

function featureVector(row: Features): number[] {
  return [row.drawdown == null ? 0 : -row.drawdown, row.growth ?? 0, row.buyback ?? 0, row.margin ?? 0];
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function scoreOf(row: Features, weights: Weights): number {
  const x = {
    ret: row.ret ?? 0,
    drawdown: row.drawdown ?? 0,
    growth: row.growth ?? 0,
    buyback: row.buyback ?? 0,
    margin: row.margin ?? 0,
  };
  return sigmoid(weights.bias + weights.ret * x.ret + weights.drawdown * x.drawdown + weights.growth * x.growth + weights.buyback * x.buyback + weights.margin * x.margin);
}

export async function ranked(): Promise<{ rows: (Features & { score: number; reasons: string[]; exploring?: boolean })[]; progress: string; at: number; ratings: number }> {
  await loadFeed();
  const state = cache;
  const memory = await rereadMemory();
  const votes = memory.ratings || [];
  const blocked = new Set<string>([
    ...(state.dismissed || []),
    ...votes.filter((vote) => vote.vote === "not" || vote.vote === "known").map((vote) => vote.ticker.toUpperCase()),
  ]);
  const ready = state.features.filter((row) => row.ret != null && (row.closes?.length || 0) > 1 && !blocked.has(row.ticker.toUpperCase()));
  const liked = ready.filter((row) => votes.some((vote) => vote.vote === "interested" && vote.ticker.toUpperCase() === row.ticker.toUpperCase()));
  const prototype = liked.length
    ? featureVector(liked[0]).map((_, index) => liked.reduce((sum, row) => sum + featureVector(row)[index], 0) / liked.length)
    : null;
  const dips = ready.flatMap((row) => (row.drawdown == null ? [] : [-row.drawdown]));
  const growths = ready.flatMap((row) => (row.growth == null ? [] : [row.growth]));
  const buybacks = ready.flatMap((row) => (row.buyback == null ? [] : [row.buyback]));
  const margins = ready.flatMap((row) => (row.margin == null ? [] : [row.margin]));
  const rows = ready.map((row) => {
    const dip = row.drawdown == null ? null : -row.drawdown;
    let score = rankOf(dip, dips) * 0.3 + rankOf(row.growth, growths) * 0.24 + rankOf(row.buyback, buybacks) * 0.2 + rankOf(row.margin, margins) * 0.16;
    if (dip != null && dip > 0.25 && (row.growth ?? 0) > 0) score += 0.12;
    if (prototype) score += Math.max(0, cosine(featureVector(row), prototype)) * 0.16;
    if (memory.interest.metrics.includes("buybacks") && (row.buyback || 0) > 0) score += 0.05;
    if (memory.interest.metrics.includes("per-share growth") && (row.growth || 0) > 0) score += 0.05;
    score = score * 0.8 + scoreOf(row, state.weights) * 0.2;
    score -= [row.growth, row.buyback, row.margin, row.drawdown].filter((item) => item == null).length * 0.05;
    if (row.storyScore != null) score = score * 0.7 + row.storyScore * 0.3;
    const reasons = [
      row.drawdown != null && row.drawdown <= -0.15 ? `Down ${percentLabel(row.drawdown)} from its high` : "",
      row.growth != null ? `Revenue ${row.growth >= 0 ? "up" : "down"} ${percentLabel(row.growth)} year over year` : "",
      row.buyback != null && row.buyback > 0.005 ? `Share count fell ${percentLabel(row.buyback)}` : "",
      row.margin != null ? `Operating margin ${percentLabel(row.margin)}` : "",
      row.ret != null ? `1-year price change ${signedPercent(row.ret)}` : "",
      row.story || "",
    ].filter(Boolean).slice(0, 3);
    if (!reasons.length) reasons.push("Price history is in. The other figures are still missing.");
    return { ...row, score, reasons };
  }).sort((a, b) => b.score - a.score);
  const picked: (typeof rows[number] & { exploring?: boolean })[] = [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const count = counts.get(row.industry) || 0;
    if (count >= 3) continue;
    counts.set(row.industry, count + 1);
    picked.push(row);
    if (picked.length >= 12) break;
  }
  const rest = rows.filter((row) => !picked.some((item) => item.ticker === row.ticker) && row.growth != null && row.margin != null);
  const mid = rest.slice(Math.floor(rest.length / 3));
  for (const extra of mid) {
    if (picked.filter((row) => row.exploring).length >= 3) break;
    if (picked.some((row) => row.industry === extra.industry)) continue;
    picked.push({ ...extra, exploring: true });
  }
  return { rows: picked.slice(0, 15), progress: state.progress, at: state.at, ratings: votes.length };
}

async function oneTicker(ticker: string): Promise<Features> {
  const missing: string[] = [];
  const series = await priceSeries(ticker, "1y").catch(() => null);
  const points = series?.points || [];
  const first = points[0]?.price;
  const last = points.at(-1)?.price;
  const ret = first && last ? last / first - 1 : series?.changePercent != null ? series.changePercent / 100 : null;
  if (ret == null) missing.push("return");
  let peak = points[0]?.price || 0;
  let drawdown: number | null = null;
  for (const point of points) {
    peak = Math.max(peak, point.price);
    if (peak) drawdown = Math.min(drawdown ?? 0, point.price / peak - 1);
  }
  if (drawdown == null) missing.push("drawdown");
  let growth: number | null = null;
  let buyback: number | null = null;
  let margin: number | null = null;
  let industry = "Other";
  try {
    const facts = await financials(ticker) as { facts?: Record<string, { values?: { value: number }[] }> };
    const revenue = facts.facts?.revenue?.values || [];
    if (revenue.length >= 2 && revenue[1].value) growth = revenue[0].value / revenue[1].value - 1;
    else missing.push("growth");
    const income = facts.facts?.["operating income"]?.values?.[0]?.value;
    const sales = revenue[0]?.value;
    if (income != null && sales) {
      const ratio = income / sales;
      if (ratio > -0.6 && ratio < 0.85) margin = ratio;
      else missing.push("margin");
    } else missing.push("margin");
    const shares = facts.facts?.["diluted shares"]?.values || facts.facts?.["shares outstanding"]?.values || [];
    if (shares.length >= 2 && shares[0].value) buyback = 1 - shares[0].value / shares[1].value;
    else missing.push("buyback");
    const profile = await companyProfile(ticker);
    industry = profile.industry === "pc" ? "Property and casualty" : (profile.sicDescription || "Other").split(",")[0].replace(/\bNEC\b/g, "").trim();
  } catch {
    missing.push("financials");
  }
  return { ticker, industry, ret, drawdown, growth, buyback, margin, closes: points.slice(-24).map((point) => point.price), missing };
}

export async function refreshFeed(onProgress?: (text: string) => void, options?: { stories?: boolean }): Promise<void> {
  if (running) return;
  running = true;
  await loadFeed();
  const have = new Set(cache.features.map((row) => row.ticker));
  const todo = UNIVERSE.filter((ticker, index) => UNIVERSE.indexOf(ticker) === index && !have.has(ticker)).slice(0, 100);
  try {
    for (let i = 0; i < todo.length; i++) {
      cache.progress = `Reading ${i + 1} of ${todo.length}`;
      onProgress?.(cache.progress);
      try {
        cache.features.push(await oneTicker(todo[i]));
      } catch {
        cache.features.push({ ticker: todo[i], industry: "Other", ret: null, drawdown: null, growth: null, buyback: null, margin: null, closes: [], missing: ["unavailable"] });
      }
      cache.at = Date.now();
      if (i % 5 === 0) await persist();
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (options?.stories) await qualify();
    cache.progress = "Up to date";
    cache.at = Date.now();
    await persist();
  } finally {
    running = false;
  }
}

async function qualify(): Promise<void> {
  const key = groqKey();
  if (!key) return;
  const top = [...cache.features].sort((a, b) => scoreOf(b, cache.weights) - scoreOf(a, cache.weights)).slice(0, 40);
  const client = new OpenAI({ apiKey: key, baseURL: llm.baseURL });
  for (let i = 0; i < top.length; i += 10) {
    const batch = top.slice(i, i + 10);
    try {
      const response = await client.chat.completions.create({
        model: llm.model,
        temperature: 0.2,
        max_completion_tokens: 700,
        messages: [
          { role: "system", content: "For each ticker return JSON {\"rows\":[{\"ticker\":\"\",\"story\":\"one sentence\",\"score\":0.5}]}. score is 0 to 1 for whether there is an interesting research story. No recommendations." },
          { role: "user", content: batch.map((row) => row.ticker).join(", ") },
        ],
      });
      const raw = response.choices[0]?.message?.content || "";
      const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { rows?: { ticker: string; story: string; score: number }[] };
      for (const item of parsed.rows || []) {
        const row = cache.features.find((feature) => feature.ticker === item.ticker);
        if (!row) continue;
        row.story = item.story;
        row.storyScore = Math.max(0, Math.min(1, Number(item.score) || 0));
      }
    } catch {
      /* stage 3 is optional when the model is rate limited */
    }
  }
}

export async function fillMissingPrices(onProgress?: (text: string) => void): Promise<void> {
  await loadFeed();
  const todo = cache.features.filter((row) => row.ret == null || !(row.closes?.length));
  for (let i = 0; i < todo.length; i++) {
    const row = todo[i];
    cache.progress = `Prices ${i + 1} of ${todo.length}`;
    onProgress?.(cache.progress);
    try {
      const series = await priceSeries(row.ticker, "1y");
      const points = series.points;
      const first = points[0]?.price;
      const last = points.at(-1)?.price;
      if (first && last) {
        row.ret = last / first - 1;
        row.closes = points.slice(-24).map((point) => point.price);
        let peak = points[0].price;
        let drawdown = 0;
        for (const point of points) {
          peak = Math.max(peak, point.price);
          drawdown = Math.min(drawdown, point.price / peak - 1);
        }
        row.drawdown = drawdown;
        row.missing = row.missing.filter((item) => item !== "return" && item !== "drawdown");
      }
    } catch {
      /* leave the row without a return so it stays out of the ranking */
    }
    if (i % 5 === 0) await persist();
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (rowMarginNeedsDrop()) {
    for (const row of cache.features) {
      if (row.margin != null && (row.margin >= 0.85 || row.margin <= -0.6)) {
        row.margin = null;
        if (!row.missing.includes("margin")) row.missing.push("margin");
      }
    }
  }
  cache.progress = todo.length ? "Prices updated" : "Up to date";
  cache.at = Date.now();
  await persist();
}

function rowMarginNeedsDrop(): boolean {
  return cache.features.some((row) => row.margin != null && (row.margin >= 0.85 || row.margin <= -0.6));
}

export async function vote(ticker: string, voteName: "interested" | "not" | "known"): Promise<void> {
  await loadFeed();
  const symbol = ticker.toUpperCase();
  await rateTicker(symbol, voteName);
  if (voteName === "not" || voteName === "known") {
    cache.dismissed = [...new Set([...(cache.dismissed || []), symbol])];
    dismissedDirty = true;
  }
  const row = cache.features.find((item) => item.ticker === symbol);
  if (row) {
    const y = voteName === "interested" ? 1 : voteName === "not" ? 0 : 0.5;
    const pred = scoreOf(row, cache.weights);
    const err = y - pred;
    const lr = 0.15;
    const pull = 0.05;
    const x = { ret: row.ret ?? 0, drawdown: row.drawdown ?? 0, growth: row.growth ?? 0, buyback: row.buyback ?? 0, margin: row.margin ?? 0 };
    cache.weights.bias += lr * err - pull * (cache.weights.bias - PRIOR.bias);
    cache.weights.ret += lr * err * x.ret - pull * (cache.weights.ret - PRIOR.ret);
    cache.weights.drawdown += lr * err * x.drawdown - pull * (cache.weights.drawdown - PRIOR.drawdown);
    cache.weights.growth += lr * err * x.growth - pull * (cache.weights.growth - PRIOR.growth);
    cache.weights.buyback += lr * err * x.buyback - pull * (cache.weights.buyback - PRIOR.buyback);
    cache.weights.margin += lr * err * x.margin - pull * (cache.weights.margin - PRIOR.margin);
  }
  await persist();
}

export async function undoVote(ticker: string): Promise<void> {
  await loadFeed();
  const symbol = ticker.toUpperCase();
  cache.dismissed = (cache.dismissed || []).filter((item) => item !== symbol);
  dismissedDirty = true;
  await clearRating(symbol);
  await persist();
}

export async function resetFeedModel(): Promise<void> {
  await loadFeed();
  cache.weights = { ...PRIOR };
  await persist();
}

export async function screenCompanies(query: string): Promise<Features[]> {
  const state = cache.features.length ? cache : await loadFeed();
  const needle = query.trim().toLowerCase();
  return state.features.filter((row) => !needle || row.ticker.toLowerCase().includes(needle) || row.industry.toLowerCase().includes(needle)).slice(0, 20);
}

export function feedProgress(): string {
  return cache.progress;
}
