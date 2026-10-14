// Finds the coding standards and review-relevant agent skills a repository defines, so the
// reviewer can hold a PR to the repo's own rules. Callers pass the repo at the PR's BASE commit,
// so a PR cannot weaken the rules it is reviewed against.

import { parse as parseYaml } from "yaml";
import { globMatcher } from "./glob";

export interface StandardDoc {
  path: string;
  content: string;
}

export interface Standards {
  source: "config" | "auto";
  docs: StandardDoc[];
  /** Globs of changed files the reviewer should not review (from .devflow.yml). */
  ignore: string[];
  /** Problems with .devflow.yml worth telling the user about; the review still runs. */
  warnings: string[];
}

export const CONFIG_FILE = ".devflow.yml";

/** Upper bound on standards text in the review prompt (~15k tokens). */
const MAX_STANDARDS_CHARS = 60_000;
/** Below this, a truncated document is more noise than signal. */
const MIN_USEFUL_CHARS = 2_000;

/** Root-level documents that state how code should be written, in priority order. */
const STANDARD_FILES = [
  "CODING_STANDARDS.md",
  "CONTRIBUTING.md",
  "CLAUDE.md",
  "AGENTS.md",
  ".github/copilot-instructions.md",
];

/** Skills that describe how code should look; process skills (grill-me, triage...) are not rules. */
const REVIEW_SKILLS = ["tdd", "improve-codebase-architecture", "code-convention-big-features"];
const SKILL_ROOTS = [".claude/skills", ".agents/skills"];

interface ConfigEntry {
  path: string;
  appliesTo: string[];
}

interface DevflowConfig {
  standards: ConfigEntry[];
  skills: string[];
  ignore: string[];
}

export async function loadStandards(
  paths: string[],
  read: (path: string) => Promise<string | null>,
  changedFiles: string[],
): Promise<Standards> {
  const warnings: string[] = [];
  const configText = paths.includes(CONFIG_FILE) ? await read(CONFIG_FILE) : null;
  const config = configText === null ? null : parseConfig(configText, warnings);

  if (!config) {
    const selected = [...autoStandardFiles(paths), ...skillFiles(paths, REVIEW_SKILLS)];
    return { source: "auto", docs: await readAll(selected, read, warnings), ignore: [], warnings };
  }

  const relevant = config.standards.filter(
    (entry) => !entry.appliesTo.length || changedFiles.some(globMatcher(entry.appliesTo)),
  );
  for (const entry of relevant) {
    if (!paths.includes(entry.path)) warnings.push(`${CONFIG_FILE}: standard "${entry.path}" not found`);
  }
  for (const skill of config.skills) {
    if (!skillFiles(paths, [skill]).length) warnings.push(`${CONFIG_FILE}: skill "${skill}" not found`);
  }
  const selected = [...relevant.map((e) => e.path), ...skillFiles(paths, config.skills)];
  return { source: "config", docs: await readAll(selected, read, warnings), ignore: config.ignore, warnings };
}

function autoStandardFiles(paths: string[]): string[] {
  const byLower = new Map(paths.map((p) => [p.toLowerCase(), p]));
  return STANDARD_FILES.flatMap((f) => byLower.get(f.toLowerCase()) ?? []);
}

/** SKILL.md plus its Markdown reference files; `.claude/skills` wins over `.agents/skills`. */
function skillFiles(paths: string[], skills: string[]): string[] {
  return skills.flatMap((skill) => {
    const root = SKILL_ROOTS.find((r) => paths.includes(`${r}/${skill}/SKILL.md`));
    if (!root) return [];
    const dir = `${root}/${skill}/`;
    const refs = paths.filter((p) => p.startsWith(dir) && p.endsWith(".md") && p !== `${dir}SKILL.md`).sort();
    return [`${dir}SKILL.md`, ...refs];
  });
}

/**
 * Reads documents in priority order within MAX_STANDARDS_CHARS: later documents are truncated or
 * dropped first, with a warning naming them.
 */
async function readAll(
  paths: string[],
  read: (path: string) => Promise<string | null>,
  warnings: string[],
): Promise<StandardDoc[]> {
  const contents = await Promise.all(paths.map(read));
  const docs: StandardDoc[] = [];
  const cut: string[] = [];
  let budget = MAX_STANDARDS_CHARS;
  paths.forEach((path, i) => {
    const content = contents[i];
    if (!content) return;
    if (content.length <= budget) {
      docs.push({ path, content });
      budget -= content.length;
    } else {
      cut.push(path);
      const marker = "\n[... truncated ...]";
      if (budget > MIN_USEFUL_CHARS) docs.push({ path, content: content.slice(0, budget - marker.length) + marker });
      budget = 0;
    }
  });
  if (cut.length) warnings.push(`Standards exceed ${MAX_STANDARDS_CHARS} characters; truncated or skipped: ${cut.join(", ")}`);
  return docs;
}

/** Narrows the YAML into a DevflowConfig; returns null (auto-discovery) when it is unusable. */
function parseConfig(text: string, warnings: string[]): DevflowConfig | null {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    warnings.push(`${CONFIG_FILE} is not valid YAML (${err instanceof Error ? err.message : err}); using auto-discovery`);
    return null;
  }
  if (!isRecord(raw)) {
    warnings.push(`${CONFIG_FILE} must be a mapping; using auto-discovery`);
    return null;
  }

  const standards: ConfigEntry[] = [];
  for (const item of asArray(raw.standards)) {
    if (typeof item === "string") standards.push({ path: item, appliesTo: [] });
    else if (isRecord(item) && typeof item.path === "string") {
      standards.push({ path: item.path, appliesTo: asArray(item.applies_to).filter(isString) });
    } else warnings.push(`${CONFIG_FILE}: ignored standards entry ${JSON.stringify(item)}`);
  }
  return {
    standards,
    skills: asArray(raw.skills).filter(isString),
    ignore: asArray(raw.ignore).filter(isString),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
