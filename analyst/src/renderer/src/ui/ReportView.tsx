import { useState } from "react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";

export type ReportDoc = {
  id: string;
  company: string;
  title: string;
  question: string;
  bottomLine: string;
  findings: { text: string; chips: { label: string; url?: string }[] }[];
  evidence: { metric: string; period: string; value: string; source: string; url?: string }[];
  counter: string;
  unclear: string;
  followUps: string[];
  at: number;
};

export function ReportView({ report, onChange, onOpen, onDiscuss, onPin }: {
  report: ReportDoc;
  onChange: (report: ReportDoc) => void;
  onOpen: (url: string, label: string) => void;
  onDiscuss: () => void;
  onPin: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <article className="reader min-h-0 flex-1 overflow-auto px-8 py-6">
      <div className="mx-auto max-w-[72ch]">
        <p className="text-[12px] uppercase tracking-wide text-muted">{report.company}</p>
        {editing ? <input value={report.title} onChange={(event) => onChange({ ...report, title: event.target.value })} className="mt-1 w-full rounded-[12px] border border-line bg-card px-2 py-1 text-lg" /> : <h2 className="mt-1 text-2xl">{report.title}</h2>}
        <p className="mt-2 text-[14px] text-muted">{report.question}</p>
        <Card className="mt-4 shadow-card">
          <h3 className="text-sm font-medium">Bottom line</h3>
          {editing ? <textarea value={report.bottomLine} onChange={(event) => onChange({ ...report, bottomLine: event.target.value })} className="mt-2 min-h-24 w-full rounded-[12px] border border-line bg-canvas p-2 text-[15px]" /> : <p className="mt-2 text-[16px] leading-7">{report.bottomLine}</p>}
        </Card>
        <h3 className="mt-6 text-sm font-medium">Findings</h3>
        <ul className="mt-2 flex flex-col gap-3">
          {report.findings.map((finding, index) => (
            <li key={index}>
              <p>{finding.text}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {finding.chips.map((chip) => <button key={chip.label} type="button" className="rounded-full border border-line px-2 py-0.5 text-[12px] text-accent" onClick={() => chip.url && onOpen(chip.url, chip.label)}>{chip.label}</button>)}
              </div>
            </li>
          ))}
        </ul>
        <h3 className="mt-6 text-sm font-medium">Evidence</h3>
        <table className="mt-2 w-full text-left text-[14px]">
          <thead className="text-muted"><tr><th>Metric</th><th>Period</th><th>Value</th><th>Source</th></tr></thead>
          <tbody>
            {report.evidence.map((row) => (
              <tr key={`${row.metric}-${row.period}`} className="border-t border-line">
                <td className="py-1">{row.metric}</td>
                <td>{row.period}</td>
                <td className="num">{row.value}</td>
                <td>{row.url ? <button type="button" className="text-accent" onClick={() => onOpen(row.url || "", row.source)}>{row.source}</button> : row.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 className="mt-6 text-sm font-medium">Counter-evidence</h3>
        <p className="mt-1">{report.counter || "—"}</p>
        <h3 className="mt-6 text-sm font-medium">Not found / unclear</h3>
        <p className="mt-1">{report.unclear || "—"}</p>
        <h3 className="mt-6 text-sm font-medium">Follow-ups</h3>
        <ul className="mt-1 list-disc pl-5">{report.followUps.map((item) => <li key={item}>{item}</li>)}</ul>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing((value) => !value)}>{editing ? "Done editing" : "Edit"}</Button>
          <Button variant="outline" size="sm" onClick={onPin}>Add to Notebook</Button>
          <Button variant="outline" size="sm" onClick={onDiscuss}>Discuss</Button>
          <Button variant="outline" size="sm" onClick={() => {
            const markdown = `# ${report.title}\n\n${report.bottomLine}\n`;
            const blob = new Blob([markdown], { type: "text/markdown" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `${report.company}-report.md`;
            link.click();
          }}>Export Markdown</Button>
        </div>
      </div>
    </article>
  );
}
