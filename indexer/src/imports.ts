// Builds the import graph: which repo files a file depends on, and which external packages.

import { posix } from "node:path";
import type { Language } from "./chunker";

export interface FileImports {
  /** Repo-relative paths of internal files this file imports. */
  imports: string[];
  /** External package names (e.g. "react", "@scope/pkg", "fastapi"). */
  packages: string[];
}

const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export function extractImports(path: string, content: string, language: Language, repoPaths: Set<string>): FileImports {
  const imports = new Set<string>();
  const packages = new Set<string>();
  if (language === "typescript" || language === "javascript") {
    for (const spec of jsSpecifiers(content)) {
      if (spec.startsWith(".")) {
        const resolved = resolveJs(posix.join(posix.dirname(path), spec), repoPaths);
        if (resolved) imports.add(resolved);
      } else {
        packages.add(packageName(spec));
      }
    }
  } else if (language === "python") {
    for (const stmt of pythonStatements(content)) {
      const resolved = resolvePython(path, stmt, repoPaths);
      if (resolved.length) resolved.forEach((r) => imports.add(r));
      else if (!stmt.dots) packages.add(stmt.module.split(".")[0] ?? stmt.module);
    }
  }
  return { imports: [...imports], packages: [...packages] };
}

interface PythonImport {
  /** Leading dots of a relative import ("" for absolute). */
  dots: string;
  module: string;
  /** Names after `from x import ...` (may be submodules). */
  names: string[];
}

function pythonStatements(content: string): PythonImport[] {
  const stmts: PythonImport[] = [];
  for (const line of content.split("\n")) {
    const from = /^\s*from\s+(\.*)([\w.]*)\s+import\s+\(?([^)#]+)/.exec(line);
    if (from) {
      const names = (from[3] ?? "").split(",").flatMap((n) => n.trim().split(/\s+/)[0] || []);
      stmts.push({ dots: from[1] ?? "", module: from[2] ?? "", names });
      continue;
    }
    const plain = /^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/.exec(line);
    for (const part of plain?.[1]?.split(",") ?? []) {
      const module = part.trim().split(/\s+/)[0];
      if (module) stmts.push({ dots: "", module, names: [] });
    }
  }
  return stmts;
}

function resolvePython(path: string, stmt: PythonImport, repoPaths: Set<string>): string[] {
  const modulePath = stmt.module.replace(/\./g, "/");
  if (stmt.dots) {
    let base = posix.dirname(path);
    for (let i = 1; i < stmt.dots.length; i++) base = posix.dirname(base);
    return resolvePythonModule(posix.join(base, modulePath), stmt.names, repoPaths);
  }
  // Absolute imports resolve against the repo root or any ancestor directory (e.g. "backend/").
  for (let root = posix.dirname(path); ; root = posix.dirname(root)) {
    const dir = root === "." ? "" : root;
    const found = resolvePythonModule(posix.join(dir, modulePath), stmt.names, repoPaths);
    if (found.length) return found;
    if (!dir) return [];
  }
}

/** Prefers imported submodules (`from pkg import mod`), falling back to the module itself. */
function resolvePythonModule(modulePath: string, names: string[], repoPaths: Set<string>): string[] {
  const asModule = (p: string) => [`${p}.py`, `${p}/__init__.py`].find((c) => repoPaths.has(c));
  const submodules = names.flatMap((n) => asModule(posix.join(modulePath, n)) ?? []);
  if (submodules.length) return submodules;
  const own = asModule(modulePath);
  return own ? [own] : [];
}

function jsSpecifiers(content: string): string[] {
  const pattern = /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;
  return [...content.matchAll(pattern)].flatMap((m) => (m[1] ? [m[1]] : []));
}

function resolveJs(base: string, repoPaths: Set<string>): string | null {
  // TS with ESM resolution imports "./x.js" for the source file "./x.ts".
  const stem = base.replace(/\.(m|c)?js$/, "");
  const candidates = [
    base,
    ...JS_EXTENSIONS.map((ext) => stem + ext),
    ...JS_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((c) => repoPaths.has(c)) ?? null;
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}
