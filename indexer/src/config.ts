// All indexer configuration, read and validated once at startup.

export interface IndexerConfig {
  repo: string;
  repoDir: string;
  supabaseUrl: string;
  supabaseServiceKey: string;
  geminiApiKey: string;
  embeddingModel: string;
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
  };
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repo)) throw new Error(`REPO must look like "owner/name", got "${config.repo}"`);
  return config;
}
