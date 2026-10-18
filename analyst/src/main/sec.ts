import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { cachedJson } from "./cache";
import { docFromText, htmlToText, loadDoc, sectionExcerpt } from "./docs";
import { secHeaders } from "./env";
import { repoRoot } from "./paths";
import type { FilingLink, ReaderDoc } from "../shared/types";

type Company = { cik: number; ticker: string; title: string };

const METRICS: Record<string, string[]> = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
  "net income": ["NetIncomeLoss"],
  "gross profit": ["GrossProfit"],
  "operating income": ["OperatingIncomeLoss"],
  eps: ["EarningsPerShareDiluted", "EarningsPerShareBasic"],
  "current assets": ["AssetsCurrent"],
  "current liabilities": ["LiabilitiesCurrent"],
  assets: ["Assets"],
  cash: ["CashAndCashEquivalentsAtCarryingValue"],
  "long-term debt": ["LongTermDebtNoncurrent", "LongTermDebt"],
  "operating cash flow": ["NetCashProvidedByUsedInOperatingActivities"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment"],
  "diluted shares": ["WeightedAverageNumberOfDilutedSharesOutstanding"],
  equity: ["StockholdersEquity"],
  "net premiums earned": ["PremiumsEarnedNet"],
  losses: ["LossesAndLossAdjustmentExpenses"],
  "investment income": ["InvestmentIncomeNet", "InvestmentIncomeInterestAndDividend"],
};

let companies: Company[] | null = null;
let nextSecAt = 0;

function norm(text: string): string {
  let value = (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const suffix of ["incorporated", "corporation", "company", "inc", "corp", "ltd", "plc", "llc", "co"]) {
    if (value.endsWith(suffix) && value.length > suffix.length + 2) value = value.slice(0, -suffix.length);
  }
  return value;
}

function similar(a: string, b: string): number {
  if (!a || !b) return 0;
  const counts = new Map<string, number>();
  for (const ch of a) counts.set(ch, (counts.get(ch) || 0) + 1);
  let hit = 0;
  for (const ch of b) {
    const n = counts.get(ch) || 0;
    if (n > 0) {
      hit += 1;
      counts.set(ch, n - 1);
    }
  }
  return (2 * hit) / (a.length + b.length);
}

async function secFetch(url: string): Promise<Response> {
  const wait = Math.max(0, nextSecAt - Date.now());
  nextSecAt = Date.now() + wait + 160;
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  const response = await fetch(url, { headers: secHeaders() });
  if (!response.ok) throw new Error(`SEC returned ${response.status} for ${url}`);
  return response;
}

export async function loadCompanies(): Promise<Company[]> {
  if (companies) return companies;
  const file = join(repoRoot(), "cache", "sec_tickers.json");
  try {
    companies = JSON.parse(await readFile(file, "utf8")) as Company[];
    return companies;
  } catch {
    const response = await secFetch("https://www.sec.gov/files/company_tickers.json");
    const raw = (await response.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;
    companies = Object.values(raw).map((row) => ({
      cik: Number(row.cik_str),
      ticker: row.ticker,
      title: row.title,
    }));
    await mkdir(join(repoRoot(), "cache"), { recursive: true });
    await writeFile(file, JSON.stringify(companies));
    return companies;
  }
}

export async function searchCompanies(query: string, limit = 8): Promise<{ ticker: string; title: string }[]> {
  const text = query.trim();
  if (text.length < 1) return [];
  const wanted = norm(text);
  const rows = await loadCompanies();
  const scored: { score: number; ticker: string; title: string }[] = [];
  const lower = text.toLowerCase();
  for (const row of rows) {
    const ticker = row.ticker.toUpperCase();
    const titleNorm = norm(row.title);
    const tickerNorm = norm(ticker);
    let score = 0;
    if (tickerNorm === wanted || titleNorm === wanted) score = 100;
    else if (tickerNorm.startsWith(wanted)) score = 90;
    else if (titleNorm.startsWith(wanted)) score = 80;
    else if (row.title.toLowerCase().includes(lower)) score = 70;
    else if (wanted.length > 2 && titleNorm.includes(wanted)) score = 60;
    if (score) scored.push({ score, ticker, title: row.title });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker))
    .slice(0, limit)
    .map((row) => ({ ticker: row.ticker, title: row.title }));
}

