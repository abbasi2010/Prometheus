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

const RANGES: Record<string, { range: string; interval: string }> = {
  "1d": { range: "1d", interval: "5m" },
  "5d": { range: "5d", interval: "15m" },
  "1m": { range: "1mo", interval: "1d" },
  "6m": { range: "6mo", interval: "1d" },
  ytd: { range: "ytd", interval: "1d" },
  "1y": { range: "1y", interval: "1d" },
  "5y": { range: "5y", interval: "1wk" },
};

const PEERS: Record<string, string[]> = {
  UBER: ["LYFT", "DASH", "ABNB"],
  LYFT: ["UBER", "DASH", "GRAB"],
  AAPL: ["MSFT", "GOOGL", "SONY"],
  MSFT: ["AAPL", "GOOGL", "AMZN"],
  NVDA: ["AMD", "AVGO", "INTC"],
  AMD: ["NVDA", "INTC", "AVGO"],
  INTC: ["AMD", "NVDA", "QCOM"],
  TSLA: ["GM", "F", "RIVN"],
  AMZN: ["WMT", "SHOP", "GOOGL"],
  WMT: ["AMZN", "TGT", "COST"],
  JNJ: ["PFE", "MRK", "ABT"],
  JPM: ["BAC", "GS", "C"],
  BX: ["KKR", "APO", "BLK"],
  "BRK-B": ["JPM", "BLK", "SPY"],
};

export function peerTickers(ticker: string): string[] {
  return PEERS[ticker.trim().toUpperCase()] || [];
}

export type PricePoint = { t: number; price: number };
export type PriceSeries = {
  ticker: string;
  range: string;
  points: PricePoint[];
  changePercent: number | null;
  asOf?: string;
  name?: string;
  currency?: string;
  price?: number | null;
  marketCap?: number | null;
};

