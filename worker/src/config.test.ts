import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const core = {
  GEMINI_API_KEY: "g",
  SUPABASE_URL: "https://p.supabase.co",
  SUPABASE_SERVICE_KEY: "s",
  GITHUB_TOKEN: "t",
  API_TOKEN: "a-long-enough-api-token-123456",
};
const automation = {
  GITHUB_WEBHOOK_SECRET: "w",
  APPROVAL_SECRET: "approval-secret-that-is-long-enough",
  PUBLIC_URL: "https://devflow.me.workers.dev",
  RESEND_API_KEY: "re_x",
  EMAIL_TO: "me@example.com, team@example.com",
};

describe("loadConfig", () => {
  it("runs without automation when none of its settings are present", () => {
    expect(loadConfig(core).automation).toBeNull();
  });

  it("reads the automation settings when all are present", () => {
    expect(loadConfig({ ...core, ...automation }).automation).toMatchObject({
      publicUrl: "https://devflow.me.workers.dev",
      emailTo: ["me@example.com", "team@example.com"],
      emailFrom: "DevFlow AI <onboarding@resend.dev>",
    });
  });

  it("fails fast, naming what is missing, when automation is only partly configured", () => {
    expect(() => loadConfig({ ...core, GITHUB_WEBHOOK_SECRET: "w" })).toThrow(/APPROVAL_SECRET.*PUBLIC_URL.*RESEND_API_KEY.*EMAIL_TO/);
  });

  it("uses low thinking by default for fast reviews, and validates an override", () => {
    expect(loadConfig(core).geminiThinkingLevel).toBe("low");
    expect(loadConfig({ ...core, GEMINI_THINKING_LEVEL: "default" }).geminiThinkingLevel).toBeNull();
    expect(loadConfig({ ...core, GEMINI_THINKING_LEVEL: "high" }).geminiThinkingLevel).toBe("high");
    expect(() => loadConfig({ ...core, GEMINI_THINKING_LEVEL: "max" })).toThrow(/GEMINI_THINKING_LEVEL/);
  });
});