export async function resolveCompany(name: string): Promise<Company | null> {
  const wanted = norm(name);
  if (wanted.length < 1) return null;
  const rows = await loadCompanies();
  const tickerHit = rows.find((row) => norm(row.ticker) === wanted);
  if (tickerHit) return tickerHit;
  const titleHit = rows.find((row) => norm(row.title) === wanted);
  if (titleHit) return titleHit;
  let best: { score: number; row: Company } | null = null;
  for (const row of rows) {
    const title = norm(row.title);
    let score = 0;
    if (title.startsWith(wanted) || (wanted.startsWith(title) && title.length > 3)) {
      score = 0.9 + Math.min(title.length, wanted.length) / Math.max(title.length, wanted.length) * 0.09;
    } else if (wanted.length > 4) {
      score = similar(wanted, title);
    }
    if (!best || score > best.score) best = { score, row };
  }
  return best && best.score >= 0.86 ? best.row : null;
}

function quarter(reportDate: string): string {
  const month = Number(reportDate.slice(5, 7));
  if (month < 1 || month > 12) return "";
  return `Q${Math.floor((month - 1) / 3) + 1} `;
}

function formOf(form: string): string {
  const upper = (form || "10-K").toUpperCase();
  if (upper.includes("Q")) return "10-Q";
  if (upper.includes("K")) return "10-K";
  return upper;
}

type RecentBlock = {
  form?: string[];
  reportDate?: string[];
  filingDate?: string[];
  accessionNumber?: string[];
  primaryDocument?: string[];
  primaryDocDescription?: string[];
};

const FORM_COPY: Record<string, string> = {
  "10-K": "Annual report",
  "10-K/A": "Annual report amendment",
  "10-Q": "Quarterly report",
  "10-Q/A": "Quarterly report amendment",
  "8-K": "Current report",
  "8-K/A": "Current report amendment",
  "DEF 14A": "Proxy statement",
  "DEFA14A": "Additional proxy materials",
  "PRE 14A": "Preliminary proxy",
  "S-1": "Registration statement",
  "S-1/A": "Registration statement amendment",
  "20-F": "Annual report (foreign private issuer)",
  "20-F/A": "Annual report amendment (foreign private issuer)",
  "6-K": "Current report (foreign private issuer)",
  "40-F": "Annual report (Canadian issuer)",
  "3": "Initial insider ownership",
  "4": "Insider transaction",
  "5": "Annual insider ownership",
};

function describeForm(form: string): string {
  return FORM_COPY[form] || FORM_COPY[form.toUpperCase()] || form;
}

