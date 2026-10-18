import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { dataDir } from "./paths";

export type ToolLogRow = { at: number; tool: string; url?: string; detail?: string };

let writing: Promise<void> = Promise.resolve();

export function logTool(row: Omit<ToolLogRow, "at">): void {
  const entry: ToolLogRow = { at: Date.now(), tool: row.tool, url: row.url, detail: row.detail?.slice(0, 300) };
  writing = writing.then(async () => {
    const dir = dataDir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, "tool-log.json");
    let rows: ToolLogRow[] = [];
    try {
      rows = JSON.parse(await readFile(file, "utf8")) as ToolLogRow[];
    } catch {
      rows = [];
    }
    rows.push(entry);
    if (rows.length > 500) rows = rows.slice(-500);
    await writeFile(file, JSON.stringify(rows));
  });
}
