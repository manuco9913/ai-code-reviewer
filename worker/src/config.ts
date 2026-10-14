// All Worker configuration, read from bindings and validated once per request at the entry point.

export interface Env {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  EMBEDDING_MODEL?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  GITHUB_TOKEN?: string;
  API_TOKEN?: string;
}

export interface WorkerConfig {
  geminiApiKey: string;
  geminiModel: string;
  embeddingModel: string;
  supabaseUrl: string;
  supabaseServiceKey: string;
  githubToken: string;
  /** Bearer token for /api/* (you, the web UI, scripts). */
  apiToken: string;
}

export function loadConfig(env: Env): WorkerConfig {
  const missing: string[] = [];
  const required = (name: keyof Env): string => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? "";
  };
  const config: WorkerConfig = {
    geminiApiKey: required("GEMINI_API_KEY"),
    geminiModel: env.GEMINI_MODEL?.trim() || "gemini-2.5-flash",
    embeddingModel: env.EMBEDDING_MODEL?.trim() || "gemini-embedding-001",
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceKey: required("SUPABASE_SERVICE_KEY"),
    githubToken: required("GITHUB_TOKEN"),
    apiToken: required("API_TOKEN"),
  };
  if (missing.length) throw new Error(`Missing Worker secrets/vars: ${missing.join(", ")}`);
  if (config.apiToken.length < 24) throw new Error("API_TOKEN must be at least 24 characters");
  return config;
}
