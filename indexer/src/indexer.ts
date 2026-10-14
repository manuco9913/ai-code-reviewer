// Incrementally indexes a repository snapshot into the code search index.

import { createHash } from "node:crypto";
import { chunkFile, type ChunkKind, type Language } from "./chunker";
import { extractImports } from "./imports";
import { indexableLanguage } from "./selection";

export interface RepoFile {
  path: string;
  content: string;
}

export interface FileRecord {
  path: string;
  language: Language;
  fileHash: string;
  imports: string[];
  packages: string[];
}

export interface StoredChunk {
  path: string;
  symbol: string | null;
  kind: ChunkKind;
  language: Language;
  startLine: number;
  endLine: number;
  content: string;
  embedding: number[];
}

/** Port: turns chunk texts into embedding vectors (Gemini). */
export interface Embedder {
  embedDocuments(texts: string[]): Promise<number[][]>;
}

/** Port: the persisted index (Supabase). */
export interface IndexStore {
  getIndexedFiles(repo: string): Promise<Map<string, FileRecord>>;
  /** Replaces all chunks of each file and upserts its record, file by file. */
  replaceFiles(repo: string, entries: { file: FileRecord; chunks: StoredChunk[] }[]): Promise<void>;
  updateFileImports(repo: string, files: FileRecord[]): Promise<void>;
  deleteFiles(repo: string, paths: string[]): Promise<void>;
  /** Records the indexed commit and file count; the store derives the chunk total. */
  recordRun(repo: string, run: { commit: string; fileCount: number }): Promise<void>;
}

export interface IndexRequest {
  repo: string;
  commit: string;
  files: RepoFile[];
}

export interface IndexDeps {
  store: IndexStore;
  embedder: Embedder;
  log: (message: string) => void;
}

export interface IndexResult {
  indexedFiles: number;
  unchangedFiles: number;
  deletedFiles: number;
  chunks: number;
}

/** Max characters sent to the embedding model per chunk (~2k tokens). */
const MAX_EMBED_CHARS = 6000;

/** Files per embed + store round; progress is persisted after each group. */
const GROUP_SIZE = 20;

export async function indexRepository(req: IndexRequest, deps: IndexDeps): Promise<IndexResult> {
  const repoPaths = new Set(req.files.map((f) => f.path));
  const indexed = await deps.store.getIndexedFiles(req.repo);

  const changed: { file: FileRecord; content: string }[] = [];
  const importsChanged: FileRecord[] = [];
  const indexable = new Set<string>();
  for (const f of req.files) {
    const language = indexableLanguage(f.path, f.content);
    if (!language) continue;
    indexable.add(f.path);
    const { imports, packages } = extractImports(f.path, f.content, language, repoPaths);
    const file: FileRecord = { path: f.path, language, fileHash: sha256(f.content), imports, packages };
    const previous = indexed.get(f.path);
    if (previous?.fileHash !== file.fileHash) changed.push({ file, content: f.content });
    else if (!sameImports(previous, file)) importsChanged.push(file);
  }
  // A file added or removed elsewhere can change what an unchanged file's imports resolve to.
  if (importsChanged.length) await deps.store.updateFileImports(req.repo, importsChanged);
  const unchangedFiles = indexable.size - changed.length;

  // Anything indexed before but not indexable now (deleted, renamed, or newly excluded) goes.
  const deleted = [...indexed.keys()].filter((p) => !indexable.has(p));
  if (deleted.length) await deps.store.deleteFiles(req.repo, deleted);

  let chunkCount = 0;
  for (let i = 0; i < changed.length; i += GROUP_SIZE) {
    const entries = await embedFiles(changed.slice(i, i + GROUP_SIZE), deps.embedder);
    await deps.store.replaceFiles(req.repo, entries);
    chunkCount += entries.reduce((n, e) => n + e.chunks.length, 0);
    deps.log(`Indexed ${Math.min(i + GROUP_SIZE, changed.length)}/${changed.length} changed files`);
  }

  await deps.store.recordRun(req.repo, { commit: req.commit, fileCount: indexable.size });
  return { indexedFiles: changed.length, unchangedFiles, deletedFiles: deleted.length, chunks: chunkCount };
}

/** Chunks a group of files and embeds all their chunks in as few API calls as possible. */
async function embedFiles(
  files: { file: FileRecord; content: string }[],
  embedder: Embedder,
): Promise<{ file: FileRecord; chunks: StoredChunk[] }[]> {
  const chunked = files.map(({ file, content }) => ({ file, chunks: chunkFile(file.path, content, file.language) }));
  const texts = chunked.flatMap(({ file, chunks }) => chunks.map((c) => embeddingText(file.path, c.symbol, c.kind, c.content)));
  const vectors = await embedder.embedDocuments(texts);

  let next = 0;
  return chunked.map(({ file, chunks }) => ({
    file,
    chunks: chunks.map((c) => {
      const embedding = vectors[next++];
      if (!embedding) throw new Error(`Missing embedding for ${file.path}:${c.startLine}`);
      return { ...c, path: file.path, language: file.language, embedding };
    }),
  }));
}

function sameImports(a: FileRecord, b: FileRecord): boolean {
  const key = (f: FileRecord) => JSON.stringify([[...f.imports].sort(), [...f.packages].sort()]);
  return key(a) === key(b);
}

function embeddingText(path: string, symbol: string | null, kind: ChunkKind, content: string): string {
  return `File: ${path}\nSymbol: ${symbol ?? "-"} (${kind})\n\n${content}`.slice(0, MAX_EMBED_CHARS);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
