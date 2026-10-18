import OpenAI from "openai";
import { llm } from "../shared/config";
import type { AgentEvent, Chip } from "../shared/types";
import { ask, type Emit } from "./agent";
import { groqKey } from "./env";
import { parseReport, saveReport, type Report } from "./reports";
import { add } from "./store";

export type Assignment = {
  id: string;
  title: string;
  question: string;
  sources: string;
  depth: string;
  status: "queued" | "waiting" | "working" | "done" | "failed";
  threadId: string;
  reportId?: string;
  teamId?: string;
  parentThreadId?: string;
};

export type TeamPlan = { teamId: string; company: string; parentThreadId?: string; assignments: Assignment[] };

const jobs = new Map<string, Assignment>();
const teammateNotes = new Map<string, string[]>();
let queue: Assignment[] = [];
let active = 0;
let pumping = false;
let emitRef: Emit = () => undefined;
let companyRef = "";
let teamId = "";

function splitPlain(text: string): string[] {
  const parts = text.split(/\byou research\b/i).map((part) => part.replace(/^[\s,.;:]+|[\s.]+$/g, "")).filter((part) => part.length > 8);
  if (parts.length >= 2) return parts.slice(0, 5);
  return [];
}

export async function proposeTeam(text: string, company: string): Promise<TeamPlan> {
  const plain = splitPlain(text);
  let questions = plain;
  if (!questions.length) {
    const key = groqKey();
    if (key) {
      const client = new OpenAI({ apiKey: key, baseURL: llm.baseURL });
      try {
        const response = await client.chat.completions.create({
          model: llm.model,
          temperature: 0.2,
          max_completion_tokens: 500,
          messages: [
            { role: "system", content: "Split the request into 2 to 5 research assignments. Return JSON only: {\"assignments\":[{\"title\":\"\",\"question\":\"\",\"sources\":\"\",\"depth\":\"\"}]}. No recommendations." },
            { role: "user", content: text.slice(0, 1500) },
          ],
        });
        const raw = response.choices[0]?.message?.content || "";
        const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { assignments?: { title?: string; question?: string; sources?: string; depth?: string }[] };
        questions = (parsed.assignments || []).map((item) => item.question || item.title || "").filter(Boolean).slice(0, 5);
        if (questions.length) {
          teamId = `team-${Date.now().toString(36)}`;
          const assignments = (parsed.assignments || []).slice(0, 5).map((item, index) => ({
            id: `${teamId}-${index}`,
            title: item.title || `Assignment ${index + 1}`,
            question: item.question || questions[index],
            sources: item.sources || "Filings, company facts, and recent news",
            depth: item.depth || "standard",
            status: "queued" as const,
            threadId: `${teamId}-t${index}`,
          }));
          return { teamId, company, assignments };
        }
      } catch {
        questions = [];
      }
    }
  }
  if (!questions.length) questions = [text.slice(0, 280)];
  teamId = `team-${Date.now().toString(36)}`;
  return {
    teamId,
    company,
    assignments: questions.map((question, index) => ({
      id: `${teamId}-${index}`,
      title: question.slice(0, 72),
      question,
      sources: "Filings, company facts, and recent news",
      depth: "standard",
      status: "queued" as const,
      threadId: `${teamId}-t${index}`,
    })),
  };
}

function publish(): void {
  emitRef({ type: "team", teamId, jobs: [...jobs.values()] } as AgentEvent);
}

function postToParent(job: Assignment, text: string): void {
  if (!job.parentThreadId) return;
  emitRef({ type: "user", text: job.title, threadId: job.parentThreadId });
  emitRef({ type: "token", text, threadId: job.parentThreadId });
}

