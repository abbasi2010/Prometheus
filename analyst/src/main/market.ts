import { cachedJson } from "./cache";
import type { Quote } from "../shared/types";

// The only market-data module. Swap this file to change providers.
const UA = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "application/json",
};

let jar = "";
let crumb = "";
let crumbAt = 0;

function round(value: number | null | undefined): number | null {
  if (value == null || Number.isNaN(value)) return null;
  return Math.round(value * 100) / 100;
}

async function ensureCrumb(): Promise<void> {
  if (crumb && Date.now() - crumbAt < 20 * 60 * 1000) return;
  const home = await fetch("https://fc.yahoo.com", { headers: UA, redirect: "manual" });
  const cookies = typeof home.headers.getSetCookie === "function" ? home.headers.getSetCookie() : [];
  jar = cookies.map((cookie) => cookie.split(";")[0]).join("; ");
  const response = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { ...UA, Cookie: jar },
  });
  crumb = (await response.text()).trim();
  if (!crumb || crumb.includes("<")) throw new Error("Yahoo didn't return a session crumb.");
  crumbAt = Date.now();
}

async function yahooJson(url: string): Promise<unknown> {
  await ensureCrumb();
  const glue = url.includes("?") ? "&" : "?";
  const full = `${url}${glue}crumb=${encodeURIComponent(crumb)}`;
  const response = await fetch(full, { headers: { ...UA, Cookie: jar } });
  if (!response.ok) throw new Error(`Yahoo returned ${response.status}`);
  return response.json();
}

export async function priceHistory(ticker: string): Promise<Quote> {
  const symbol = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,10}$/.test(symbol)) throw new Error(`"${ticker}" is not a ticker.`);
  const data = await cachedJson<ChartResponse>(`chart-${symbol}-1y`, 60 * 1000, async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
    let response = await fetch(url, { headers: UA });
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      response = await fetch(url, { headers: UA });
    }
    if (!response.ok) throw new Error(response.status === 429 ? "Yahoo is rate-limiting price requests. Try again in a moment." : `Yahoo chart returned ${response.status}`);
    return response.json() as Promise<ChartResponse>;
  });
  const result = data.chart?.result?.[0];
  if (!result) throw new Error(data.chart?.error?.description || `No prices for ${symbol}.`);
  const closes = (result.indicators?.quote?.[0]?.close || []).filter((n): n is number => typeof n === "number");
  const first = closes[0];
  const last = closes[closes.length - 1];
  const changePercent = first ? Math.round(((last - first) / first) * 1000) / 10 : null;
  return {
    ticker: symbol,
    name: result.meta?.longName || result.meta?.shortName || symbol,
    price: result.meta?.regularMarketPrice ?? round(last),
    currency: result.meta?.currency,
    from: round(first),
    to: round(last),
    changePercent,
  };
}

type ChartResponse = {
  chart?: {
    error?: { description?: string };
    result?: {
      meta?: { longName?: string; shortName?: string; regularMarketPrice?: number; currency?: string };
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
  };
};

async function valuation(symbol: string): Promise<Pick<Quote, "marketCap" | "trailingPE" | "forwardPE" | "priceToBook">> {
  const data = (await yahooJson(
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`,
  )) as { quoteResponse?: { result?: QuoteRow[] } };
  const row = data.quoteResponse?.result?.[0];
  if (!row) return {};
  return {
    marketCap: row.marketCap ?? null,
    trailingPE: row.trailingPE ?? null,
    forwardPE: row.forwardPE ?? null,
    priceToBook: row.priceToBook ?? null,
  };
}

type QuoteRow = {
  marketCap?: number;
  trailingPE?: number;
  forwardPE?: number;
  priceToBook?: number;
};

export async function quote(ticker: string): Promise<Quote> {
  const history = await priceHistory(ticker);
  try {
    return { ...history, ...(await valuation(history.ticker)) };
  } catch {
    return history;
  }
}

export async function peerSymbols(ticker: string): Promise<string[]> {
  const symbol = ticker.trim().toUpperCase();
  const data = await cachedJson<PeerResponse>(`peers-${symbol}`, 24 * 60 * 60 * 1000, async () => {
    const response = await fetch(
      `https://query2.finance.yahoo.com/v6/finance/recommendationsbysymbol/${encodeURIComponent(symbol)}`,
      { headers: UA },
    );
    if (!response.ok) throw new Error(`Yahoo peers returned ${response.status}`);
    return response.json() as Promise<PeerResponse>;
  });
  return (data.finance?.result?.[0]?.recommendedSymbols || []).slice(0, 4).map((row) => row.symbol);
}

type PeerResponse = { finance?: { result?: { recommendedSymbols?: { symbol: string }[] }[] } };

export async function compare(ticker: string, extra: string[] = []): Promise<unknown> {
  const base = ticker.trim().toUpperCase();
  const peers = extra.length ? extra.map((item) => item.trim().toUpperCase()).filter(Boolean).slice(0, 4) : await peerSymbols(base);
  const rows = await Promise.all(
    [base, ...peers].slice(0, 5).map(async (symbol) => {
      try {
        return await quote(symbol);
      } catch (error) {
        return { ticker: symbol, error: error instanceof Error ? error.message : "Quote failed." };
      }
    }),
  );
  return {
    source: "Yahoo Finance",
    note: "Valuation fields are market cap, trailing P/E, forward P/E, and price to book, when Yahoo returns them.",
    rows,
  };
}
