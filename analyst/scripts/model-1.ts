import OpenAI from "openai";
import { llm } from "../src/shared/config.ts";
import { groqKey } from "../src/main/env.ts";
import { findTranscripts, passagesFromUrls } from "../src/main/transcript.ts";

const client = new OpenAI({ apiKey: groqKey(), baseURL: llm.baseURL });
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "find_transcript",
      description: "Find public earnings-call transcript pages and return their URLs.",
      parameters: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] },
    },
  },
  {
    type: "function",
    function: {
      name: "passages",
      description: "Pull short quotes around the given words from URLs already returned.",
      parameters: {
        type: "object",
        properties: { urls: { type: "array", items: { type: "string" } }, words: { type: "array", items: { type: "string" } } },
        required: ["urls", "words"],
      },
    },
  },
];

const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
  {
    role: "system",
    content: "You are a research assistant. Never recommend a buy or sell. Use tools for transcripts. Do not invent numbers.",
  },
  {
    role: "user",
    content: "Get Uber's latest earnings call transcript and the previous two, and tell me how management's tone on margins changed.",
  },
];

let called: string[] = [];
for (let turn = 0; turn < 3; turn++) {
  const response = await client.chat.completions.create({
    model: llm.model,
    messages,
    tools,
    temperature: 0.2,
    max_completion_tokens: 800,
  });
  const message = response.choices[0]?.message;
  if (!message) break;
  messages.push(message);
  const calls = message.tool_calls || [];
  if (!calls.length) {
    console.log("ANSWER", (message.content || "").slice(0, 700));
    console.log("TOOLS", called.join(", ") || "none");
    break;
  }
  for (const call of calls) {
    if (call.type !== "function") continue;
    called.push(call.function.name);
    const args = JSON.parse(call.function.arguments || "{}") as { ticker?: string; urls?: string[]; words?: string[] };
    let content = "";
    if (call.function.name === "find_transcript") {
      const found = await findTranscripts(args.ticker || "UBER");
      content = JSON.stringify({ pages: found.pages.map((page) => ({ title: page.title, url: page.url, note: page.note })), missing: found.missing });
    } else if (call.function.name === "passages") {
      const rows = await passagesFromUrls(args.urls || [], args.words || ["margin"]);
      content = JSON.stringify(rows.map((row) => ({ url: row.url, passage: row.passage.slice(0, 180), missing: row.missing })));
    }
    messages.push({ role: "tool", tool_call_id: call.id, content });
    console.log("CALL", call.function.name);
  }
}
