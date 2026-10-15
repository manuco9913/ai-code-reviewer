import { describe, expect, it } from "vitest";
import { Supabase } from "./supabase";

describe("Supabase", () => {
  it("accepts the project URL with or without the /rest/v1 suffix the dashboard shows", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response("[]");
    }) as typeof fetch;

    for (const base of ["https://p.supabase.co", "https://p.supabase.co/", "https://p.supabase.co/rest/v1/"]) {
      await new Supabase(base, "sb_secret_x", fetchFn).select("code_files", { select: "path" });
    }

    expect(new Set(urls)).toEqual(new Set(["https://p.supabase.co/rest/v1/code_files?select=path"]));
  });
});
