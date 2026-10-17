// GitHubReader over the GitHub REST and GraphQL APIs. The only Worker code that knows GitHub URLs.

import type { GitHubWriter, InlineReviewComment } from "../actions/actions";
import type { CheckRun, Commit, GitHubReader, Issue, PullRequest, PullRequestFile } from "./types";

const API = "https://api.github.com";
const MAX_FILE_PAGES = 3; // 300 files: GitHub's own per-PR diff limit

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export class GitHubClient implements GitHubReader, GitHubWriter {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch,
  ) {}

  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    const pr = await this.get<RawPull>(`/repos/${repo}/pulls/${number}`);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "",
      url: pr.html_url,
      state: pr.state,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
    };
  }

  async listPullRequestFiles(repo: string, number: number): Promise<PullRequestFile[]> {
    const files: PullRequestFile[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const batch = await this.get<RawFile[]>(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
      files.push(
        ...batch.map((f) => ({
          path: f.filename,
          status: f.status,
          patch: f.patch ?? null,
          additions: f.additions,
          deletions: f.deletions,
        })),
      );
      if (batch.length < 100) break;
    }
    return files;
  }

  async listPullRequestCommits(repo: string, number: number): Promise<Commit[]> {
    const commits = await this.get<{ sha: string; commit: { message: string } }[]>(
      `/repos/${repo}/pulls/${number}/commits?per_page=100`,
    );
    return commits.map((c) => ({ sha: c.sha, message: c.commit.message }));
  }

  async getClosingIssueNumbers(repo: string, number: number): Promise<number[]> {
    const [owner, name] = repo.split("/");
    const data = await this.request<{
      data?: { repository?: { pullRequest?: { closingIssuesReferences?: { nodes?: { number: number }[] } } } };
    }>("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: `query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) { closingIssuesReferences(first: 10) { nodes { number } } }
          }
        }`,
        variables: { owner, name, number },
      }),
    });
    return data.data?.repository?.pullRequest?.closingIssuesReferences?.nodes?.map((n) => n.number) ?? [];
  }

  async getIssue(repo: string, number: number): Promise<Issue | null> {
    const issue = await this.getOrNull<RawIssue>(`/repos/${repo}/issues/${number}`);
    if (!issue || issue.pull_request) return null; // the issues API also returns PRs
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      labels: issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
      url: issue.html_url,
    };
  }

  async listFiles(repo: string, ref: string): Promise<string[]> {
    const tree = await this.get<{ tree: { path: string; type: string }[] }>(
      `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    );
    return tree.tree.filter((t) => t.type === "blob").map((t) => t.path);
  }

  async getFile(repo: string, path: string, ref: string): Promise<string | null> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const res = await this.fetchFn(`${API}/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
      headers: this.headers("application/vnd.github.raw+json"),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubError(`GitHub GET contents/${path} failed (${res.status})`, res.status);
    return res.text();
  }

  // --- Writes: only ever called by an approved pending action. ---------------------------------

  async createReview(
    repo: string,
    prNumber: number,
    review: { commitId: string; body: string; comments: InlineReviewComment[] },
  ): Promise<{ url: string }> {
    const created = await this.request<{ html_url: string }>(`/repos/${repo}/pulls/${prNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        commit_id: review.commitId,
        body: review.body,
        event: "COMMENT",
        comments: review.comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
      }),
    });
    return { url: created.html_url };
  }

  async createIssueComment(repo: string, number: number, body: string): Promise<{ url: string }> {
    const created = await this.request<{ html_url: string }>(`/repos/${repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    return { url: created.html_url };
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    await this.request(`/repos/${repo}/issues/${number}/labels`, { method: "POST", body: JSON.stringify({ labels }) });
  }

  async listCheckRuns(repo: string, sha: string): Promise<CheckRun[]> {
    try {
      const data = await this.get<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(
        `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      );
      return data.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }));
    } catch (err) {
      // Tokens without the Checks permission get 403; CI context is nice-to-have, not required.
      if (err instanceof GitHubError && (err.status === 403 || err.status === 404)) return [];
      throw err;
    }
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  private async getOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.get<T>(path);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  private async request<T>(path: string, init: { method: string; body?: string }): Promise<T> {
    const res = await this.fetchFn(`${API}${path}`, { ...init, headers: this.headers("application/vnd.github+json") });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new GitHubError(`GitHub ${init.method} ${path} failed (${res.status}): ${detail}`, res.status);
    }
    // Cast once at the edge: shapes follow GitHub's documented REST/GraphQL schemas.
    return (await res.json()) as T;
  }

  private headers(accept: string): Record<string, string> {
    return {
      accept,
      authorization: `Bearer ${this.token}`,
      "user-agent": "devflow-ai",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    };
  }
}

interface RawPull {
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  html_url: string;
  state: string;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}

interface RawFile {
  filename: string;
  status: PullRequestFile["status"];
  patch?: string;
  additions: number;
  deletions: number;
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: (string | { name?: string })[];
  html_url: string;
  pull_request?: unknown;
}
