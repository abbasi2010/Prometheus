// Edit this file to swap LLM providers later. Nothing else names the model.
// No fallback: if this model fails, the panel shows the error.
export const llm = {
  provider: "groq",
  baseURL: "https://api.groq.com/openai/v1",
  model: "openai/gpt-oss-120b",
} as const;
