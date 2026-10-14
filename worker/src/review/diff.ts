// Turns a GitHub unified-diff patch into text the model can cite by line number.

export interface AnnotatedPatch {
  /** The patch with each new-file line prefixed by its line number; removed lines have none. */
  text: string;
  /** New-file lines GitHub accepts inline review comments on (added + context lines). */
  commentableLines: Set<number>;
  addedLines: number[];
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function annotatePatch(patch: string): AnnotatedPatch {
  const out: string[] = [];
  const commentableLines = new Set<number>();
  const addedLines: number[] = [];
  let line = 0;

  for (const raw of patch.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      out.push(raw);
      continue;
    }
    const marker = raw[0];
    const code = raw.slice(1);
    if (marker === "+") {
      out.push(`${String(line).padStart(5)} + ${code}`);
      commentableLines.add(line);
      addedLines.push(line);
      line++;
    } else if (marker === "-") {
      out.push(`      - ${code}`);
    } else if (marker === " ") {
      out.push(`${String(line).padStart(5)}   ${code}`);
      commentableLines.add(line);
      line++;
    }
    // "\ No newline at end of file" and anything else carries no line.
  }
  return { text: out.join("\n"), commentableLines, addedLines };
}
