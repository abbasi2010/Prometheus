/// <reference types="vite/client" />
import type { AnalystApi } from "../../preload/index";

declare global {
  interface Window {
    analyst: AnalystApi;
  }
}

export {};