function parseMoney(raw: unknown): number | null {
  const value = Number(String(raw ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

type NasdaqPayload = { data?: { companyName?: string; primaryData?: { lastSalePrice?: string; lastTradeTimestamp?: string }; tradesTable?: { rows?: { date?: string; close?: string }[] } } };

async function nasdaqChart(symbol: string): Promise<ChartResponse> {
  const candidates = [symbol, symbol.replace("-", "."), symbol.replace("-", "/")];
  let payload: NasdaqPayload | null = null;
  let used = symbol;
  for (const candidate of candidates) {
    const end = new Date();
    const start = new Date(end.getTime() - 370 * 24 * 60 * 60 * 1000);
    const from = start.toISOString().slice(0, 10);
    const to = end.toISOString().slice(0, 10);
    const response = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(candidate)}/historical?assetclass=stocks&fromdate=${from}&todate=${to}&limit=400`, {
      headers: { ...UA, Accept: "application/json", Referer: "https://www.nasdaq.com/" },
    });
    if (!response.ok) continue;
    const body = await response.json() as NasdaqPayload;
    if (body?.data?.tradesTable?.rows?.length) {
      payload = body;
      used = candidate;
      break;
    }
  }
  const rows = payload?.data?.tradesTable?.rows || [];
  if (!rows.length) throw new Error(`No prices for ${symbol}.`);
  const ordered = [...rows].reverse();
  const timestamp: number[] = [];
  const close: number[] = [];
  for (const row of ordered) {
    const price = parseMoney(row.close);
    const parts = String(row.date || "").split("/").map(Number);
    if (!price || parts.length !== 3) continue;
    timestamp.push(Date.UTC(parts[2], parts[0] - 1, parts[1]) / 1000);
    close.push(price);
  }
  if (close.length < 2) throw new Error(`No prices for ${symbol}.`);
  const info = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(used)}/info?assetclass=stocks`, {
    headers: { ...UA, Accept: "application/json" },
  }).then((response) => response.ok ? response.json() as Promise<{ data?: { companyName?: string; primaryData?: { lastSalePrice?: string } } }> : null).catch(() => null);
  const lastPrice = parseMoney(info?.data?.primaryData?.lastSalePrice) ?? close.at(-1) ?? null;
  return {
    chart: {
      result: [{
        timestamp,
        meta: {
          longName: info?.data?.companyName || payload?.data?.companyName || symbol,
          regularMarketPrice: lastPrice ?? undefined,
          regularMarketTime: timestamp.at(-1),
        },
        indicators: { quote: [{ close }] },
      }],
    },
  };
}

async function loadChart(symbol: string, range: string, interval: string): Promise<ChartResponse> {
  return cachedJson<ChartResponse>(`chart-${symbol}-${range}-${interval}-v3`, 10 * 60 * 1000, async () => {
    try {
      await ensureCrumb();
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&crumb=${encodeURIComponent(crumb)}`;
      const response = await fetch(url, { headers: { ...UA, Cookie: jar } });
      const text = await response.text();
      if (response.ok && text.trim() && !text.includes("Too Many Requests")) {
        const data = JSON.parse(text) as ChartResponse;
        if (data.chart?.result?.[0]) return data;
      }
    } catch {
      /* Yahoo is often empty or rate-limited. Nasdaq is the fallback. */
    }
    return nasdaqChart(symbol);
  });
}

export async function priceSeries(ticker: string, rangeKey = "1y"): Promise<PriceSeries> {
  const symbol = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,10}$/.test(symbol)) throw new Error(`"${ticker}" is not a ticker.`);
  const choice = RANGES[rangeKey] || RANGES["1y"];
  const data = await loadChart(symbol, choice.range, choice.interval);
  const result = data.chart?.result?.[0];
  if (!result) throw new Error(data.chart?.error?.description || `No prices for ${symbol}.`);
  const closes = result.indicators?.quote?.[0]?.close || [];
  const times = result.timestamp || [];
  const points: PricePoint[] = [];
  for (let i = 0; i < closes.length; i++) {
    const price = closes[i];
    const t = times[i];
    if (typeof price === "number" && typeof t === "number") points.push({ t: t * 1000, price: round(price) || price });
  }
  const step = Math.max(1, Math.floor(points.length / 180));
  const sampled = points.filter((_, index) => index % step === 0 || index === points.length - 1);
  const first = sampled[0]?.price;
  const last = sampled[sampled.length - 1]?.price;
  const changePercent = first != null && last != null && first !== 0 ? Math.round(((last - first) / first) * 1000) / 10 : null;
  const asOf = result.meta?.regularMarketTime ? new Date(result.meta.regularMarketTime * 1000).toISOString().slice(0, 10) : undefined;
  return {
    ticker: symbol,
    range: rangeKey,
    points: sampled,
    changePercent,
    asOf,
    name: result.meta?.longName || result.meta?.shortName || symbol,
    currency: result.meta?.currency,
    price: result.meta?.regularMarketPrice ?? last ?? null,
    marketCap: result.meta?.marketCap ?? null,
  };
}

export async function priceHistory(ticker: string): Promise<Quote> {
  const series = await priceSeries(ticker, "1y");
  const closes = series.points.map((point) => point.price);
  const step = Math.max(1, Math.floor(closes.length / 40));
  return {
    ticker: series.ticker,
    name: series.name,
    price: series.price ?? series.points.at(-1)?.price ?? null,
    currency: series.currency,
    from: series.points[0]?.price ?? null,
    to: series.points.at(-1)?.price ?? null,
    changePercent: series.changePercent,
    closes: closes.filter((_, index) => index % step === 0),
    marketCap: series.marketCap,
    asOf: series.asOf,
  };
}

type ChartResponse = {
  chart?: {
    error?: { description?: string };
    result?: {
      timestamp?: number[];
      meta?: { longName?: string; shortName?: string; regularMarketPrice?: number; currency?: string; regularMarketTime?: number; marketCap?: number };
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
    const extra = await valuation(history.ticker);
    return {
      ...history,
      marketCap: extra.marketCap ?? history.marketCap,
      trailingPE: extra.trailingPE ?? history.trailingPE,
      forwardPE: extra.forwardPE ?? history.forwardPE,
      priceToBook: extra.priceToBook ?? history.priceToBook,
    };
  } catch {
    return history;
  }
}

export async function peerSymbols(ticker: string): Promise<string[]> {
  const symbol = ticker.trim().toUpperCase();
  const fallback = PEERS[symbol] || [];
  try {
    const data = await cachedJson<PeerResponse>(`peers-${symbol}`, 24 * 60 * 60 * 1000, async () => {
      const response = await fetch(
        `https://query2.finance.yahoo.com/v6/finance/recommendationsbysymbol/${encodeURIComponent(symbol)}`,
        { headers: UA },
      );
      if (!response.ok) throw new Error(`Yahoo peers returned ${response.status}`);
      return response.json() as Promise<PeerResponse>;
    });
    const symbols = (data.finance?.result?.[0]?.recommendedSymbols || []).slice(0, 4).map((row) => row.symbol).filter(Boolean);
    return symbols.length ? symbols : fallback;
  } catch {
    return fallback;
  }
}

type PeerResponse = { finance?: { result?: { recommendedSymbols?: { symbol: string }[] }[] } };

export async function compare(ticker: string, extra: string[] = []): Promise<unknown> {
  const base = ticker.trim().toUpperCase();
  const peers = extra.length ? extra.map((item) => item.trim().toUpperCase()).filter(Boolean).slice(0, 4) : await peerSymbols(base);
  const rows: Quote[] = [];
  const symbols = [base, ...peers].slice(0, 5);
  for (let index = 0; index < symbols.length; index++) {
    if (index) await new Promise((resolve) => setTimeout(resolve, 400));
    const symbol = symbols[index];
    try {
      rows.push(await quote(symbol));
    } catch (error) {
      rows.push({ ticker: symbol, error: error instanceof Error ? error.message : "Quote failed." });
    }
  }
  return {
    source: "Yahoo Finance",
    note: "Valuation fields are market cap, trailing P/E, forward P/E, and price to book, when Yahoo returns them.",
    rows,
  };
}
