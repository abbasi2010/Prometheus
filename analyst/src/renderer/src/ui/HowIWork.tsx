import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";

type Note = { id: string; company: string; text: string; at: number };
type Memory = { notes: Note[]; interest: { industries: string[]; metrics: string[]; depth: string; jargon: string; sources: string[] } };

export function HowIWork() {
  const [memory, setMemory] = useState<Memory | null>(null);
  const [draft, setDraft] = useState("");

  async function load() {
    const row = await window.analyst?.memory.get() as Memory | undefined;
    if (row) setMemory(row);
  }

  useEffect(() => { void load(); }, []);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
      <h2 className="text-lg font-medium">How I work</h2>
      <Card>
        <h3 className="text-sm font-medium">Interest profile</h3>
        <p className="mt-2 text-[14px]">{memory?.interest.metrics.length ? memory.interest.metrics.join(", ") : "Nothing learned yet. Tell the agent what you care about."}</p>
        <p className="mt-1 text-[12px] text-muted">Depth {memory?.interest.depth || "standard"} · {memory?.interest.jargon || "plain"} language</p>
      </Card>
      <Card>
        <h3 className="text-sm font-medium">Memory</h3>
        <ul className="mt-2 flex flex-col gap-2">
          {(memory?.notes || []).map((note) => (
            <li key={note.id}>
              <input className="h-8 w-full rounded-[10px] border border-line bg-canvas px-2 text-[13px]" value={note.text} onChange={(event) => {
                const text = event.target.value;
                setMemory((current) => current && { ...current, notes: current.notes.map((item) => item.id === note.id ? { ...item, text } : item) });
              }} onBlur={(event) => void window.analyst?.memory.update(note.id, event.target.value)} />
              <p className="text-[11px] text-muted">{note.company}</p>
            </li>
          ))}
        </ul>
        <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (!draft.trim()) return; void window.analyst?.memory.remember(draft.trim(), "*").then(() => { setDraft(""); void load(); }); }}>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Remember that…" className="h-8 flex-1 rounded-[10px] border border-line bg-canvas px-2 text-[13px]" />
          <Button type="submit" size="sm">Save</Button>
        </form>
      </Card>
    </div>
  );
}
