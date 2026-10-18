import { join } from "path";

/** analyst/ — the folder that contains package.json. Dev bundle lives in out/main. */
export function projectRoot(): string {
  return join(__dirname, "../..");
}

export function repoRoot(): string {
  return join(projectRoot(), "..");
}

export function envPath(): string {
  return join(projectRoot(), ".env");
}

export function dataDir(): string {
  return join(projectRoot(), "data");
}

export function cacheDir(): string {
  return join(dataDir(), "cache");
}
