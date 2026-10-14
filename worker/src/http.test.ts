import { describe, expect, it } from "vitest";
import { isAuthorized } from "./http";

const req = (auth?: string) => new Request("https://x/api/review", { headers: auth ? { authorization: auth } : {} });

describe("isAuthorized", () => {
  it("accepts only the exact bearer token", () => {
    expect(isAuthorized(req("Bearer s3cret-token"), "s3cret-token")).toBe(true);
    expect(isAuthorized(req("Bearer s3cret-tokeN"), "s3cret-token")).toBe(false);
    expect(isAuthorized(req("Bearer s3cret"), "s3cret-token")).toBe(false);
    expect(isAuthorized(req("s3cret-token"), "s3cret-token")).toBe(false);
    expect(isAuthorized(req(), "s3cret-token")).toBe(false);
  });
});
