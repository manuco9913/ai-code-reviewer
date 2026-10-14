// CLI: `npm run search -- "how are scenarios validated?" [path/prefix/]`
// Checks retrieval quality straight after indexing, before the Worker exists.

import { CodeSearch } from "../../shared/codeSearch";
import { Gemini } from "../../shared/gemini";
import { Supabase } from "../../shared/supabase";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const [query, pathPrefix] = process.argv.slice(2);
  if (!query) throw new Error('Usage: npm run search -- "<question>" [path/prefix/]');

  const config = loadConfig({ REPO_DIR: ".", ...process.env });
  const gemini = new Gemini(
    { apiKey: config.geminiApiKey, model: "unused-by-search", embeddingModel: config.embeddingModel, maxRetries: 2 },
    { fetch, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  );
  const search = new CodeSearch(new Supabase(config.supabaseUrl, config.supabaseServiceKey, fetch), gemini);

  const hits = await search.search(config.repo, query, { limit: 8, pathPrefix: pathPrefix ?? null });
  for (const h of hits) {
    console.log(`\n${h.score.toFixed(4)}  ${h.path}:${h.start_line}-${h.end_line}  ${h.kind} ${h.symbol ?? ""}`);
    console.log(h.content.split("\n").slice(0, 4).map((l) => `    ${l}`).join("\n"));
  }
  if (!hits.length) console.log("No results. Has the repo been indexed?");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
