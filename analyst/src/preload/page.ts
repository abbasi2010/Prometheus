import { ipcRenderer } from "electron";

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

document.addEventListener("selectionchange", remember);
window.addEventListener("mouseup", remember);
