// The page an emailed approval link opens. Opening it (GET) only shows the proposal; approving or
// rejecting is a POST, so link scanners and previews can never trigger a GitHub write.

import { esc } from "../html";
import { verifyActionToken } from "../security";
import {
  ActionConflictError,
  ActionNotFoundError,
  decideAction,
  type ActionStore,
  type GitHubWriter,
  type PendingAction,
} from "./actions";

export interface ApprovalRequest {
  method: string;
  actionId: string;
  token: string | null;
  /** From the submitted form; null on GET. */
  decision: "approve" | "reject" | null;
}

export interface ApprovalDeps {
  store: ActionStore;
  github: GitHubWriter;
  secret: string;
  now: () => number;
}

export async function approvalResponse(req: ApprovalRequest, deps: ApprovalDeps): Promise<{ status: number; html: string }> {
  if (!(await verifyActionToken(deps.secret, req.actionId, req.token, deps.now()))) {
    return page(403, "Link invalid or expired", "<p>This approval link is not valid any more. Open the latest DevFlow email or the dashboard.</p>");
  }

  if (req.method === "POST" && req.decision) {
    try {
      const decided = await decideAction(req.actionId, req.decision, deps);
      return page(200, outcomeTitle(decided), outcomeBody(decided));
    } catch (err) {
      if (err instanceof ActionConflictError) return page(409, "Already decided", `<p>This action was already ${esc(err.status)}.</p>`);
      if (err instanceof ActionNotFoundError) return page(404, "Not found", "<p>This action no longer exists.</p>");
      throw err;
    }
  }

  const action = await deps.store.get(req.actionId);
  if (!action) return page(404, "Not found", "<p>This action no longer exists.</p>");
  if (action.status !== "pending") return page(409, "Already decided", `<p>This action was already ${esc(action.status)}.</p>`);
  return page(200, action.title, `${proposal(action)}
<form method="post" style="display:flex;gap:12px;margin-top:24px">
  <input type="hidden" name="token" value="${esc(req.token ?? "")}">
  <button name="decision" value="approve" style="padding:10px 18px;background:#1d4ed8;color:#fff;border:0;border-radius:6px;cursor:pointer">Approve and post to GitHub</button>
  <button name="decision" value="reject" style="padding:10px 18px;background:#fff;border:1px solid #d0d5dd;border-radius:6px;cursor:pointer">Reject</button>
</form>`);
}

function proposal(action: PendingAction): string {
  const p = action.payload;
  const where = `<p style="color:#667085">${esc(action.repo)}</p>`;
  switch (p.kind) {
    case "pr_review": {
      const comments = p.comments
        .map((c) => `<li><code>${esc(c.path)}:${c.line}</code><pre style="white-space:pre-wrap">${esc(c.body)}</pre></li>`)
        .join("");
      return `${where}<h3>Review body</h3><pre style="white-space:pre-wrap">${esc(p.body)}</pre>
<h3>Inline comments (${p.comments.length})</h3><ul>${comments}</ul>`;
    }
    case "pr_comment":
      return `${where}<h3>Comment on PR #${p.prNumber}</h3><pre style="white-space:pre-wrap">${esc(p.body)}</pre>`;
    case "issue_update":
      return `${where}<h3>Update issue #${p.issueNumber}</h3>
${p.comment ? `<pre style="white-space:pre-wrap">${esc(p.comment)}</pre>` : ""}
${p.addLabels.length ? `<p>Add labels: ${p.addLabels.map((l) => `<code>${esc(l)}</code>`).join(", ")}</p>` : ""}`;
  }
}

function outcomeTitle(action: PendingAction): string {
  if (action.status === "executed") return "Done";
  if (action.status === "rejected") return "Rejected";
  return "GitHub refused the update";
}

function outcomeBody(action: PendingAction): string {
  if (action.status === "rejected") return "<p>Nothing was posted.</p>";
  const result = action.result as { url?: unknown; error?: unknown; comment?: { url?: unknown } | null } | null;
  if (action.status === "failed") return `<p>${esc(String(result?.error ?? "Unknown error"))}</p>`;
  const url = typeof result?.url === "string" ? result.url : typeof result?.comment?.url === "string" ? result.comment.url : null;
  return url ? `<p>Posted: <a href="${esc(url)}">${esc(url)}</a></p>` : "<p>Posted.</p>";
}

function page(status: number, title: string, body: string): { status: number; html: string } {
  return {
    status,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · DevFlow AI</title></head>
<body style="font-family:system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#101828">
<h1 style="font-size:22px">${esc(title)}</h1>${body}</body></html>`,
  };
}
