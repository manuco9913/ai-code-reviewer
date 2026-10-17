// The GitHub operations DevFlow uses, as an SDK-style port. `GitHubClient` implements it over
// the REST/GraphQL APIs; tests use an in-memory fake.

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  state: string;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
}

export interface PullRequestFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  /** Null for binary files and diffs too large for the API. */
  patch: string | null;
  additions: number;
  deletions: number;
}

export interface Commit {
  sha: string;
  message: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  url: string;
}

export interface CheckRun {
  name: string;
  status: string;
  /** success | failure | neutral | cancelled | skipped | timed_out | action_required | null while running */
  conclusion: string | null;
}

export interface GitHubReader {
  getPullRequest(repo: string, number: number): Promise<PullRequest>;
  /** Most recently updated first. */
  listPullRequests(repo: string, state: "open" | "closed" | "all"): Promise<PullRequest[]>;
  /** Issues (not PRs) matching a GitHub search query, e.g. "map markers is:open". */
  searchIssues(repo: string, query: string): Promise<Issue[]>;
  listPullRequestFiles(repo: string, number: number): Promise<PullRequestFile[]>;
  listPullRequestCommits(repo: string, number: number): Promise<Commit[]>;
  /** Issues the PR will close (GitHub's "linked issues"). */
  getClosingIssueNumbers(repo: string, number: number): Promise<number[]>;
  /** Null when the number is a pull request or does not exist. */
  getIssue(repo: string, number: number): Promise<Issue | null>;
  /** Every file path in the repo at `ref`. */
  listFiles(repo: string, ref: string): Promise<string[]>;
  /** File content at `ref`, or null if absent. */
  getFile(repo: string, path: string, ref: string): Promise<string | null>;
  listCheckRuns(repo: string, sha: string): Promise<CheckRun[]>;
}
