import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { percent } from "./format";

const HIDDEN_KEY = "prometheus-feed-hidden";

export function hiddenTickers(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]") as string[];
    return new Set(raw.map((item) => String(item).toUpperCase()));
  } catch {
    return new Set();
  }
}

function writeHidden(tickers: Set<string>): void {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...tickers]));
}

export function hideTickers(tickers: string[]): void {
  const hidden = hiddenTickers();
  for (const ticker of tickers) hidden.add(ticker.toUpperCase());
  writeHidden(hidden);
}

type Row = {
  ticker: string;
  industry: string;
  ret: number | null;
  closes: number[];
  score: number;
  reasons: string[];
  exploring?: boolean;
  missing: string[];
};

export function FeedView({ onOpen, onAsk }: { onOpen: (ticker: string) => void; onAsk: (ticker: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [progress, setProgress] = useState("");
  const [at, setAt] = useState(0);
  const [ratings, setRatings] = useState(0);
  const [toast, setToast] = useState("");
  const [undoTicker, setUndoTicker] = useState("");
  const hidden = useRef(hiddenTickers());
  const passed = useRef(new Set<string>());
  const request = useRef(0);

  function visible(list: Row[]): Row[] {
    return list.filter((row) => !hidden.current.has(row.ticker.toUpperCase()) && !passed.current.has(row.ticker.toUpperCase()));
  }

  async function load() {
    const id = ++request.current;
    const data = await window.analyst?.feed.ranked() as { rows: Row[]; progress: string; at: number; ratings: number } | undefined;
    if (!data || id !== request.current) return;
    setRows(visible(data.rows || []));
    setProgress(data.progress || "");
    setAt(data.at || 0);
    setRatings(data.ratings || 0);
  }

  useEffect(() => {
    let stopped = false;
    let tries = 0;
    void window.analyst?.memory.get().then((memory) => {
      const ratings = (memory as { ratings?: { ticker: string; vote: string }[] } | undefined)?.ratings || [];
      for (const rating of ratings) {
        if (rating.vote === "not" || rating.vote === "known") hidden.current.add(rating.ticker.toUpperCase());
      }
      writeHidden(hidden.current);
      if (!stopped) setRows((current) => visible(current));
    });
    const tick = async () => {
      if (stopped) return;
      await load();
      tries += 1;
      if (tries < 24) window.setTimeout(tick, 5000);
    };
    void tick();
    return () => { stopped = true; };
  }, []);

  async function vote(ticker: string, choice: "interested" | "not" | "known") {
    const symbol = ticker.toUpperCase();
    const id = ++request.current;
    if (choice === "not" || choice === "known") {
      hidden.current.add(symbol);
      writeHidden(hidden.current);
    } else {
      passed.current.add(symbol);
    }
    setRows((current) => current.filter((row) => row.ticker.toUpperCase() !== symbol));
    setUndoTicker(symbol);
    setToast(`${symbol} marked.`);
    const data = await window.analyst?.feed.vote(symbol, choice) as { rows: Row[]; ratings: number } | undefined;
    if (!data || id !== request.current) return;
    setRows(visible(data.rows || []));
    setRatings(data.ratings || ratings);
  }

  async function undo() {
    const symbol = undoTicker;
    if (!symbol) return;
    hidden.current.delete(symbol);
    passed.current.delete(symbol);
    writeHidden(hidden.current);
    setUndoTicker("");
    setToast("");
    const id = ++request.current;
    const data = await window.analyst?.feed.undo?.(symbol) as { rows: Row[]; ratings: number } | undefined;
    if (!data || id !== request.current) return;
    setRows(visible(data.rows || []));
    setRatings(data.ratings || 0);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-6 py-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Feed</h2>
          <p className="mt-1 max-w-[62ch] text-[13px] text-muted">Stocks that may be worth researching. Not a recommendation.</p>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <span>{ratings} ratings</span>
          <span>{at ? `Updated ${new Date(at).toLocaleString()}` : progress || "Cache empty"}</span>
          <Button size="sm" variant="outline" onClick={() => { setProgress("Refreshing…"); void window.analyst?.feed.refresh().then(() => load()); }}>Refresh</Button>
          <Button size="sm" variant="outline" onClick={() => void window.analyst?.feed.reset().then(() => load())}>Reset model</Button>
          <Button size="sm" variant="outline" onClick={() => void window.analyst?.feed.ranked().then((data) => {
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "feed.json";
            link.click();
          })}>Export</Button>
        </div>
      </div>
      {progress && <p className="text-[12px] text-muted">{progress}</p>}
      {toast && (
        <p className="text-[12px] text-accent">
          {toast}{" "}
          {undoTicker && <button type="button" className="underline" onClick={() => void undo()}>Undo</button>}
        </p>
      )}
      {rows.length === 0 && <Card><p className="text-[13px] text-muted">Cards show up once a real 1-year return is in. Names with no price history stay off the list.</p></Card>}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {rows.map((row, index) => (
          <Card key={row.ticker} className="shadow-card">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[12px] text-muted">{index + 1}{row.exploring ? " · Exploring" : ""} · {row.industry}</div>
                <div className="text-lg font-medium">{row.ticker}</div>
                <div className={row.ret != null && row.ret >= 0 ? "num text-gain" : "num text-loss"}>{row.ret == null ? "—" : percent(row.ret * 100)}</div>
              </div>
              <div className="text-right">
                <div className="text-[12px] text-muted">Worth a look</div>
                <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full bg-accent" style={{ width: `${Math.round(row.score * 100)}%` }} />
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              {row.reasons.map((reason, index) => <span key={`${reason}-${index}`} className="rounded-full border border-line px-2 py-0.5 text-[12px] text-muted">{reason}</span>)}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void vote(row.ticker, "interested")}>Interested</Button>
              <Button size="sm" variant="outline" onClick={() => void vote(row.ticker, "not")}>Not interested</Button>
              <Button size="sm" variant="outline" onClick={() => void vote(row.ticker, "known")}>Already know it</Button>
              <Button size="sm" onClick={() => onOpen(row.ticker)}>Open</Button>
              <Button size="sm" variant="outline" onClick={() => onAsk(row.ticker)}>Ask agent</Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
