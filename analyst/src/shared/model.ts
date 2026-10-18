export type ModelInputs = {
  revenue0: number;
  growth: number[];
  margin: number[];
  tax: number;
  capexPct: number[];
  shares0: number;
  buyback: number[];
  discount: number | null;
  multiple: number | null;
};

export type ModelYear = {
  year: number;
  revenue: number;
  operatingIncome: number;
  tax: number;
  netIncome: number;
  capex: number;
  fcf: number;
  shares: number;
  eps: number;
  fcfPerShare: number;
};

export function project(inputs: ModelInputs, startYear: number): ModelYear[] {
  const years: ModelYear[] = [];
  let revenue = inputs.revenue0;
  let shares = inputs.shares0 || 1;
  for (let i = 0; i < 5; i++) {
    const growth = inputs.growth[i] ?? inputs.growth[inputs.growth.length - 1] ?? 0;
    const margin = inputs.margin[i] ?? inputs.margin[inputs.margin.length - 1] ?? 0;
    const capexPct = inputs.capexPct[i] ?? inputs.capexPct[inputs.capexPct.length - 1] ?? 0;
    const buyback = inputs.buyback[i] ?? inputs.buyback[inputs.buyback.length - 1] ?? 0;
    revenue = revenue * (1 + growth);
    const operatingIncome = revenue * margin;
    const tax = Math.max(0, operatingIncome) * inputs.tax;
    const netIncome = operatingIncome - tax;
    const capex = revenue * capexPct;
    const fcf = netIncome + capex * 0 + (operatingIncome - tax - capex);
    shares = Math.max(1, shares * (1 - buyback));
    years.push({
      year: startYear + i + 1,
      revenue,
      operatingIncome,
      tax,
      netIncome,
      capex,
      fcf,
      shares,
      eps: netIncome / shares,
      fcfPerShare: fcf / shares,
    });
  }
  return years;
}

export function impliedValue(years: ModelYear[], inputs: ModelInputs): number | null {
  const last = years[years.length - 1];
  if (!last) return null;
  if (inputs.multiple != null) return last.eps * inputs.multiple;
  if (inputs.discount != null && inputs.discount > 0) {
    let value = 0;
    years.forEach((year, index) => {
      value += year.fcfPerShare / Math.pow(1 + inputs.discount!, index + 1);
    });
    const terminal = last.fcfPerShare * (1 + (inputs.growth[4] || 0)) / Math.max(0.01, inputs.discount - (inputs.growth[4] || 0));
    value += terminal / Math.pow(1 + inputs.discount, years.length);
    return value;
  }
  return null;
}

export function sensitivity(inputs: ModelInputs, startYear: number): { growth: number; margin: number; fcf: number }[] {
  const baseG = inputs.growth[0] || 0;
  const baseM = inputs.margin[0] || 0;
  const rows = [];
  for (const growth of [baseG - 0.02, baseG, baseG + 0.02]) {
    for (const margin of [baseM - 0.02, baseM, baseM + 0.02]) {
      const years = project({ ...inputs, growth: Array(5).fill(growth), margin: Array(5).fill(margin) }, startYear);
      rows.push({ growth, margin, fcf: years[years.length - 1]?.fcf || 0 });
    }
  }
  return rows;
}
