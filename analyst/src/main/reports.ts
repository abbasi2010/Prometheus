import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { Chip } from "../shared/types";
import { dataDir } from "./paths";

export type Report = {
  id: string;
  company: string;
  title: string;
  question: string;
  bottomLine: string;
  findings: { text: string; chips: Chip[] }[];
  evidence: { metric: string; period: string; value: string; source: string; url?: string }[];
  counter: string;
  unclear: string;
  followUps: string[];
  at: number;
};

let reports: Report[] = [];
let loaded = false;

async function file(): Promise<string> {
  await mkdir(dataDir(), { recursive: true });
  return join(dataDir(), "reports.json");
}

async function ensure(): Promise<void> {
  if (loaded) return;
  try {
    reports = JSON.parse(await readFile(await file(), "utf8")) as Report[];
  } catch {
    reports = [];
  }
  loaded = true;
}

async function persist(): Promise<void> {
  await writeFile(await file(), JSON.stringify(reports));
}

export async function listReports(company?: string): Promise<Report[]> {
  await ensure();
  const key = company?.trim().toUpperCase();
  return reports.filter((report) => !key || report.company === key).sort((a, b) => b.at - a.at);
}

export async function getReport(id: string): Promise<Report | null> {
  await ensure();
  return reports.find((report) => report.id === id) || null;
}

export async function saveReport(report: Report): Promise<Report> {
  await ensure();
  const index = reports.findIndex((item) => item.id === report.id);
  if (index >= 0) reports[index] = report;
  else reports.push(report);
  await persist();
  return report;
}

export function parseReport(company: string, title: string, question: string, text: string, chips: Chip[]): Report {
  const section = (name: string) => {
    const match = text.match(new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n(?:Bottom line|Findings|Evidence|Counter-evidence|Not found|Follow-ups):|$)`, "i"));
    return (match?.[1] || "").trim();
  };
  const lines = (block: string) => block.split("\n").map((line) => line.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
  const evidence = lines(section("Evidence")).map((line) => {
    const [metric, period, value, source] = line.split("|").map((part) => part.trim());
    const chip = chips.find((item) => source && item.label.toLowerCase().includes(source.toLowerCase().slice(0, 18)));
    return { metric: metric || line, period: period || "", value: value || "", source: source || chip?.label || "", url: chip?.url };
  });
  const findings = lines(section("Findings")).map((line, index) => ({ text: line, chips: chips[index] ? [chips[index]] : chips.slice(0, 1) }));
  return {
    id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    company: company.trim().toUpperCase(),
    title,
    question,
    bottomLine: section("Bottom line") || text.slice(0, 400),
    findings,
    evidence,
    counter: section("Counter-evidence"),
    unclear: section("Not found"),
    followUps: lines(section("Follow-ups")),
    at: Date.now(),
  };
}
