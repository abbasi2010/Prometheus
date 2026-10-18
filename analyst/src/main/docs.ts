import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { Paragraph, ReaderDoc, Section } from "../shared/types";
import { dataDir } from "./paths";

const memory = new Map<string, ReaderDoc>();

export function rememberDoc(doc: ReaderDoc): ReaderDoc {
  memory.set(doc.id, doc);
  const file = join(dataDir(), "docs", `${doc.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  void mkdir(join(dataDir(), "docs"), { recursive: true }).then(() => writeFile(file, JSON.stringify(doc)));
  return doc;
}

export async function loadDoc(id: string): Promise<ReaderDoc | null> {
  const hit = memory.get(id);
  if (hit) return hit;
  try {
    const file = join(dataDir(), "docs", `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
    const doc = JSON.parse(await readFile(file, "utf8")) as ReaderDoc;
    memory.set(id, doc);
    return doc;
  } catch {
    return null;
  }
}

export function latestDocs(): ReaderDoc[] {
  return [...memory.values()];
}

function paragraphs(sectionId: string, body: string): Paragraph[] {
  const lines = body
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 40);
  const out: Paragraph[] = [];
  let buf = "";
  const flush = () => {
    const text = buf.trim();
    if (text.length > 40) out.push({ id: `${sectionId}-p${out.length + 1}`, text });
    buf = "";
  };
  for (const line of lines) {
    if (buf && buf.length + line.length > 700) flush();
    buf = buf ? `${buf} ${line}` : line;
    if (buf.length > 1400) flush();
  }
  flush();
  return out;
}

function oneSection(id: string, title: string, body: string): Section {
  return { id, title: title.replace(/\s+/g, " ").trim().slice(0, 140), paragraphs: paragraphs(id, body) };
}

function slug(title: string, index: number): string {
  const match = title.match(/item\s+(\d+[a-z]?)/i);
  return match ? `item-${match[1].toLowerCase()}` : `section-${index}`;
}

export function splitSections(text: string): Section[] {
  const marks: { index: number; title: string }[] = [];
  const re = /(?:^|\n)\s*(item\s+\d+[a-z]?\b[^\n]{0,90})/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    marks.push({ index: match.index, title: match[1] });
  }
  if (!marks.length) {
    const only = oneSection("document", "Document", text);
    return only.paragraphs.length ? [only] : [];
  }
  const built: Section[] = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(start, end).replace(/^[^\n]*\n?/, "");
    built.push(oneSection(slug(marks[i].title, i), marks[i].title, body));
  }
  const best = new Map<string, Section>();
  const order: string[] = [];
  for (const section of built) {
    const key = (section.title.match(/item\s+\d+[a-z]?/i) || [section.id])[0].toLowerCase().replace(/\s+/g, "");
    const prev = best.get(key);
    const size = section.paragraphs.reduce((sum, p) => sum + p.text.length, 0);
    const prevSize = prev ? prev.paragraphs.reduce((sum, p) => sum + p.text.length, 0) : -1;
    if (!prev) order.push(key);
    if (!prev || size > prevSize) best.set(key, section);
  }
  return order.map((key) => best.get(key)!).filter((section) => section.paragraphs.length > 0);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|tr|li|table|section|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function docFromText(id: string, title: string, url: string, kind: ReaderDoc["kind"], text: string): ReaderDoc {
  return rememberDoc({ id, title, url, kind, sections: splitSections(text) });
}

export function sectionExcerpt(doc: ReaderDoc, item: string, max = 1500): { section: string; anchor: string; excerpt: string } {
  const wanted = item.replace(/^item\s+/i, "").trim() || "1";
  const section =
    doc.sections.find((s) => new RegExp(`^item\\s+${wanted}\\b`, "i").test(s.title)) ||
    doc.sections.find((s) => new RegExp(`item\\s+${wanted}\\b`, "i").test(s.title)) ||
    doc.sections[0];
  if (!section) return { section: "", anchor: "", excerpt: "" };
  let excerpt = "";
  for (const paragraph of section.paragraphs) {
    if (excerpt.length >= max) break;
    excerpt += (excerpt ? "\n" : "") + paragraph.text;
  }
  return {
    section: section.title,
    anchor: section.paragraphs[0]?.id || section.id,
    excerpt: excerpt.slice(0, max),
  };
}

export function searchDoc(doc: ReaderDoc, query: string): { section: string; anchor: string; passage: string }[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  if (!words.length) return [];
  const hits: { section: string; anchor: string; passage: string }[] = [];
  for (const section of doc.sections) {
    for (const paragraph of section.paragraphs) {
      const hay = paragraph.text.toLowerCase();
      if (!words.every((word) => hay.includes(word))) continue;
      const at = hay.indexOf(words[0]);
      const start = Math.max(0, at - 60);
      hits.push({
        section: section.title,
        anchor: paragraph.id,
        passage: paragraph.text.slice(start, start + 420),
      });
      if (hits.length >= 5) return hits;
    }
  }
  return hits;
}
