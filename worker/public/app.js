// DevFlow AI web UI. Talks to the Worker's /api/* with the bearer token kept in localStorage.
// All text is inserted with textContent; the only HTML inserted is replyHtml, which the Worker
// renders from Markdown after escaping everything (worker/src/markdown.ts).

const $ = (id) => document.getElementById(id);

const store = {
  get(key) {
    try {
      return localStorage.getItem(`devflow.${key}`) ?? "";
    } catch {
      return "";
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`devflow.${key}`, value);
    } catch {
      // Private mode or blocked storage: the setting just won't be remembered.
    }
  },
};

/** @type {{ role: "user" | "assistant", text: string }[]} */
let history = [];
let busy = false;

// --- API ----------------------------------------------------------------------------------------

async function api(path, options = {}) {
  const token = store.get("token");
  if (!token) {
    openSettings();
    throw new Error("Add your API token in Settings first.");
  }
  const res = await fetch(path, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    openSettings();
    throw new Error("The API token was rejected. Check it in Settings.");
  }
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

function repo() {
  const value = $("repo").value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(value)) {
    $("repo").focus();
    throw new Error('Enter the repository as "owner/name" at the top.');
  }
  return value;
}

// --- DOM helpers --------------------------------------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const child of children) if (child) node.append(child);
  return node;
}

function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

function scrollChat() {
  const m = $("messages");
  m.scrollTop = m.scrollHeight;
}

// --- Chat ---------------------------------------------------------------------------------------

function addMessage(role, content) {
  $("empty")?.remove();
  const bubble = el("div", { className: "bubble" });
  if (content instanceof Node) bubble.append(content);
  else bubble.textContent = content;
  const msg = el("div", { className: `msg ${role}` }, [bubble]);
  $("messages").append(msg);
  scrollChat();
  return { msg, bubble };
}

async function send(text) {
  if (busy || !text.trim()) return;
  let repoName;
  try {
    repoName = repo();
  } catch (err) {
    toast(err.message);
    return;
  }
  busy = true;
  $("send").disabled = true;
  history.push({ role: "user", text });
  addMessage("user", text);

  const pending = addMessage("assistant", "");
  pending.bubble.classList.add("thinking");
  const started = Date.now();
  const tick = () => (pending.bubble.textContent = `Working… ${Math.round((Date.now() - started) / 1000)}s`);
  tick();
  const timer = setInterval(tick, 1000);

  try {
    const result = await api("/api/chat", { method: "POST", body: JSON.stringify({ repo: repoName, messages: history }) });
    history.push({ role: "assistant", text: result.reply });
    pending.bubble.classList.remove("thinking");
    pending.bubble.innerHTML = result.replyHtml || "<p>(no answer)</p>"; // server-escaped Markdown
    pending.msg.append(stepsMeta(result.steps, Date.now() - started));
    if (result.proposals?.length) {
      toast(`${result.proposals.length} update(s) proposed: approve them on the right.`);
      loadActions();
    }
  } catch (err) {
    history.pop(); // let the user retry the same question
    pending.msg.classList.add("error");
    pending.bubble.classList.remove("thinking");
    pending.bubble.textContent = err.message;
  } finally {
    clearInterval(timer);
    busy = false;
    $("send").disabled = false;
    scrollChat();
  }
}

function stepsMeta(steps, elapsedMs) {
  const meta = el("div", { className: "meta" }, [el("span", { text: `${Math.round(elapsedMs / 1000)}s` })]);
  for (const s of steps ?? []) {
    meta.append(el("span", { className: `tool${s.ok ? "" : " failed"}`, text: s.tool, attrs: { title: JSON.stringify(s.args) } }));
  }
  return meta;
}

// --- Review a PR --------------------------------------------------------------------------------

