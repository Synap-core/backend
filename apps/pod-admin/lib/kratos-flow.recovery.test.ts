/**
 * Recovery / settings flows reaching pod-admin, and the submit classifier.
 *
 * A pod whose kratos.yml predates /recovery and /settings/security sends
 * those flow ids to /login. The login page must resolve the id's kind and
 * forward it — never render a login form over a recovery flow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSelfServiceFlow,
  pageForFlow,
  submitSelfServiceFlow,
  type KratosFlow,
} from "./kratos-flow";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const notFound = () => json({ error: { code: 404, message: "not found" } }, 404);
const flow = (id: string): KratosFlow => ({
  id,
  ui: { action: "https://pod.example.com/self-service/x?flow=" + id, method: "POST", nodes: [] },
});

let calls: string[] = [];
beforeEach(() => {
  calls = [];
  process.env.POD_PUBLIC_URL = "https://pod.example.com";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.POD_PUBLIC_URL;
});

function stub(byKind: Partial<Record<string, () => Response>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const kind = /\/self-service\/([a-z]+)\//.exec(url)?.[1] ?? "?";
      return (byKind[kind] ?? notFound)();
    })
  );
}

describe("a recovery or settings flow id that lands on /login", () => {
  it("resolves as RECOVERY and is forwarded to /recovery", async () => {
    stub({ recovery: () => json(flow("rec-1")) });
    const r = await fetchSelfServiceFlow("rec-1");
    expect(r.kind).toBe("recovery");
    expect(calls.map((u) => /self-service\/([a-z]+)\//.exec(u)?.[1])).toEqual([
      "login",
      "registration",
      "recovery",
    ]);
    expect(pageForFlow(r.kind, "rec-1")).toBe("/recovery?flow=rec-1");
  });

  it("resolves as SETTINGS and is forwarded to /settings/security", async () => {
    stub({ settings: () => json(flow("set-1")) });
    const r = await fetchSelfServiceFlow("set-1");
    expect(r.kind).toBe("settings");
    expect(pageForFlow(r.kind, "set-1")).toBe("/settings/security?flow=set-1");
  });

  it("login and registration ids stay on /login", () => {
    expect(pageForFlow("login", "x")).toBeNull();
    expect(pageForFlow("registration", "x")).toBeNull();
  });

  it("a non-404 failure on the way is reported, not skipped", async () => {
    stub({ registration: () => json({ error: { message: "flow expired" } }, 410) });
    await expect(fetchSelfServiceFlow("f")).rejects.toThrow("flow expired");
    expect(calls).toHaveLength(2);
  });

  it("an id no endpoint knows is an error, not a login form", async () => {
    stub({});
    await expect(fetchSelfServiceFlow("ghost")).rejects.toThrow("not found");
    expect(calls).toHaveLength(4);
  });
});

describe("submitSelfServiceFlow", () => {
  it("a refresh-required answer is classified BEFORE its redirect is followed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            error: { id: "session_refresh_required", code: 403 },
            redirect_browser_to: "https://pod-admin.example.com/login?flow=refresh-1",
          },
          403
        )
      )
    );
    expect((await submitSelfServiceFlow(flow("s"), {})).kind).toBe("refresh_required");
  });

  it("a completed recovery code (422 location change) is a redirect to settings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            error: { id: "browser_location_change_required", code: 422 },
            redirect_browser_to: "https://pod-admin.example.com/settings/security?flow=s1",
          },
          422
        )
      )
    );
    expect(await submitSelfServiceFlow(flow("r"), { method: "code", code: "123456" })).toEqual({
      kind: "redirect",
      to: "https://pod-admin.example.com/settings/security?flow=s1",
    });
  });

  it("a re-rendered flow (validation) comes back as a flow", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(flow("r2"), 400)));
    const r = await submitSelfServiceFlow(flow("r"), {});
    expect(r.kind).toBe("flow");
  });
});
