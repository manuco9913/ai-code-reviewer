// Request authenticity: GitHub webhook signatures and signed approval links. Web Crypto only, so
// it runs on Workers and Node alike.

import { constantTimeEqual } from "./http";

/** True when `signatureHeader` (X-Hub-Signature-256) is GitHub's HMAC of `body` with `secret`. */
export async function verifyGitHubSignature(body: string, signatureHeader: string | null, secret: string): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = `sha256=${await hmacHex(secret, body)}`;
  return constantTimeEqual(expected, signatureHeader);
}

/**
 * Token for an emailed approve/reject link: "<expiresAtMs>.<hmac(actionId, expiresAt)>". It proves
 * the link came from DevFlow for this action, without a login.
 */
export async function signActionToken(secret: string, actionId: string, expiresAtMs: number): Promise<string> {
  return `${expiresAtMs}.${await hmacHex(secret, `action:${actionId}:${expiresAtMs}`)}`;
}

export async function verifyActionToken(
  secret: string,
  actionId: string,
  token: string | null,
  nowMs: number,
): Promise<boolean> {
  const match = /^(\d+)\.([0-9a-f]{64})$/.exec(token ?? "");
  if (!match?.[1] || !match[2]) return false;
  const expiresAt = Number(match[1]);
  if (expiresAt < nowMs) return false;
  return constantTimeEqual(await hmacHex(secret, `action:${actionId}:${expiresAt}`), match[2]);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
