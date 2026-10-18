import { config } from "dotenv";
import { envPath } from "./paths";

config({ path: envPath() });

export function groqKey(): string {
  return (process.env.GROQ_API_KEY || "").trim();
}

export function tavilyKey(): string {
  return (process.env.TAVILY_API_KEY || "").trim();
}

export function secEmail(): string {
  return (process.env.SEC_CONTACT_EMAIL || "").trim();
}

export function secHeaders(): Record<string, string> {
  const email = secEmail();
  if (!email) {
    throw new Error("Set SEC_CONTACT_EMAIL in analyst/.env and restart the app.");
  }
  return {
    "User-Agent": `Research Analyst ${email}`,
    Accept: "application/json, text/html, */*",
  };
}
