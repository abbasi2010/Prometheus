import { BrowserWindow, dialog } from "electron";

let apply: (command: unknown) => void = () => {};

export function setApply(fn: (command: unknown) => void): void {
  apply = fn;
}

export function applyCommand(command: unknown): void {
  apply(command);
}

export async function confirm(message: string): Promise<boolean> {
  if (process.env.ANALYST_ASSUME_YES === "1") return true;
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (!win) return false;
  const result = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Cancel", "Continue"],
    defaultId: 1,
    cancelId: 0,
    message,
  });
  return result.response === 1;
}
