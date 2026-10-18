export type Company = {
  id: string;
  ticker: string;
  name: string;
  price: string;
  change: string;
};

export type Note = {
  id: string;
  companyId: string;
  tag: string;
  line: string;
  detail: string;
  source: string;
};

export const companies: Company[] = [
  { id: "uber", ticker: "UBER", name: "Uber", price: "70.35", change: "−12% over 1y" },
  { id: "lyft", ticker: "LYFT", name: "Lyft", price: "16.82", change: "+4% over 1y" },
];

export const stand: Record<string, string> = {
  uber: "You have the 2025 10-K open, one highlight on driver classification, and no transcript yet. The open question is whether regulation changes the cost story.",
  lyft: "Lyft is a new folder. Nothing is highlighted yet. The latest 10-K is the only source in this preview.",
};

export const notes: Note[] = [
  {
    id: "n1",
    companyId: "uber",
    tag: "Risk",
    line: "Driver classification could raise costs",
    detail: "Item 1A of the 2025 10-K describes classification, wage, and union rules as a risk to the cost structure. This is a highlight, not a conclusion.",
    source: "UBER 10-K 2025",
  },
  {
    id: "n2",
    companyId: "uber",
    tag: "Evidence",
    line: "Revenue grew from $37.3B to $52.0B over three years",
    detail: "SEC company facts, fiscal 2023 through 2025. The figure is from the filing data, not from a news recap.",
    source: "SEC company facts",
  },
  {
    id: "n3",
    companyId: "uber",
    tag: "Question",
    line: "How did management talk about margins on the last two calls?",
    detail: "Asked in chat. No transcript is saved in this preview.",
    source: "Chat",
  },
  {
    id: "n4",
    companyId: "lyft",
    tag: "Data",
    line: "Market cap is much smaller than Uber's",
    detail: "Yahoo quote snapshot in this preview. A real comparison still has to come from the quote tool.",
    source: "Quote",
  },
];

export const filingBody = [
  "Item 1A. Risk Factors",
  "Our business is subject to a complex patchwork of regulations that affect how trips are priced, how drivers are classified, and what benefits we may owe.",
  "Driver classification risk is the item you asked to see. Changes in wage, union, or employment rules could increase the cost of a trip and reduce the take rate the company keeps.",
  "We also face insurance, safety, and autonomous-vehicle rules that differ by city. A rule change in one large market can show up in results before it shows up everywhere else.",
];