function bucketOf(form: string): FilingLink["bucket"] {
  const upper = form.toUpperCase();
  if (upper === "3" || upper === "4" || upper === "5" || /^(3|4|5)\//.test(upper)) return "insider";
  if (upper.startsWith("10-K") || upper.startsWith("20-F") || upper.startsWith("40-F")) return "annual";
  if (upper.startsWith("10-Q") || upper.startsWith("6-K")) return "quarterly";
  if (upper.startsWith("8-K")) return "current";
  if (upper.includes("14A")) return "proxy";
  return "other";
}

function rowsFrom(block: RecentBlock | undefined, cik: number): FilingLink[] {
  if (!block?.form || !block.accessionNumber || !block.primaryDocument) return [];
  const rows: FilingLink[] = [];
  for (let i = 0; i < block.form.length; i++) {
    const form = String(block.form[i] || "").trim();
    const accessionRaw = block.accessionNumber[i];
    const primary = block.primaryDocument[i];
    if (!form || !accessionRaw || !primary) continue;
    const filingDate = String(block.filingDate?.[i] || "");
    const reportDate = String(block.reportDate?.[i] || filingDate);
    const accession = String(accessionRaw).replace(/-/g, "");
    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/${primary}`;
    const description = describeForm(form);
    rows.push({
      label: `${form} · ${description}`,
      url,
      form,
      reportDate,
      filingDate,
      description,
      bucket: bucketOf(form),
    });
  }
  return rows;
}

export async function listAllFilings(companyName: string): Promise<FilingLink[]> {
  const row = await resolveCompany(companyName);
  if (!row) throw new Error(`Couldn't find ${companyName} in the SEC company list.`);
  const cik = String(row.cik).padStart(10, "0");
  const data = await cachedJson<Submissions>(`submissions-${cik}`, 10 * 60 * 1000, async () => {
    const response = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
    return response.json() as Promise<Submissions>;
  });
  const blocks: RecentBlock[] = [];
  if (data.filings?.recent) blocks.push(data.filings.recent);
  for (const file of (data.filings?.files || []).slice(0, 3)) {
    if (!file.name) continue;
    const extra = await cachedJson<RecentBlock & { filings?: { recent?: RecentBlock } }>(`submissions-${file.name}`, 6 * 60 * 60 * 1000, async () => {
      const response = await secFetch(`https://data.sec.gov/submissions/${file.name}`);
      return response.json() as Promise<RecentBlock>;
    });
    blocks.push(extra.filings?.recent || extra);
  }
  const seen = new Set<string>();
  return blocks
    .flatMap((block) => rowsFrom(block, row.cik))
    .filter((filing) => {
      if (seen.has(filing.url)) return false;
      seen.add(filing.url);
      return true;
    })
    .sort((a, b) => String(b.filingDate || b.reportDate).localeCompare(String(a.filingDate || a.reportDate)));
}

export async function listFilings(companyName: string, form = "10-K", count = 6, year = ""): Promise<FilingLink[]> {
  const row = await resolveCompany(companyName);
  if (!row) throw new Error(`Couldn't find ${companyName} in the SEC company list.`);
  const cik = String(row.cik).padStart(10, "0");
  const data = await cachedJson<Submissions>(`submissions-${cik}`, 10 * 60 * 1000, async () => {
    const response = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
    return response.json() as Promise<Submissions>;
  });
  const recent = data.filings?.recent;
  if (!recent?.form || !recent.accessionNumber || !recent.primaryDocument) return [];
  const want = formOf(form);
  const n = Math.max(1, Math.min(6, Number(count) || 1));
  const found: FilingLink[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < (recent.form || []).length; i++) {
    if (recent.form[i] !== want) continue;
    const report = String(recent.reportDate?.[i] || recent.filingDate?.[i] || "");
    if (year && !report.startsWith(String(year))) continue;
    const dedupe = want === "10-K" && n > 1 ? report.slice(0, 4) : String(recent.accessionNumber[i]);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const accession = String(recent.accessionNumber[i]).replace(/-/g, "");
    const primary = recent.primaryDocument[i];
    const url = `https://www.sec.gov/Archives/edgar/data/${row.cik}/${accession}/${primary}`;
    const label = want === "10-K" ? `${report.slice(0, 4)} 10-K` : `${report.slice(0, 4)} ${quarter(report)}10-Q`.replace(/\s+/g, " ").trim();
    found.push({ label, url, form: want, reportDate: report });
    if (found.length >= n) break;
  }
  return found;
}

type Submissions = {
  sic?: string;
  sicDescription?: string;
  filings?: {
    recent?: RecentBlock;
    files?: { name: string; filingCount?: number }[];
  };
};

export async function companyProfile(companyName: string): Promise<{ sic: string; sicDescription: string; industry: "pc" | "generic" }> {
  const row = await resolveCompany(companyName);
  if (!row) throw new Error(`Couldn't find ${companyName} in the SEC company list.`);
  const cik = String(row.cik).padStart(10, "0");
  const data = await cachedJson<Submissions>(`submissions-${cik}`, 10 * 60 * 1000, async () => {
    const response = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
    return response.json() as Promise<Submissions>;
  });
  const sic = String(data.sic || "");
  const sicDescription = String(data.sicDescription || "");
  const industry = sic.startsWith("633") || /property.{0,12}casualty/i.test(sicDescription) ? "pc" : "generic";
  return { sic, sicDescription, industry };
}

export async function documentFromUrl(url: string, title: string): Promise<ReaderDoc> {
  const id = `filing-${Buffer.from(url).toString("base64url").slice(0, 40)}`;
  const existing = await loadDoc(id);
  if (existing) return existing;
  const html = await cachedJson<string>(`html-${url}`, 0, async () => {
    const response = await secFetch(url);
    return response.text();
  });
  return docFromText(id, title, url, "filing", htmlToText(html));
}

export async function openFilingSet(companyName: string, form = "10-K", count = 1, year = "", item = ""): Promise<{
  docs: ReaderDoc[];
  forModel: unknown;
}> {
  const filings = await listFilings(companyName, form, count, year);
  if (!filings.length) throw new Error(`No ${formOf(form)} found for ${companyName}.`);
  const docs: ReaderDoc[] = [];
  const packed = [];
  for (const filing of filings) {
    const doc = await documentFromUrl(filing.url, `${companyName} ${filing.label}`);
    docs.push(doc);
    const piece = sectionExcerpt(doc, item || "1", 1200);
    packed.push({
      label: filing.label,
      url: filing.url,
      docId: doc.id,
      reportDate: filing.reportDate,
      sections: doc.sections.map((section) => section.title).slice(0, 16),
      ...piece,
    });
  }
  return {
    docs,
    forModel: {
      note: "Excerpts only. The full filing is in the reader, not in this payload.",
      filings: packed,
    },
  };
}

type FactRow = { fy?: string; end?: string; val?: number; fp?: string; form?: string };

export async function financials(companyName: string): Promise<unknown> {
  const row = await resolveCompany(companyName);
  if (!row) throw new Error(`Couldn't find ${companyName} in the SEC company list.`);
  const cik = String(row.cik).padStart(10, "0");
  const facts = await cachedJson<CompanyFacts>(`facts-${cik}`, 24 * 60 * 60 * 1000, async () => {
    const response = await secFetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
    return response.json() as Promise<CompanyFacts>;
  });
  const gaap = facts.facts?.["us-gaap"] || {};
  const out: Record<string, { concept: string; unit: string; values: { fy: string; end: string; value: number }[] }> = {};
  for (const [label, names] of Object.entries(METRICS)) {
    for (const name of names) {
      const units = gaap[name]?.units || {};
      const unit = units.USD ? "USD" : units["USD/shares"] ? "USD/shares" : Object.keys(units)[0];
      if (!unit) continue;
      const annual = (units[unit] || [])
        .filter((item) => item.fp === "FY" && /^(10-K|20-F|40-F)/.test(String(item.form || "")))
        .sort((a, b) => String(b.end || "").localeCompare(String(a.end || "")));
      const seen = new Set<string>();
      const values = [];
      for (const item of annual) {
        const fy = String(item.fy || String(item.end || "").slice(0, 4));
        if (!fy || seen.has(fy) || item.val == null) continue;
        seen.add(fy);
        values.push({ fy, end: String(item.end || ""), value: item.val });
        if (values.length >= 5) break;
      }
      if (values.length) {
        out[label] = { concept: name, unit, values };
        break;
      }
    }
  }
  const dei = facts.facts?.dei?.EntityCommonStockSharesOutstanding?.units || {};
  const shareUnit = Object.keys(dei)[0];
  if (shareUnit) {
    const rows = [...(dei[shareUnit] || [])].sort((a, b) => String(b.end || "").localeCompare(String(a.end || "")));
    const values = [];
    const seen = new Set<string>();
    for (const item of rows) {
      const end = String(item.end || "");
      if (!end || seen.has(end) || item.val == null) continue;
      seen.add(end);
      values.push({ fy: String(item.fy || end.slice(0, 4)), end, value: item.val });
      if (values.length >= 8) break;
    }
    if (values.length) out["shares outstanding"] = { concept: "EntityCommonStockSharesOutstanding", unit: shareUnit, values };
  }
  return { company: row.title, ticker: row.ticker, source: "SEC company facts (10-K)", facts: out };
}

type CompanyFacts = {
  facts?: Record<string, Record<string, { units?: Record<string, FactRow[]> }>>;
};
