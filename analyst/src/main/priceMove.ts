import { peerTickers, priceSeries } from "./market";
import { webSearch } from "./search";
import { financials, listAllFilings } from "./sec";

function day(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export async function explainPriceMove(ticker: string): Promise<Record<string, unknown>> {
  const { calculateExpression } = await import("./agent");
  const pctSync = (from: number, to: number) => calculateExpression(`pct(${from},${to})`).result;
  const symbol = ticker.trim().toUpperCase();
  const series = await priceSeries(symbol, "1y");
  const points = series.points;
  if (points.length < 5) return { error: "Yahoo didn't return enough prices to date a move." };
  let peak = 0;
  for (let i = 1; i < points.length; i++) if (points[i].price > points[peak].price) peak = i;
  let trough = peak;
  for (let i = peak + 1; i < points.length; i++) if (points[i].price < points[trough].price) trough = i;
  if (trough === peak) {
    trough = points.length - 1;
    peak = 0;
    for (let i = 1; i < points.length; i++) if (points[i].price > points[peak].price) peak = i;
  }
  const windowChange = pctSync(points[peak].price, points[trough].price);
  let worst = 1;
  let worstPct = 0;
  for (let i = 1; i < points.length; i++) {
    const change = pctSync(points[i - 1].price, points[i].price);
    if (change < worstPct) {
      worstPct = change;
      worst = i;
    }
  }
  const peer = peerTickers(symbol)[0] || "SPY";
  const [market, peerSeries] = await Promise.all([
    priceSeries("SPY", "1y").catch(() => null),
    priceSeries(peer, "1y").catch(() => null),
  ]);
  function windowOf(row: { points: { t: number; price: number }[] } | null): number | null {
    if (!row || row.points.length < 2) return null;
    const start = row.points.find((point) => point.t >= points[peak].t) || row.points[0];
    const end = [...row.points].reverse().find((point) => point.t <= points[trough].t) || row.points[row.points.length - 1];
    if (!start?.price || !end?.price) return null;
    return pctSync(start.price, end.price);
  }
  const filings = await listAllFilings(symbol).catch(() => []);
  const from = day(points[Math.max(0, worst - 3)].t);
  const to = day(points[Math.min(points.length - 1, worst + 5)].t);
  const near = filings.filter((filing) => {
    const date = filing.filingDate || filing.reportDate;
    return date >= from && date <= to;
  }).slice(0, 8);
  const facts = await financials(symbol).catch(() => null) as { facts?: Record<string, { values?: { end: string; value: number }[] }> } | null;
  const changes: { metric: string; from: number; to: number; changePercent: number; period: string }[] = [];
  for (const metric of ["revenue", "net income", "operating cash flow"]) {
    const values = facts?.facts?.[metric]?.values || [];
    if (values.length < 2 || !values[1].value) continue;
    changes.push({
      metric,
      from: values[1].value,
      to: values[0].value,
      changePercent: pctSync(values[1].value, values[0].value),
      period: `${values[1].end} to ${values[0].end}`,
    });
  }
  const news = await webSearch(`${symbol} stock ${day(points[worst].t)}`).catch(() => []);
  const datedNews = news.filter((hit) => !hit.snippet || true).slice(0, 4);
  const unexplained = datedNews.length || near.length
    ? ""
    : `No filing or article I found explains the drop on ${day(points[worst].t)}.`;
  return {
    ticker: symbol,
    window: {
      from: day(points[peak].t),
      to: day(points[trough].t),
      fromPrice: points[peak].price,
      toPrice: points[trough].price,
      changePercent: windowChange,
    },
    largestDay: {
      date: day(points[worst].t),
      from: points[worst - 1].price,
      to: points[worst].price,
      changePercent: worstPct,
    },
    market: { ticker: "SPY", changePercent: windowOf(market) },
    peer: { ticker: peer, changePercent: windowOf(peerSeries) },
    filingsNearLargestDay: near.map((filing) => ({ form: filing.form, date: filing.filingDate || filing.reportDate, title: filing.description || filing.label, url: filing.url })),
    fundamentalChanges: changes,
    news: datedNews.map((hit) => ({ title: hit.title, url: hit.url, kind: hit.kind, snippet: hit.snippet })),
    unexplained,
  };
}
