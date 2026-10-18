import { ipcRenderer } from "electron";

type Saved = { id: string; text: string; context: string; note: string; tag: string; by?: string };

function remember(): void {
  const selection = window.getSelection();
  const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
  if (text.length < 2) return;
  const parent = selection?.anchorNode?.parentElement;
  ipcRenderer.send("selection:remember", {
    text: text.slice(0, 2000),
    context: (parent?.innerText || text).replace(/\s+/g, " ").trim().slice(0, 500),
    url: location.href,
    title: document.title,
  });
}

const host = document.createElement("div");
const shadow = host.attachShadow({ mode: "open" });
shadow.innerHTML = `
  <style>
    .bar, .pop { position: fixed; z-index: 2147483647; display: none; background: #fffcf8; color: #1c1b19; border: 1px solid #ddd8ce; border-radius: 8px; font: 13px/1.4 Inter, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.12); }
    .bar { padding: 4px; }
    button, select { font: inherit; border: 0; background: transparent; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
    button:hover { background: rgba(0,0,0,.06); }
    .pop { padding: 8px; width: 220px; display: none; flex-direction: column; gap: 6px; }
    textarea { font: inherit; width: 100%; min-height: 48px; border: 1px solid #ddd8ce; border-radius: 6px; }
    ::highlight(prometheus) { background: #f3e4b8; }
    ::highlight(prometheus-agent) { background: #9ec5ff; }
  </style>
  <div class="bar"><button id="save" type="button">Highlight</button></div>
  <div class="pop">
    <select id="tag"><option>Evidence</option><option>Risk</option><option>Question</option></select>
    <textarea id="note" placeholder="Note"></textarea>
    <button id="keep" type="button">Save</button>
    <button id="remove" type="button">Remove</button>
  </div>
`;
document.documentElement.appendChild(host);
const paintStyle = document.createElement("style");
paintStyle.textContent = "::highlight(prometheus) { background: #f3e4b8; } ::highlight(prometheus-agent) { background: #9ec5ff; }";
document.documentElement.appendChild(paintStyle);
const bar = shadow.querySelector(".bar") as HTMLElement;
const pop = shadow.querySelector(".pop") as HTMLElement;
const note = shadow.querySelector("#note") as HTMLTextAreaElement;
const tag = shadow.querySelector("#tag") as HTMLSelectElement;
let saved: Saved[] = [];
let openId = "";

function place(node: HTMLElement, rect: DOMRect): void {
  node.style.display = node.classList.contains("pop") ? "flex" : "block";
  node.style.left = `${Math.max(8, rect.left)}px`;
  node.style.top = `${Math.max(8, rect.top - 36)}px`;
}

function hide(): void {
  bar.style.display = "none";
  pop.style.display = "none";
}

function findRange(quote: string, context: string): Range | null {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (needle.length < 2) return null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let combined = "";
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    combined += node.textContent || "";
    node = walker.nextNode();
  }
  const flat = combined.replace(/\s+/g, " ");
  let at = context ? flat.indexOf(context.replace(/\s+/g, " ").slice(0, 40)) : -1;
  if (at < 0) at = flat.indexOf(needle.slice(0, 40));
  if (at < 0) return null;
  const start = flat.indexOf(needle, Math.max(0, at - 20));
  const from = start < 0 ? at : start;
  let seen = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  const targetEnd = from + needle.length;
  for (const text of nodes) {
    const raw = (text.textContent || "").replace(/\s+/g, " ");
    const next = seen + raw.length;
    if (!startNode && next > from) {
      startNode = text;
      startOffset = Math.max(0, from - seen);
    }
    if (startNode && next >= targetEnd) {
      endNode = text;
      endOffset = Math.max(0, targetEnd - seen);
      break;
    }
    seen = next;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, Math.min(startOffset, startNode.length));
  range.setEnd(endNode, Math.min(endOffset, endNode.length));
  return range;
}

function paint(): void {
  const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  const cssHighlights = (CSS as unknown as { highlights?: { set: (name: string, value: unknown) => void; delete: (name: string) => void } }).highlights;
  if (!HighlightCtor || !cssHighlights) return;
  const agent = (item: Saved) => item.by === "agent" || item.tag === "Agent";
  for (const [name, items] of [["prometheus", saved.filter((item) => !agent(item))], ["prometheus-agent", saved.filter(agent)]] as const) {
    const ranges = items.map((item) => findRange(item.text, item.context)).filter((range): range is Range => Boolean(range));
    if (!ranges.length) cssHighlights.delete(name);
    else cssHighlights.set(name, new HighlightCtor(...ranges));
  }
}

async function load(): Promise<void> {
  saved = (await ipcRenderer.invoke("highlights:for", location.href)) as Saved[];
  paint();
}

shadow.getElementById("save")?.addEventListener("click", () => {
  const selection = window.getSelection();
  const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
  if (!text) return;
  const parent = selection?.anchorNode?.parentElement;
  ipcRenderer.send("highlight:save", {
    text,
    context: (parent?.innerText || text).replace(/\s+/g, " ").trim().slice(0, 500),
    url: location.href.split("#")[0],
    title: document.title,
  });
  hide();
});

shadow.getElementById("keep")?.addEventListener("click", () => {
  if (!openId) return;
  ipcRenderer.send("highlight:update", { id: openId, note: note.value, tag: tag.value });
  hide();
});

shadow.getElementById("remove")?.addEventListener("click", () => {
  if (!openId) return;
  ipcRenderer.send("highlight:remove", openId);
  hide();
});

document.addEventListener("selectionchange", remember);
window.addEventListener("mouseup", (event) => {
  remember();
  const target = event.target as Node | null;
  if (target && host.contains(target)) return;
  const selection = window.getSelection();
  const text = selection?.toString().trim() || "";
  if (text.length > 1) {
    bar.style.display = "none";
    pop.style.display = "none";
    return;
  }
  const hit = saved.find((item) => {
    const range = findRange(item.text, item.context);
    if (!range) return false;
    const rect = range.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  });
  if (hit) {
    openId = hit.id;
    note.value = hit.note || "";
    tag.value = hit.tag || "Evidence";
    place(pop, new DOMRect(event.clientX, event.clientY + 28, 0, 0));
    bar.style.display = "none";
    return;
  }
  hide();
});

ipcRenderer.on("highlights:refresh", () => void load());
window.addEventListener("DOMContentLoaded", () => void load());
void load();
