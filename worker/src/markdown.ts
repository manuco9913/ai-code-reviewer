// Minimal Markdown → HTML for the chat UI. Every piece of text is escaped before a small, safe
// subset of markup is added, so repo or model text can never inject HTML or script URLs.

import { esc } from "./html";

const FENCE = /^```\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,4})\s+(.+)$/;
const BULLET = /^\s*[-*]\s+(.+)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.+)$/;

export function renderMarkdown(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      while (i + 1 < lines.length && !/^```\s*$/.test(lines[i + 1] ?? "")) code.push(lines[++i] ?? "");
      i++; // closing fence (or end of input)
      const lang = fence[1] ? ` class="language-${esc(fence[1])}"` : "";
      blocks.push(`<pre><code${lang}>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading?.[1] && heading[2]) {
      flush();
      blocks.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      flush();
      const pattern = BULLET.test(line) ? BULLET : NUMBERED;
      const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i] ?? "")) items.push(pattern.exec(lines[i++] ?? "")?.[1] ?? "");
      i--;
      const tag = pattern === BULLET ? "ul" : "ol";
      blocks.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (!line.trim()) flush();
    else paragraph.push(line.trim());
  }
  flush();
  return blocks.join("\n");
}

/** Inline code stays literal; other text gets bold and http(s) links. */
function inline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(
          /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
          (_m, label: string, url: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
        );
    })
    .join("");
}
