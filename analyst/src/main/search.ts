import { cachedJson } from "./cache";
import { tavilyKey } from "./env";

export type SearchHit = { title: string; url: string; snippet: string; kind: string };

export function kindOf(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "news";
  }
  if (host.endsWith("sec.gov")) return "filing";
  if (/(^|\.)reddit\.com$|(^|\.)x\.com$|(^|\.)twitter\.com$|(^|\.)stocktwits\.com$/.test(host)) return "social";
  if (/seekingalpha\.com|tipranks\.com|zacks\.com|morningstar\.com/.test(host)) return "analyst";
  if (/substack\.com|medium\.com|blogspot\.|wordpress\.com/.test(host)) return "opinion";
  return "news";
}

const ALLOWANCE = "Tavily's free search allowance has run out. Saved searches still open. Wait for the allowance to reset, then try again.";

async function fetchTavily(query: string): Promise<SearchHit[]> {
  const key = tavilyKey();
  if (!key) throw new Error("Set TAVILY_API_KEY in analyst/.env and restart the app.");
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: "basic",
      max_results: 6,
      include_answer: false,
    }),
  });
  if (response.status === 429 || response.status === 432 || response.status === 433) throw new Error(ALLOWANCE);
  if (!response.ok) {
    const detail = await response.text();
    if (/quota|usage limit|plan limit|allowance|exceed/i.test(detail)) throw new Error(ALLOWANCE);
    throw new Error(`Tavily returned ${response.status}`);
  }
  const data = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results || [])
    .filter((row) => row.url)
    .map((row) => ({
      title: String(row.title || row.url).slice(0, 180),
      url: String(row.url),
      snippet: String(row.content || "").replace(/\s+/g, " ").trim().slice(0, 400),
      kind: kindOf(String(row.url)),
    }));
}

export async function webSearch(query: string): Promise<SearchHit[]> {
  const key = query.trim().toLowerCase();
  return cachedJson(`tavily:${key}`, 12 * 60 * 60 * 1000, () => fetchTavily(query.trim()));
}
