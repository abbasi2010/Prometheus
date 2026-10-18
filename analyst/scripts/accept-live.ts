import { listFilings, resolveCompany } from "../src/main/sec.ts";
import { findTranscripts, passagesFromUrls } from "../src/main/transcript.ts";
import { quote } from "../src/main/market.ts";

const failures: string[] = [];
function report(name: string, detail: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!ok) failures.push(name);
}

const uber = await resolveCompany("Uber");
report("resolve uber", uber?.ticker || "missing", uber?.ticker === "UBER");

const quarters = await listFilings("UBER", "10-Q", 3);
report(
  "three 10-Qs",
  quarters.map((row) => `${row.form} ${row.reportDate}`).join(", ") || "none",
  quarters.length === 3 && quarters.every((row) => row.form === "10-Q" && row.url.startsWith("https://www.sec.gov/")),
);

const lyft = await resolveCompany("Lyft");
report("resolve lyft", lyft?.ticker || "missing", lyft?.ticker === "LYFT");

const annual = lyft ? await listFilings("LYFT", "10-K", 1) : [];
report("lyft 10-K", annual[0]?.url || "none", Boolean(annual[0]?.url.includes("sec.gov")));

const transcripts = await findTranscripts("Uber");
report(
  "transcript search",
  `${transcripts.pages.length} pages; ${transcripts.missing || transcripts.pages.map((page) => page.url).join(" | ")}`,
  transcripts.pages.length > 0,
);

if (transcripts.pages[0]) {
  const bits = await passagesFromUrls([transcripts.pages[0].url], ["margin"]);
  report("margin passage", bits[0]?.passage?.slice(0, 140) || bits[0]?.missing || "empty", Boolean(bits[0]?.passage || bits[0]?.missing));
}

try {
  const prices = await Promise.all([quote("UBER"), quote("LYFT")]);
  report(
    "valuation quotes",
    prices.map((row) => `${row.ticker} ${row.price} cap ${row.marketCap}`).join("; "),
    prices.every((row) => row.price != null),
  );
} catch (error) {
  report("valuation quotes", error instanceof Error ? error.message : "failed", false);
}

if (failures.length) {
  console.error("failed", failures.join(", "));
  process.exit(1);
}
