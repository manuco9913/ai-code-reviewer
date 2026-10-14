// Minimal path globs for .devflow.yml: `**` any depth, `*` within a segment, `?` one char.

export function globMatcher(globs: string[]): (path: string) => boolean {
  const patterns = globs.map(toRegExp);
  return (path) => patterns.some((p) => p.test(path));
}

function toRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? "";
    if (glob.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      re += ".*";
      i += 1;
    } else if (ch === "*") {
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}