async function review(prNumber) {
  const out = $("review-result");
  const button = $("review-btn");
  let repoName;
  try {
    repoName = repo();
  } catch (err) {
    toast(err.message);
    return;
  }
  button.disabled = true;
  out.replaceChildren(el("p", { className: "hint", text: "Reviewing… this can take a minute." }));
  try {
    const r = await api("/api/review", { method: "POST", body: JSON.stringify({ repo: repoName, prNumber, propose: true }) });
    const findings = r.findings.map((f) =>
      el("div", { className: `finding ${f.severity}` }, [
        el("strong", { text: `${f.severity.toUpperCase()} · ${f.title}` }),
        el("span", { className: "where", text: `${f.file}${f.line ? `:${f.line}` : ""} · ${f.category}` }),
        el("div", { text: f.description }),
      ]),
    );
    out.replaceChildren(
      el("p", {}, [el("strong", { text: `${r.verdict.replace("_", " ")}: ` }), document.createTextNode(r.summary)]),
      ...(findings.length ? findings : [el("p", { className: "hint", text: "No findings." })]),
      el("p", { className: "hint", text: `Standards applied: ${r.standards.docs.join(", ") || "none found"}` }),
    );
    loadActions();
  } catch (err) {
    out.replaceChildren(el("p", { className: "action-result failed", text: err.message }));
  } finally {
    button.disabled = false;
  }
}

// --- Approvals ----------------------------------------------------------------------------------

async function loadActions() {
  const box = $("actions");
  try {
    const actions = await api("/api/actions?status=pending");
    if (!actions.length) {
      box.replaceChildren(el("p", { className: "hint", text: "Nothing waiting." }));
      return;
    }
    box.replaceChildren(...actions.map(actionCard));
  } catch (err) {
    box.replaceChildren(el("p", { className: "action-result failed", text: err.message }));
  }
}

function actionCard(action) {
  const p = action.payload;
  const preview =
    p.kind === "pr_review"
      ? `${p.body}\n\n${p.comments.map((c) => `--- ${c.path}:${c.line}\n${c.body}`).join("\n\n")}`
      : p.kind === "pr_comment"
        ? p.body
        : [p.comment, p.addLabels?.length ? `Labels: ${p.addLabels.join(", ")}` : ""].filter(Boolean).join("\n\n");
  const result = el("div", { className: "action-result" });
  const approve = el("button", { text: "Approve & post", className: "small" });
  const reject = el("button", { text: "Reject", className: "danger small" });

  const decide = async (decision) => {
    approve.disabled = reject.disabled = true;
    try {
      const done = await api(`/api/actions/${encodeURIComponent(action.id)}/${decision}`, { method: "POST" });
      result.className = `action-result ${done.status === "failed" ? "failed" : "ok"}`;
      result.textContent =
        done.status === "executed" ? `Posted${done.result?.url ? `: ${done.result.url}` : "."}` : done.status === "rejected" ? "Rejected." : `GitHub refused: ${done.result?.error ?? "unknown error"}`;
      setTimeout(loadActions, 2500);
    } catch (err) {
      result.className = "action-result failed";
      result.textContent = err.message;
      approve.disabled = reject.disabled = false;
    }
  };
  approve.addEventListener("click", () => decide("approve"));
  reject.addEventListener("click", () => decide("reject"));

  return el("div", { className: "action" }, [
    el("div", { className: "action-title", text: action.title }),
    el("div", { className: "action-repo", text: action.repo }),
    el("details", {}, [el("summary", { text: "What will be posted" }), el("pre", { text: preview })]),
    el("div", { className: "action-buttons" }, [approve, reject]),
    result,
  ]);
}

// --- Settings & wiring --------------------------------------------------------------------------

function openSettings() {
  $("token").value = store.get("token");
  if (!$("settings").open) $("settings").showModal();
}

$("settings-form").addEventListener("submit", () => {
  store.set("token", $("token").value.trim());
  loadActions();
});
$("settings-btn").addEventListener("click", openSettings);

$("repo").value = store.get("repo");
$("repo").addEventListener("change", () => {
  store.set("repo", $("repo").value.trim());
  history = [];
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("prompt").value;
  $("prompt").value = "";
  send(text);
});
$("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});
$("clear").addEventListener("click", () => {
  history = [];
  $("messages").replaceChildren();
  $("prompt").focus();
});
for (const chip of document.querySelectorAll("[data-prompt]")) {
  chip.addEventListener("click", () => send(chip.dataset.prompt));
}
$("review-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const n = Number($("pr-number").value);
  if (Number.isInteger(n) && n > 0) review(n);
});
$("refresh").addEventListener("click", loadActions);

if (store.get("token")) loadActions();
else openSettings();
