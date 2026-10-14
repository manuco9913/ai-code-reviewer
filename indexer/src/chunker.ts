// Splits a source file into retrieval chunks aligned with code structure.

import ts from "typescript";

export type Language = "typescript" | "javascript" | "python" | "markdown" | "text";

export type ChunkKind = "function" | "class" | "method" | "type" | "block" | "module" | "section";

export interface Chunk {
  symbol: string | null;
  kind: ChunkKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  content: string;
}

/** Classes longer than this are split per method; any other span longer than this is windowed. */
const MAX_LINES = 120;
const WINDOW_OVERLAP = 10;

interface Span {
  symbol: string | null;
  kind: ChunkKind;
  start: number;
  end: number;
}

export function chunkFile(path: string, content: string, language: Language): Chunk[] {
  const lines = content.split("\n");
  const spans = spansFor(path, content, lines, language);
  return spans.flatMap(windowed).map((s) => ({
    symbol: s.symbol,
    kind: s.kind,
    startLine: s.start,
    endLine: s.end,
    content: lines.slice(s.start - 1, s.end).join("\n"),
  }));
}

function spansFor(path: string, content: string, lines: string[], language: Language): Span[] {
  switch (language) {
    case "typescript":
    case "javascript":
      return typescriptSpans(path, content);
    case "python":
      return pythonSpans(lines);
    case "markdown":
      return markdownSpans(lines);
    case "text":
      return [{ symbol: null, kind: "block", start: 1, end: lines.length }];
  }
}

/** One section per heading (levels 1-3); headings inside code fences are ignored. */
function markdownSpans(lines: string[]): Span[] {
  const spans: Span[] = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    const current = spans[spans.length - 1];
    if (heading?.[1] || !current) {
      spans.push({ symbol: heading?.[1] ?? null, kind: "section", start: i + 1, end: i + 1 });
    } else {
      current.end = i + 1;
    }
  });
  return spans;
}

function typescriptSpans(path: string, content: string): Span[] {
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const range = (node: ts.Node) => ({ start: lineOf(startIncludingComments(node, sf)), end: lineOf(node.getEnd()) });

  const spans: Span[] = [];
  for (const stmt of sf.statements) {
    const r = range(stmt);
    const decl = classifyStatement(stmt);
    if (decl?.kind === "class" && ts.isClassDeclaration(stmt) && r.end - r.start + 1 > MAX_LINES) {
      spans.push({ symbol: decl.symbol, kind: "class", start: r.start, end: r.start });
      for (const member of stmt.members) {
        const method = methodName(member);
        spans.push(
          method
            ? { symbol: `${decl.symbol}.${method}`, kind: "method", ...range(member) }
            : { symbol: decl.symbol, kind: "class", ...range(member) },
        );
      }
    } else {
      spans.push(decl ? { ...decl, ...r } : { symbol: null, kind: "module", ...r });
    }
  }
  return mergeAdjacent(spans);
}

function windowed(span: Span): Span[] {
  if (span.end - span.start + 1 <= MAX_LINES) return [span];
  const windows: Span[] = [];
  for (let start = span.start; ; start += MAX_LINES - WINDOW_OVERLAP) {
    const end = Math.min(start + MAX_LINES - 1, span.end);
    windows.push({ ...span, start, end });
    if (end === span.end) return windows;
  }
}

// Python: blocks are found by indentation. A def/class (plus its decorators) runs until the next
// non-blank line indented at or below its own level.
function pythonSpans(lines: string[]): Span[] {
  return mergeAdjacent(pythonBlockSpans(lines, 0, lines.length - 1, 0, null));
}

/**
 * Spans for lines [from, to] whose statements sit at `indent`. Top level (`owner` null) yields
 * functions, classes and module code; a split class body yields its methods and class code.
 */
