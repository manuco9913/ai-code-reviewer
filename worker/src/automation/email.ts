// Renders the review summary email. Everything from the PR or the model is HTML-escaped.

import type { PendingAction } from "../actions/actions";
import { esc } from "../html";
import type { ReviewResult } from "../review/reviewer";

export interface Email {
  subject: string;
  html: string;
  text: string;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#b42318",
  high: "#c4320a",
  medium: "#b54708",
  low: "#475467",
  info: "#475467",
};

export function reviewEmail(result: ReviewResult, actions: { action: PendingAction; url: string }[]): Email {
  const verdict = result.verdict.replace("_", " ");
  const subject = `[DevFlow] ${result.repo} #${result.prNumber}: ${verdict}, ${result.findings.length} finding(s)`;

  const findings = result.findings.map(
    (f) => `<li style="margin-bottom:12px">
  <strong style="color:${SEVERITY_COLORS[f.severity] ?? "#475467"}">${esc(f.severity.toUpperCase())}</strong>
  <strong>${esc(f.title)}</strong> <span style="color:#667085">(${esc(f.category)}) ${esc(f.file)}${f.line ? `:${f.line}` : ""}</span>
  <div>${esc(f.description)}</div>
  ${f.rule ? `<div style="color:#667085">Rule: ${esc(f.rule)}</div>` : ""}
  ${f.suggestion ? `<div><em>Suggested fix:</em> ${esc(f.suggestion)}</div>` : ""}
</li>`,
  );
  const buttons = actions.map(
    ({ action, url }) =>
      `<p><a href="${esc(url)}" style="display:inline-block;padding:10px 16px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:6px">Review &amp; approve: ${esc(action.title)}</a></p>`,
  );
  const req = result.linkedIssues.length
    ? `<p><strong>Requirements (${result.linkedIssues.map((n) => `#${n}`).join(", ")}):</strong> ${esc(result.requirements.status.replace("_", " "))}. ${esc(result.requirements.notes)}</p>`
    : "";

  const html = `<div style="font-family:system-ui,sans-serif;max-width:680px;color:#101828">
<h2 style="margin-bottom:4px">${esc(result.prTitle)}</h2>
<p style="margin-top:0"><a href="${esc(result.prUrl)}">${esc(result.repo)} #${result.prNumber}</a>, verdict: <strong>${esc(verdict)}</strong></p>
<p>${esc(result.summary)}</p>
${req}
${findings.length ? `<h3>Findings</h3><ol>${findings.join("\n")}</ol>` : "<p>No findings.</p>"}
<h3>Nothing has been posted yet</h3>
<p>Each link opens a confirmation page; GitHub is only updated after you approve there.</p>
${buttons.join("\n")}
</div>`;

  const text = [
    `${result.repo} #${result.prNumber}: ${result.prTitle}`,
    `Verdict: ${verdict}`,
    "",
    result.summary,
    "",
    ...result.findings.map((f) => `- [${f.severity}] ${f.title} (${f.file}${f.line ? `:${f.line}` : ""})`),
    "",
    "Approve or reject (nothing is posted until you do):",
    ...actions.map(({ action, url }) => `- ${action.title}: ${url}`),
  ].join("\n");

  return { subject, html, text };
}
