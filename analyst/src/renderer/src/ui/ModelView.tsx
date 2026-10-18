import { useMemo, useState } from "react";
import { impliedValue, project, sensitivity, type ModelInputs } from "../../../shared/model";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { money } from "./format";

export type Assumption = { id: string; name: string; value: number; unit: string; source: string };

export function ModelView({ assumptions, onAssumption, inputs, year, onInputs }: {
  assumptions: Assumption[];
  onAssumption: (row: Assumption) => void;
  inputs: ModelInputs;
  year: number;
  onInputs: (inputs: ModelInputs) => void;
}) {
  const years = useMemo(() => project(inputs, year), [inputs, year]);
  const value = impliedValue(years, inputs);
  const table = useMemo(() => sensitivity(inputs, year), [inputs, year]);
  const [discount, setDiscount] = useState(inputs.discount == null ? "" : String(inputs.discount));
  const [multiple, setMultiple] = useState(inputs.multiple == null ? "" : String(inputs.multiple));

  function setGrowth(index: number, raw: string) {
    const growth = [...inputs.growth];
    growth[index] = Number(raw) / 100;
    onInputs({ ...inputs, growth });
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
      <h2 className="text-lg font-medium">Model</h2>
      <p className="mt-1 text-[13px] text-muted">Figures recompute from the cells. The assistant does not invent them.</p>
      <Card className="mt-4">
        <h3 className="text-sm font-medium">Assumptions</h3>
        <ul className="mt-2 flex flex-col gap-2">
          {assumptions.map((row) => (
            <li key={row.id} className="grid grid-cols-[1fr_120px_1fr] items-center gap-2 text-[13px]">
              <span>{row.name}</span>
              <input className="num h-8 rounded-[10px] border border-line bg-canvas px-2" value={row.value} onChange={(event) => onAssumption({ ...row, value: Number(event.target.value) })} />
              <span className="text-muted">{row.unit} · {row.source}</span>
            </li>
          ))}
          {assumptions.length === 0 && <li className="text-[13px] text-muted">No assumptions logged yet. They appear when you ask for a model.</li>}
        </ul>
      </Card>
      <div className="mt-4 overflow-auto">
        <table className="w-full text-left text-[13px]">
          <thead className="text-muted"><tr><th>Year</th>{years.map((item) => <th key={item.year}>{item.year}</th>)}</tr></thead>
          <tbody>
            <tr className="border-t border-line"><td>Revenue growth %</td>{years.map((item, index) => <td key={item.year}><input className="num h-7 w-16 rounded-[8px] border border-line bg-card px-1" value={Math.round((inputs.growth[index] || 0) * 1000) / 10} onChange={(event) => setGrowth(index, event.target.value)} /></td>)}</tr>
            {[["Revenue", "revenue"], ["Operating income", "operatingIncome"], ["Tax", "tax"], ["Net income", "netIncome"], ["Capex", "capex"], ["Free cash flow", "fcf"], ["Shares", "shares"], ["EPS", "eps"], ["FCF per share", "fcfPerShare"]].map(([label, key]) => (
              <tr key={key} className="border-t border-line">
                <td className="py-1">{label}</td>
                {years.map((item) => <td key={item.year} className="num">{key === "shares" ? Math.round(item.shares).toLocaleString() : key === "eps" || key === "fcfPerShare" ? item[key as "eps"].toFixed(2) : money(item[key as "revenue"])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Card className="mt-4">
        <h3 className="text-sm font-medium">Sensitivity, last-year free cash flow</h3>
        <div className="mt-2 grid grid-cols-3 gap-2 text-[13px]">
          {table.map((row) => <div key={`${row.growth}-${row.margin}`} className="rounded-[10px] border border-line px-2 py-1"><span className="text-muted">g {(row.growth * 100).toFixed(0)}% m {(row.margin * 100).toFixed(0)}%</span><div className="num">{money(row.fcf)}</div></div>)}
        </div>
      </Card>
      <Card className="mt-4">
        <h3 className="text-sm font-medium">Implied value</h3>
        <p className="mt-1 text-[13px] text-muted">Shown only from a discount rate or multiple you type. Labeled as implied by your assumptions.</p>
        <div className="mt-2 flex gap-2">
          <input placeholder="Discount rate" value={discount} onChange={(event) => { setDiscount(event.target.value); onInputs({ ...inputs, discount: event.target.value === "" ? null : Number(event.target.value) / 100 }); }} className="h-8 rounded-[10px] border border-line bg-canvas px-2 text-[13px]" />
          <input placeholder="Multiple" value={multiple} onChange={(event) => { setMultiple(event.target.value); onInputs({ ...inputs, multiple: event.target.value === "" ? null : Number(event.target.value) }); }} className="h-8 rounded-[10px] border border-line bg-canvas px-2 text-[13px]" />
        </div>
        <p className="num mt-2 text-lg">{value == null ? "—" : `${value.toFixed(2)} implied by your assumptions`}</p>
      </Card>
      <Button className="mt-4" variant="outline" onClick={() => {
        const header = ["year", "revenue", "fcf", "eps"].join(",");
        const body = years.map((item) => [item.year, item.revenue, item.fcf, item.eps].join(",")).join("\n");
        const blob = new Blob([`${header}\n${body}`], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "model.csv";
        link.click();
      }}>Export CSV</Button>
    </div>
  );
}
