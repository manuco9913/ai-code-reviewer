// Issue numbers a PR's text refers to ("Fixes #12", "owner/repo#7"), same repo only, in order.

export function issueRefs(text: string, repo: string): number[] {
  const refs: number[] = [];
  for (const m of text.matchAll(/(?:^|[\s(,;:])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g)) {
    const [, otherRepo, num] = m;
    if (otherRepo && otherRepo.toLowerCase() !== repo.toLowerCase()) continue;
    const n = Number(num);
    if (!refs.includes(n)) refs.push(n);
  }
  return refs;
}
