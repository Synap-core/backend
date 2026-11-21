/**
 * Every write that places content sends the client's default workspaceId when
 * the call names none (founder, 21 Nov 2026, finding f4afb522): createEntity
 * included, like createRelation / attachFacet / createThread / createView /
 * createDocument already did. Before, createEntity, captureGraph and
 * executeCapability dropped the default, so a task created through a client
 * configured for a workspace was missing from that client's next scoped list
 * (agent report b167fdfe).
 *
 * The definitions whose omitted workspace means "pod-wide" or "the playbook's
 * own home" keep that meaning; their test pins it, so the config doc that
 * names them stays true.
 *
 * What this does NOT cover: the lists below are hand-kept, not derived. A
 * static scan of client.ts was tried and dropped: most writes forward `input`
 * whole, so a method's text does not show whether it carries a workspaceId,
 * and JSDoc of the next method bleeds into a per-method slice. A NEW write
 * method joins this check only when someone adds it here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubRestClient } from "./client.js";

const DEFAULT_WS = "ws-default";

let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ status: "created", id: "e-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function client(workspaceId?: string): HubRestClient {
  return new HubRestClient({
    podUrl: "https://pod.example.test",
    apiKey: "synap_hub_test_key",
    ...(workspaceId ? { workspaceId } : {}),
  });
}

function lastBody(path: string): Record<string, unknown> {
  const call = [...calls].reverse().find((c) => c.url.includes(path));
  if (!call) throw new Error(`no request to ${path}`);
  return call.body as Record<string, unknown>;
}

/** The content writes, each called with no workspaceId of its own. */
const contentWrites: Array<{
  name: string;
  path: string;
  call: (c: HubRestClient, workspaceId?: string) => Promise<unknown>;
}> = [
  {
    name: "createEntity",
    path: "/api/hub/entities",
    call: (c, workspaceId) =>
      c.createEntity({
        profileSlug: "task",
        title: "Fix bug",
        ...(workspaceId ? { workspaceId } : {}),
      }),
  },
  {
    name: "submitCaptureGraph",
    path: "/api/hub/capture/graph",
    call: (c, workspaceId) =>
      c.submitCaptureGraph({
        entities: [{ ref: "t", profileSlug: "task", title: "Fix bug" }],
        ...(workspaceId ? { workspaceId } : {}),
      }),
  },
  {
    name: "executeCapability",
    path: "/api/hub/capabilities/execute",
    call: (c, workspaceId) =>
      c.executeCapability({
        verbId: "entity.create",
        parameters: { title: "Fix bug" },
        ...(workspaceId ? { workspaceId } : {}),
      }),
  },
];

describe("content writes follow the client's default workspace", () => {
  for (const w of contentWrites) {
    it(`${w.name} with no workspaceId sends the configured default`, async () => {
      await w.call(client(DEFAULT_WS));
      expect(lastBody(w.path).workspaceId).toBe(DEFAULT_WS);
    });

    it(`${w.name} with its own workspaceId sends that one`, async () => {
      await w.call(client(DEFAULT_WS), "ws-named");
      expect(lastBody(w.path).workspaceId).toBe("ws-named");
    });

    it(`${w.name} on a client with no default sends no workspaceId`, async () => {
      await w.call(client());
      expect(lastBody(w.path)).not.toHaveProperty("workspaceId");
    });
  }

  it("submitCaptureGraph with workspaceId null stays pod-wide", async () => {
    await client(DEFAULT_WS).submitCaptureGraph({
      workspaceId: null,
      entities: [{ ref: "t", profileSlug: "task", title: "Fix bug" }],
    });
    expect(lastBody("/api/hub/capture/graph")).not.toHaveProperty(
      "workspaceId"
    );
  });
});

describe("definitions keep their own home when the call names none", () => {
  it("createProject stays pod-wide", async () => {
    await client(DEFAULT_WS).createProject({ name: "Atlas" });
    expect(lastBody("/api/hub/projects")).not.toHaveProperty("workspaceId");
  });

  it("createSkill stays pod-wide", async () => {
    await client(DEFAULT_WS).createSkill({ name: "s", body: "b", slug: "a/s" });
    expect(lastBody("/api/hub/skills")).not.toHaveProperty("workspaceId");
  });

  it("defineCell stays pod-global", async () => {
    await client(DEFAULT_WS).defineCell({ name: "c", rendererSource: "x" });
    expect(lastBody("/api/hub/cells/define")).not.toHaveProperty("workspaceId");
  });

  it("runPlaybook runs in the playbook's own workspace", async () => {
    await client(DEFAULT_WS).runPlaybook("pb-1");
    expect(lastBody("/api/hub/playbooks/pb-1/run")).not.toHaveProperty(
      "workspaceId"
    );
  });
});
