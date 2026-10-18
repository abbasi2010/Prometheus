export function nextWidth(which: "sidebar" | "panel", start: number, delta: number): number {
  const next = which === "sidebar" ? start + delta : start - delta;
  if (which === "sidebar") return Math.min(420, Math.max(180, next));
  return Math.min(560, Math.max(280, next));
}
