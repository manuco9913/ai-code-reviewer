// Decides which repository files are worth indexing, and as what language.

import type { Language } from "./chunker";

const MAX_FILE_CHARS = 200_000;
/** A line longer than this means minified or generated output. */
const MAX_LINE_CHARS = 1_000;

const EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", "vendor", ".next", ".nuxt", ".turbo",
  ".venv", "venv", "__pycache__", "site-packages", ".git", ".mypy_cache", ".pytest_cache",
]);

const LOCK_FILES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "poetry.lock", "uv.lock", "Pipfile.lock", "Cargo.lock",
]);

const BY_EXTENSION: Record<string, Language> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python",
  md: "markdown", mdx: "markdown",
  yml: "text", yaml: "text", toml: "text", json: "text", sql: "text", sh: "text",
  css: "text", scss: "text", html: "text", ini: "text", cfg: "text",
};

const BY_NAME: Record<string, Language> = { Dockerfile: "text", Makefile: "text" };

/** The language to index `path` as, or null when the file should be skipped. */
export function indexableLanguage(path: string, content: string): Language | null {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((s) => EXCLUDED_DIRS.has(s))) return null;
  if (LOCK_FILES.has(name) || /\.min\.(js|css)$/.test(name)) return null;

  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  const language = BY_NAME[name] ?? (ext ? BY_EXTENSION[ext] : undefined);
  if (!language) return null;

  if (content.length > MAX_FILE_CHARS || content.includes("\u0000")) return null;
  if (content.split("\n").some((line) => line.length > MAX_LINE_CHARS)) return null;
  return language;
}
