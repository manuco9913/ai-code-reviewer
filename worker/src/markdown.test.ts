import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("escapes HTML in the text so repo content can't inject markup", () => {
    expect(renderMarkdown('<script>alert(1)</script> <img src=x onerror="y">')).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=&quot;y&quot;&gt;</p>",
    );
  });

  it("links only http(s) URLs", () => {
    expect(renderMarkdown("[docs](https://example.com/a?b=1&c=2)")).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>',
    );
    expect(renderMarkdown("[click](javascript:alert(1))")).toBe("<p>[click](javascript:alert(1))</p>");
  });

  it("renders code blocks literally, with no formatting inside them", () => {
    const md = ["Before:", "", "```ts", "const a = **not bold** && b < c;", "```"].join("\n");

    expect(renderMarkdown(md)).toBe(
      '<p>Before:</p>\n<pre><code class="language-ts">const a = **not bold** &amp;&amp; b &lt; c;</code></pre>',
    );
  });

  it("renders headings, bold, inline code and lists", () => {
    const md = ["### 1. Validation", "Uses **Ajv** in `formModel.ts:23`.", "", "- one", "- two **x**", "", "1. first", "2. second"].join("\n");

    expect(renderMarkdown(md)).toBe(
      [
        "<h3>1. Validation</h3>",
        "<p>Uses <strong>Ajv</strong> in <code>formModel.ts:23</code>.</p>",
        "<ul><li>one</li><li>two <strong>x</strong></li></ul>",
        "<ol><li>first</li><li>second</li></ol>",
      ].join("\n"),
    );
  });
});