async function runJob(job: Assignment): Promise<void> {
  job.status = "working";
  jobs.set(job.id, job);
  publish();
  const chips: Chip[] = [];
  let answer = "";
  const child: Emit = (event) => {
    if (event.type === "token") answer += event.text;
    if (event.type === "replace") answer = event.text;
    if (event.type === "source") chips.push(event.chip);
    emitRef({ ...event, threadId: job.threadId });
  };
  const others = [...jobs.values()].filter((item) => item.teamId === job.teamId && item.id !== job.id);
  const finished = (teammateNotes.get(job.teamId || "") || []).join("\n");
  const prompt = `${job.question}

You are one agent on a team researching ${companyRef || "this company"}. The other assignments are:
${others.map((item) => `- ${item.title}: ${item.question}`).join("\n") || "- none"}

Teammates who already finished:
${finished || "None yet."}
If you disagree with a teammate, say so and name the source.

Write the report in this shape and no other:
Bottom line:
Findings:
- 
Evidence:
- metric | period | value | source
Counter-evidence:
Not found:
Follow-ups:
- 
Stay neutral. Do not recommend buying or selling. Every number must come from a tool.`;
  try {
    const text = await ask(prompt, companyRef, child, job.threadId, { turns: 4, toolBudget: 6 });
    const report = parseReport(companyRef, job.title, job.question, text || answer, chips);
    await saveReport(report);
    job.reportId = report.id;
    job.status = "done";
    jobs.set(job.id, job);
    const note = `${job.title}: ${report.bottomLine || "No bottom line."}`;
    const prior = teammateNotes.get(job.teamId || "") || [];
    teammateNotes.set(job.teamId || "", [...prior, note]);
    postToParent(job, report.bottomLine || "Finished, with nothing solid to add.");
    emitRef({ type: "report", report, threadId: job.threadId } as AgentEvent);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The assignment failed.";
    if (/rate limit|429/i.test(message)) {
      job.status = "waiting";
      jobs.set(job.id, job);
      publish();
      await new Promise((resolve) => setTimeout(resolve, 8000));
      queue.unshift(job);
      return;
    }
    job.status = "failed";
    jobs.set(job.id, job);
    child({ type: "error", text: message });
    postToParent(job, message);
  }
  publish();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  const batch = new Set<string>();
  try {
    while (queue.length) {
      while (active >= 2 && queue.length) {
        for (const waiting of queue) {
          waiting.status = "waiting";
          jobs.set(waiting.id, waiting);
        }
        publish();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const job = queue.shift();
      if (!job) break;
      if (job.teamId) batch.add(job.teamId);
      active += 1;
      void runJob(job).finally(() => {
        active = Math.max(0, active - 1);
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const started = Date.now();
    while (active > 0 && Date.now() - started < 8 * 60 * 1000) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (const id of batch) await synthesize(id);
  } finally {
    pumping = false;
    if (queue.length) void pump();
  }
}

async function synthesize(id: string): Promise<void> {
  const done = [...jobs.values()].filter((job) => job.teamId === id && job.status === "done" && job.reportId);
  if (!done.length) return;
  const parent = done.find((job) => job.parentThreadId)?.parentThreadId || "";
  const { listReports } = await import("./reports");
  const reports = await listReports(companyRef);
  const mine = done.map((job) => reports.find((report) => report.id === job.reportId)).filter((report): report is Report => Boolean(report));
  if (mine.length < 2) return;
  const brief = mine.map((report) => `${report.title}: ${report.bottomLine}\nUnclear: ${report.unclear}`).join("\n\n").slice(0, 2500);
  const key = groqKey();
  let text = mine.map((report) => report.bottomLine).join(" ");
  if (key) {
    try {
      const client = new OpenAI({ apiKey: key, baseURL: llm.baseURL });
      const response = await client.chat.completions.create({
        model: llm.model,
        temperature: 0.2,
        max_completion_tokens: 450,
        messages: [
          { role: "system", content: "Write a short synthesis: how the findings relate, where they contradict, and the open questions. Then ask if the user wants a model built from these findings. No recommendation." },
          { role: "user", content: brief },
        ],
      });
      text = response.choices[0]?.message?.content || text;
    } catch {
      text = `${text}\n\nWant a model built from these findings?`;
    }
  }
  if (parent) {
    emitRef({ type: "user", text: "Team synthesis", threadId: parent });
    emitRef({ type: "token", text, threadId: parent });
  }
  await add({ company: companyRef || "GENERAL", type: "finding", title: "Team synthesis", text });
}

export function startTeam(plan: TeamPlan, emit: Emit): void {
  emitRef = emit;
  companyRef = plan.company || companyRef;
  teamId = plan.teamId;
  for (const job of plan.assignments) {
    const next: Assignment = {
      ...job,
      status: "queued",
      teamId: plan.teamId,
      parentThreadId: plan.parentThreadId || job.parentThreadId || "",
    };
    const existing = jobs.get(job.id);
    if (existing && (existing.status === "working" || existing.status === "queued")) continue;
    jobs.set(next.id, next);
    queue.push(next);
  }
  if (plan.parentThreadId) {
    emitRef({ type: "user", text: plan.assignments.map((job) => job.title).join("; ") || "Research team", threadId: plan.parentThreadId });
    emitRef({ type: "token", text: `${plan.assignments.length} agents are working, two at a time. Each has a tab. I'll post what they find in this thread.`, threadId: plan.parentThreadId });
  }
  publish();
  void pump();
}

export function stopJob(threadId: string): void {
  queue = queue.filter((job) => job.threadId !== threadId);
  const job = [...jobs.values()].find((item) => item.threadId === threadId);
  if (job && job.status !== "done") {
    job.status = "failed";
    jobs.set(job.id, job);
    publish();
  }
}
