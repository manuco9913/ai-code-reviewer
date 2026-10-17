import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signActionToken, verifyActionToken, verifyGitHubSignature } from "./security";

const secret = "webhook-secret";
const body = '{"action":"opened"}';
const githubSignature = (payload: string, key: string) =>
  `sha256=${createHmac("sha256", key).update(payload).digest("hex")}`;

describe("verifyGitHubSignature", () => {
  it("accepts a body signed with the webhook secret", async () => {
    expect(await verifyGitHubSignature(body, githubSignature(body, secret), secret)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, or a missing signature", async () => {
    expect(await verifyGitHubSignature('{"action":"closed"}', githubSignature(body, secret), secret)).toBe(false);
    expect(await verifyGitHubSignature(body, githubSignature(body, "other"), secret)).toBe(false);
    expect(await verifyGitHubSignature(body, null, secret)).toBe(false);
  });
});

describe("approval link tokens", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 9, 17);

  it("verifies a token for the action it was issued for, until it expires", async () => {
    const token = await signActionToken(secret, "action-1", now + 7 * day);

    expect(await verifyActionToken(secret, "action-1", token, now)).toBe(true);
    expect(await verifyActionToken(secret, "action-2", token, now)).toBe(false);
    expect(await verifyActionToken(secret, "action-1", token, now + 8 * day)).toBe(false);
  });

  it("rejects a token whose expiry was edited or that is malformed", async () => {
    const token = await signActionToken(secret, "action-1", now + day);
    const [, mac] = token.split(".");

    expect(await verifyActionToken(secret, "action-1", `${now + 365 * day}.${mac}`, now)).toBe(false);
    expect(await verifyActionToken(secret, "action-1", "garbage", now)).toBe(false);
    expect(await verifyActionToken(secret, "action-1", null, now)).toBe(false);
  });
});
