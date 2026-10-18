import { htmlToText } from "./docs";
import { allowUrl, fetchPublic, isAllowedUrl, sameSiteLinks, untrusted } from "./net";
import { webSearch, type SearchHit } from "./search";
import { logTool } from "./toollog";

export type TranscriptPage = { title: string; url: string; note: string; score: number };

function score(hit: SearchHit): number {
  const host = (() => {
    try {
      return new URL(hit.url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const title = `${hit.title} ${hit.snippet}`.toLowerCase();
  let value = 0;
  if (/transcript/.test(title)) value += 3;
  if (/earnings|quarter|q[1-4]/.test(title)) value += 2;
  if (/investor|ir\.|shareholder|relations/.test(host + title)) value += 6;
  if (host.endsWith("yahoo.com")) value += 4;
  if (/fool\.com|motleyfool|seekingalpha\.com/.test(host)) value -= 8;
  if (/paywall|subscribe to read|sign in to continue/.test(title)) value -= 3;
  return value;
}

function paywalled(hit: SearchHit): boolean {
  return /paywall|subscribe to read|sign in to continue|members only/i.test(`${hit.title} ${hit.snippet}`);
}

export async function findTranscripts(company: string): Promise<{ pages: TranscriptPage[]; paywalled: string[]; missing: string }> {
  const name = company.trim();
  const batches = await Promise.all([
    webSearch(`${name} investor relations earnings call transcript`).catch(() => [] as SearchHit[]),
    webSearch(`${name} earnings call transcript site:finance.yahoo.com`).catch(() => [] as SearchHit[]),
    webSearch(`${name} earnings call transcript quarter`).catch(() => [] as SearchHit[]),
  ]);
  const hits = batches.flat();
  for (const hit of hits) allowUrl(hit.url);
  const paywalledTitles = hits.filter(paywalled).map((hit) => hit.title);
  const ranked = hits
    .filter((hit) => isAllowedUrl(hit.url) && !paywalled(hit))
    .map((hit) => ({ hit, score: score(hit) }))
    .sort((a, b) => b.score - a.score);

  const pages: TranscriptPage[] = [];
  const seen = new Set<string>();
  for (const row of ranked) {
    if (pages.length >= 3) break;
    let url = row.hit.url;
    let title = row.hit.title;
    let note = row.score >= 6 ? "Investor-relations or original host." : row.hit.url.includes("yahoo.com") ? "Yahoo Finance." : "Other publisher.";
    if (row.score >= 6) {
      try {
        const page = await fetchPublic(url, { "User-Agent": "Mozilla/5.0" });
        for (const link of sameSiteLinks(page.text, page.url)) allowUrl(link);
        const better = sameSiteLinks(page.text, page.url).find((link) => /transcript|webcast|earnings/i.test(link));
        if (better) {
          url = better;
          note = "Same-site link from the investor-relations page.";
        }
        if (/subscribe|sign in to read/i.test(page.text.slice(0, 1500))) {
          paywalledTitles.push(title);
          continue;
        }
        title = title || page.url;
      } catch (error) {
        note = error instanceof Error ? error.message : "The page could not be fetched.";
      }
    }
    const key = url.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    pages.push({ title, url, note, score: row.score });
    logTool({ tool: "find_transcript", url, detail: note });
  }
  const missing = pages.length
    ? ""
    : "No public transcript page was found. A pasted transcript can still be opened in the reader.";
  return { pages, paywalled: paywalledTitles.slice(0, 4), missing };
}

export async function passagesFromUrls(urls: string[], words: string[]): Promise<{ url: string; passage: string; missing?: string }[]> {
  const needles = words.map((word) => word.toLowerCase()).filter((word) => word.length > 2);
  const rows = await Promise.all(
    urls.slice(0, 3).map(async (url) => {
      try {
        const page = await fetchPublic(url, { "User-Agent": "Mozilla/5.0" });
        for (const link of sameSiteLinks(page.text, page.url)) allowUrl(link);
        const visible = htmlToText(page.text);
        const loose = page.text.replace(/<[^>]+>/g, " ").replace(/\\n/g, " ");
        const text = needles.every((word) => visible.toLowerCase().includes(word)) ? visible : loose;
        const guarded = untrusted(visible || loose, page.url);
        if (guarded.injected) logTool({ tool: "injection", url: page.url, detail: "Instruction in fetched page text." });
        const hay = text.toLowerCase();
        const at = needles.length ? hay.indexOf(needles[0]) : 0;
        if (needles.length && (at < 0 || !needles.every((word) => hay.includes(word)))) {
          return { url: page.url, passage: "", missing: "No matching passage on this page." };
        }
        const start = Math.max(0, at - 80);
        return { url: page.url, passage: text.slice(start, start + 420) };
      } catch (error) {
        return { url, passage: "", missing: error instanceof Error ? error.message : "Fetch failed." };
      }
    }),
  );
  return rows;
}
