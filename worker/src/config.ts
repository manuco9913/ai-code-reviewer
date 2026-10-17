// All Worker configuration, read from bindings and validated once per invocation at the entry point.

import type { ReviewJob } from "./automation/events";

export interface Env {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_FALLBACK_MODELS?: string;
  GEMINI_THINKING_LEVEL?: string;
  EMBEDDING_MODEL?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  GITHUB_TOKEN?: string;
  API_TOKEN?: string;
  // Automation (webhook → review → email → approval). All or none.
  GITHUB_WEBHOOK_SECRET?: string;
  APPROVAL_SECRET?: string;
  PUBLIC_URL?: string;
  RESEND_API_KEY?: string;
  EMAIL_TO?: string;
  EMAIL_FROM?: string;
  REVIEW_QUEUE?: Queue<ReviewJob>;
}

export interface AutomationConfig {
  webhookSecret: string;
  approvalSecret: string;
  /** Public origin of this Worker; approval links point here. */
  publicUrl: string;
  resendApiKey: string;
  emailTo: string[];
  emailFrom: string;
}

export interface WorkerConfig {
  geminiApiKey: string;
  geminiModel: string;
  /** Tried in order when geminiModel is overloaded. */
  geminiFallbackModels: string[];
  /** "low" keeps reviews to seconds on the free tier; null = model default (much slower). */
  geminiThinkingLevel: "low" | "medium" | "high" | null;
  embeddingModel: string;
  supabaseUrl: string;
  supabaseServiceKey: string;
  githubToken: string;
  /** Bearer token for /api/* (you, the web UI, scripts). */
  apiToken: string;
  /** Null until the automation settings are configured. */
  automation: AutomationConfig | null;
}

const CORE = ["GEMINI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "GITHUB_TOKEN", "API_TOKEN"] as const;
const AUTOMATION = ["GITHUB_WEBHOOK_SECRET", "APPROVAL_SECRET", "PUBLIC_URL", "RESEND_API_KEY", "EMAIL_TO"] as const;

type StringVar = Exclude<keyof Env, "REVIEW_QUEUE">;

export function loadConfig(env: Env): WorkerConfig {
  const value = (name: StringVar) => env[name]?.trim() ?? "";

  const missingCore = CORE.filter((n) => !value(n));
  if (missingCore.length) throw new Error(`Missing Worker secrets/vars: ${missingCore.join(", ")}`);
  if (value("API_TOKEN").length < 24) throw new Error("API_TOKEN must be at least 24 characters");

  return {
    geminiApiKey: value("GEMINI_API_KEY"),
    geminiModel: value("GEMINI_MODEL") || "gemini-3.8-flash",
    geminiFallbackModels: (value("GEMINI_FALLBACK_MODELS") || "gemini-3.7-flash,gemini-flash-lite-latest")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    geminiThinkingLevel: thinkingLevel(value("GEMINI_THINKING_LEVEL") || "low"),
    embeddingModel: value("EMBEDDING_MODEL") || "gemini-embedding-001",
    supabaseUrl: value("SUPABASE_URL"),
    supabaseServiceKey: value("SUPABASE_SERVICE_KEY"),
    githubToken: value("GITHUB_TOKEN"),
    apiToken: value("API_TOKEN"),
    automation: loadAutomation(value),
  };
}

function thinkingLevel(raw: string): "low" | "medium" | "high" | null {
  if (raw === "default") return null;
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  throw new Error(`GEMINI_THINKING_LEVEL must be low, medium, high or default, got "${raw}"`);
}

function loadAutomation(value: (name: StringVar) => string): AutomationConfig | null {
  const present = AUTOMATION.filter((n) => value(n));
  if (!present.length) return null;
  const missing = AUTOMATION.filter((n) => !value(n));
  if (missing.length) {
    throw new Error(`Automation is partly configured; also set: ${missing.join(", ")} (or remove ${present.join(", ")})`);
  }
  if (value("APPROVAL_SECRET").length < 32) throw new Error("APPROVAL_SECRET must be at least 32 characters");
  return {
    webhookSecret: value("GITHUB_WEBHOOK_SECRET"),
    approvalSecret: value("APPROVAL_SECRET"),
    publicUrl: value("PUBLIC_URL").replace(/\/+$/, ""),
    resendApiKey: value("RESEND_API_KEY"),
    emailTo: value("EMAIL_TO").split(",").map((e) => e.trim()).filter(Boolean),
    emailFrom: value("EMAIL_FROM") || "DevFlow AI <onboarding@resend.dev>",
  };
}