function pythonBlockSpans(lines: string[], from: number, to: number, indent: number, owner: string | null): Span[] {
  const spans: Span[] = [];
  let i = from;
  while (i <= to) {
    const line = lines[i] ?? "";
    if (!line.trim() || indentOf(line) !== indent) {
      // Blank, or a continuation line of a multi-line statement: belongs to the current run.
      const prev = spans[spans.length - 1];
      if (prev && line.trim()) prev.end = i + 1;
      i++;
      continue;
    }
    let defIdx = i;
    while (/^\s*@/.test(lines[defIdx] ?? "")) defIdx++;
    const def = /^\s*(?:async\s+)?(def|class)\s+(\w+)/.exec(lines[defIdx] ?? "");
    if (def?.[1] && def[2]) {
      const headerEnd = pythonHeaderEnd(lines, defIdx);
      const end = pythonBlockEnd(lines, headerEnd, indent);
      const name = def[2];
      if (owner) {
        spans.push({ symbol: `${owner}.${name}`, kind: "method", start: i + 1, end: end + 1 });
      } else if (def[1] === "class" && end - i + 1 > MAX_LINES) {
        const bodyStart = headerEnd + 1;
        const bodyIndent = indentOf(lines.slice(bodyStart, end + 1).find((l) => l.trim()) ?? "");
        spans.push({ symbol: name, kind: "class", start: i + 1, end: headerEnd + 1 });
        spans.push(...pythonBlockSpans(lines, bodyStart, end, bodyIndent, name));
      } else {
        spans.push({ symbol: name, kind: def[1] === "class" ? "class" : "function", start: i + 1, end: end + 1 });
      }
      i = end + 1;
    } else {
      spans.push(owner ? { symbol: owner, kind: "class", start: i + 1, end: i + 1 } : { symbol: null, kind: "module", start: i + 1, end: i + 1 });
      i++;
    }
  }
  return spans;
}

/** A def/class header may span lines (multi-line signature): consume until brackets balance. */
function pythonHeaderEnd(lines: string[], headerIdx: number): number {
  let k = headerIdx;
  for (let depth = 0; k < lines.length; k++) {
    const code = (lines[k] ?? "").replace(/(["'])(?:\\.|(?!\1).)*\1/g, "").replace(/#.*/, "");
    depth += (code.match(/[([{]/g)?.length ?? 0) - (code.match(/[)\]}]/g)?.length ?? 0);
    if (depth <= 0) return k;
  }
  return lines.length - 1;
}

/** Last line of a block: everything after the header indented deeper than `indent`. */
function pythonBlockEnd(lines: string[], headerEnd: number, indent: number): number {
  let last = headerEnd;
  for (let b = headerEnd + 1; b < lines.length; b++) {
    const line = lines[b] ?? "";
    if (!line.trim()) continue;
    if (indentOf(line) <= indent) break;
    last = b;
  }
  return last;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Merges consecutive module spans, and consecutive class-body spans of the same class. */
function mergeAdjacent(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    const mergeable = span.kind === "module" || span.kind === "class";
    if (prev && mergeable && prev.kind === span.kind && prev.symbol === span.symbol) {
      prev.end = span.end;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** Position of the first comment/token before the node, skipping blank lines. */
function startIncludingComments(node: ts.Node, sf: ts.SourceFile): number {
  const text = sf.text;
  let pos = node.getFullStart();
  const start = node.getStart(sf);
  while (pos < start && /\s/.test(text[pos] ?? "")) pos++;
  return pos;
}

function classifyStatement(stmt: ts.Statement): { symbol: string; kind: ChunkKind } | null {
  if (ts.isFunctionDeclaration(stmt) && stmt.name) return { symbol: stmt.name.text, kind: "function" };
  if (ts.isClassDeclaration(stmt) && stmt.name) return { symbol: stmt.name.text, kind: "class" };
  if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
    return { symbol: stmt.name.text, kind: "type" };
  }
  if (ts.isVariableStatement(stmt)) {
    const fn = stmt.declarationList.declarations.find((d) => d.initializer && isFunctionLike(d.initializer));
    if (fn && ts.isIdentifier(fn.name)) return { symbol: fn.name.text, kind: "function" };
  }
  // describe("x", () => ...), app.get("/route", handler): name the block after callee + label.
  if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
    const call = stmt.expression;
    const [label, ...rest] = call.arguments;
    if (label && ts.isStringLiteralLike(label) && rest.some(isFunctionLike)) {
      return { symbol: `${call.expression.getText()}(${JSON.stringify(label.text)})`, kind: "block" };
    }
  }
  return null;
}

function methodName(member: ts.ClassElement): string | null {
  if (ts.isConstructorDeclaration(member)) return "constructor";
  const isMethod =
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member) ||
    (ts.isPropertyDeclaration(member) && !!member.initializer && isFunctionLike(member.initializer));
  if (!isMethod || !member.name) return null;
  return ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name) || ts.isStringLiteral(member.name)
    ? member.name.text
    : null;
}

function isFunctionLike(node: ts.Expression): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node);
}
