// All indexer configuration, read and validated once at startup.

export interface IndexerConfig {
  repo: string;
  repoDir: string;
  supabaseUrl: string;
  supabaseServiceKey: string;
  geminiApiKey: string;
  embeddingModel: string;
  /** Free-tier embedding budget; lower it if Gemini still reports 429s. */
  embedTextsPerMinute: number;
  requestTimeoutMs: number;
}

export function loadConfig(env: Record<string, string | undefined>): IndexerConfig {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? "";
  };

  const config: IndexerConfig = {
    repo: required("REPO"),
    repoDir: required("REPO_DIR"),
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceKey: required("SUPABASE_SERVICE_KEY"),
    geminiApiKey: required("GEMINI_API_KEY"),
    embeddingModel: env.EMBEDDING_MODEL?.trim() || "gemini-embedding-001",
    embedTextsPerMinute: positiveInt(env.EMBED_TEXTS_PER_MINUTE, 100, "EMBED_TEXTS_PER_MINUTE"),
    requestTimeoutMs: 60_000,
  };
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repo)) throw new Error(`REPO must look like "owner/name", got "${config.repo}"`);
  return config;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return n;
}
