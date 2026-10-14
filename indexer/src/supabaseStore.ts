// IndexStore adapter over Supabase (PostgREST). The only indexer code that knows table names.

import { inFilter, type Supabase } from "../../shared/supabase";
import type { Language } from "./chunker";
import type { FileRecord, IndexStore, StoredChunk } from "./indexer";

const INSERT_BATCH = 100;
const PATH_BATCH = 50;

interface FileRow {
  path: string;
  language: Language;
  file_hash: string;
  imports: string[];
  packages: string[];
}

export class SupabaseIndexStore implements IndexStore {
  constructor(private readonly db: Supabase) {}

  async getIndexedFiles(repo: string): Promise<Map<string, FileRecord>> {
    const rows = await this.db.selectAll<FileRow>("code_files", {
      repo: `eq.${repo}`,
      select: "path,language,file_hash,imports,packages",
      order: "path",
    });
    return new Map(
      rows.map((r) => [r.path, { path: r.path, language: r.language, fileHash: r.file_hash, imports: r.imports, packages: r.packages }]),
    );
  }

  async replaceFiles(repo: string, entries: { file: FileRecord; chunks: StoredChunk[] }[]): Promise<void> {
    if (!entries.length) return;
    // Chunks first, file record (with the new hash) last: if we crash in between, the file still
    // looks changed and is redone on the next run.
    await this.deleteChunks(repo, entries.map((e) => e.file.path));
    const chunkRows = entries.flatMap((e) => e.chunks.map((c) => chunkRow(repo, c)));
    for (let i = 0; i < chunkRows.length; i += INSERT_BATCH) {
      await this.db.insert("code_chunks", chunkRows.slice(i, i + INSERT_BATCH));
    }
    await this.upsertFiles(repo, entries.map((e) => e.file));
  }

  async updateFileImports(repo: string, files: FileRecord[]): Promise<void> {
    await this.upsertFiles(repo, files);
  }

  async deleteFiles(repo: string, paths: string[]): Promise<void> {
    await this.deleteChunks(repo, paths);
    for (let i = 0; i < paths.length; i += PATH_BATCH) {
      await this.db.delete("code_files", { repo: `eq.${repo}`, path: inFilter(paths.slice(i, i + PATH_BATCH)) });
    }
  }

  async recordRun(repo: string, run: { commit: string; fileCount: number }): Promise<void> {
    await this.db.rpc("record_index_run", { p_repo: repo, p_commit: run.commit, p_file_count: run.fileCount });
  }

  private async deleteChunks(repo: string, paths: string[]): Promise<void> {
    for (let i = 0; i < paths.length; i += PATH_BATCH) {
      await this.db.delete("code_chunks", { repo: `eq.${repo}`, path: inFilter(paths.slice(i, i + PATH_BATCH)) });
    }
  }

  private async upsertFiles(repo: string, files: FileRecord[]): Promise<void> {
    for (let i = 0; i < files.length; i += INSERT_BATCH) {
      const rows = files.slice(i, i + INSERT_BATCH).map((f) => ({
        repo,
        path: f.path,
        language: f.language,
        file_hash: f.fileHash,
        imports: f.imports,
        packages: f.packages,
        indexed_at: new Date().toISOString(),
      }));
      await this.db.upsert("code_files", rows, "repo,path");
    }
  }
}

function chunkRow(repo: string, c: StoredChunk) {
  return {
    repo,
    path: c.path,
    symbol: c.symbol,
    kind: c.kind,
    language: c.language,
    start_line: c.startLine,
    end_line: c.endLine,
    content: c.content,
    embedding: c.embedding,
  };
}
