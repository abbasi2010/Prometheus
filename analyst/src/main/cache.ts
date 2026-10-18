import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { cacheDir } from "./paths";

type Saved<T> = { at: number; body: T };

export async function cachedJson<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const file = join(cacheDir(), `${createHash("sha1").update(key).digest("hex")}.json`);
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as Saved<T>;
    if (!ttlMs || Date.now() - saved.at < ttlMs) return saved.body;
  } catch {
    /* miss */
  }
  const body = await load();
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(file, JSON.stringify({ at: Date.now(), body }));
  return body;
}
