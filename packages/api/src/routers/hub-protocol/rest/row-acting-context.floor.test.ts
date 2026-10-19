/**
 * Every hub REST door that LOADS a row by id and then authorizes against it
 * floors a POD-PERSONAL row (workspaceId NULL) on its owner.
 *
 * Before `resolveRowActingContext`, these doors fed the row's NULL workspace to
 * `resolveActingContext`, which answers "pod-personal write, you are the owner"
 * WITHOUT comparing identities: any caller who knew the id could patch another
 * user's private session, mint themselves into its room, file outputs into it,
 * close its run, patch their artifact or capture into their run.
 *
 * Per door, driven through the real route:
 *   - another user's pod-personal row → the door's own 404, nothing reached;
 *   - the caller's own pod-personal row → the door's next step is reached;
 *   - a workspace row → membership decides, as before (member reaches,
 *     non-member is refused with nothing reached).
 * "Reached" is a probe on the step right after the floor (the service or the
 * governance membrane), so a pass cannot be a coincidental status code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MY_AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEMBER_WS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_WS = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ID = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({ reached: [] as string[] }));
const reach = (step: string) => h.reached.push(step);

vi.mock("@synap/database", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getWorkspaceMembership: async (_db: unknown, wsId: string) =>
    wsId === MEMBER_WS ? { role: "member" } : null,
}));
vi.mock("../../../utils/permission-check.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => {
    reach("membrane");
    return { denied: true, reason: "stop here" };
  },
}));
vi.mock("../../../services/capture-agent/resolve-capture-actor.js", () => ({
  resolveCaptureActorUserId: async () => undefined,
}));
vi.mock("../../../services/links/links-service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createLinks: async () => reach("createLinks"),
}));
vi.mock(
  "../../../services/focus-sessions/complete-session.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    completeFocusSession: async () => {
      reach("complete");
      return null;
    },
  })
);
vi.mock("../../../services/focus-sessions/cancel-session.js", () => ({
  cancelSession: async () => {
    reach("cancel");
    return null;
  },
}));
vi.mock("../../../services/focus-sessions/ensure-session-channel.js", () => ({
  ensureSessionChannel: async () => {
    reach("channel");
    return "room-1";
  },
}));
vi.mock("../../../services/focus-sessions/delegate-output.js", () => ({
  delegateExpectedOutput: async () => {
    reach("delegate");
    return { status: "not_found" };
  },
}));
vi.mock("../../../services/focus-sessions/block-output.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  blockExpectedOutput: async () => {
    reach("block");
    return { status: "not_found" };
  },
}));
vi.mock(
  "../../../services/focus-sessions/assert-output-ref-visible.js",
  () => ({
    isOutputRefVisible: async () => {
      reach("outputs");
      return false;
    },
  })
);
vi.mock("../../../services/agent-dispatch/cancel-run.js", () => ({
  cancelRun: async () => {
    reach("cancelRun");
    return { status: "not_found" };
  },
}));

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");
const { registerArtifactsRoutes } = await import("./artifacts.js");
const { registerRunsRoutes } = await import("./runs.js");
const { resolveRowActingContext } = await import("./_shared.js");
const { BLOCKED_REASONS } = await import("@synap/playbooks");
const { SESSION_ARTIFACT_KINDS } =
  await import("../../../services/focus-sessions/record-session-artifact.js");

function app(vars: Record<string, unknown> = {}): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", ME);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    for (const [k, v] of Object.entries(vars)) c.set(k as never, v as never);
    await next();
  });
  registerFocusSessionsRoutes(a);
  registerArtifactsRoutes(a);
  registerRunsRoutes(a);
  return a;
}

type Door = {
  name: string;
  method: "POST" | "PATCH";
  path: string;
  body?: unknown;
  /** The probe the step right after the floor records. */
  step: string;
  /** The 404 body the door gives a MISSING row — the floor must match it. */
  notFound: string;
};

const DOORS: Door[] = [
  {
    name: "PATCH /focus-sessions/:id",
    method: "PATCH",
    path: `/focus-sessions/${ID}`,
    body: { goal: "new goal" },
    step: "membrane",
    notFound: `Focus session ${ID} not found`,
  },
  {
    name: "POST /focus-sessions/:id/complete",
    method: "POST",
    path: `/focus-sessions/${ID}/complete`,
    body: {},
    step: "complete",
    notFound: `Focus session ${ID} not found`,
  },
  {
    name: "POST /focus-sessions/:id/cancel",
    method: "POST",
    path: `/focus-sessions/${ID}/cancel`,
    body: {},
    step: "cancel",
    notFound: `Focus session ${ID} not found`,
  },
  {
    name: "POST /focus-sessions/:id/used",
    method: "POST",
    path: `/focus-sessions/${ID}/used`,
    body: { capabilityKind: "tool", capabilityId: "t-1" },
    step: "createLinks",
    notFound: `Focus session ${ID} not found`,
  },
  {
    name: "POST /focus-sessions/:id/channel",
    method: "POST",
    path: `/focus-sessions/${ID}/channel`,
    step: "channel",
    notFound: `Focus session ${ID} not found`,
  },
  {
    name: "POST /focus-sessions/:id/outputs/delegate",
    method: "POST",
    path: `/focus-sessions/${ID}/outputs/delegate`,
    body: { expectedLabel: "Draft" },
    step: "delegate",
    notFound: `Focus session ${ID} not found`,
  },
  {
    name: "POST /focus-sessions/:id/outputs/block",
    method: "POST",
    path: `/focus-sessions/${ID}/outputs/block`,
    body: { expectedLabel: "Draft", blockedReason: BLOCKED_REASONS[0] },
    step: "block",
    notFound: `Focus session ${ID} not found`,
  },
  {
    name: "POST /focus-sessions/:id/outputs",
    method: "POST",
    path: `/focus-sessions/${ID}/outputs`,
    body: { kind: SESSION_ARTIFACT_KINDS[0], refId: "r-1" },
    step: "outputs",
    notFound: `Focus session ${ID} not found`,
  },
  {
    name: "POST /focus-sessions/:sessionId/complete-run",
    method: "POST",
    path: `/focus-sessions/${ID}/complete-run`,
    step: "runLookup",
    notFound: `Focus session ${ID} not found`,
  },
  {
    name: "PATCH /artifacts/:id",
    method: "PATCH",
    path: `/artifacts/${ID}`,
    body: { state: "kept" },
    step: "membrane",
    notFound: `Artifact ${ID} not found`,
  },
  {
    name: "POST /runs/:runId/cancel",
    method: "POST",
    path: `/runs/${ID}/cancel`,
    step: "cancelRun",
    notFound: "Run not found",
  },
  {
    name: "POST /runs/:runId/capture",
    method: "POST",
    path: `/runs/${ID}/capture`,
    body: { status: "completed" },
    step: "membrane",
    notFound: "Run not found",
  },
];

/**
 * Serve ONE row from every table a door loads. A run's owner is its session's
 * owner, so the run row points at a session row carrying `owner`.
 */
function serveRow(owner: string, workspaceId: string | null) {
  const session = {
    id: ID,
    userId: owner,
    workspaceId,
    goal: "g",
    status: "active",
    criteria: [],
    expectedOutputs: [],
    metadata: {},
  };
  const spies = [
    vi
      .spyOn(db.query.focusSessions, "findFirst")
      .mockResolvedValue(session as never),
    vi.spyOn(db.query.artifacts, "findFirst").mockResolvedValue({
      id: ID,
      userId: owner,
      workspaceId,
    } as never),
    vi.spyOn(db.query.playbookRuns, "findFirst").mockResolvedValue({
      id: ID,
      workspaceId,
      sessionId: SESSION,
      createdBy: MY_AGENT,
      status: "running",
    } as never),
    // complete-run's next step: the live-run lookup.
    vi.spyOn(db, "select").mockImplementation((() => {
      reach("runLookup");
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: async () => [],
      };
      return chain;
    }) as never),
  ];
  return () => spies.forEach((s) => s.mockRestore());
}

const send = (door: Door, vars?: Record<string, unknown>) =>
  app(vars).request(door.path, {
    method: door.method,
    headers: { "Content-Type": "application/json" },
    ...(door.body !== undefined ? { body: JSON.stringify(door.body) } : {}),
  });

describe("load-then-authorize hub doors floor a pod-personal row on its owner", () => {
  let restore: () => void = () => {};

  it("every door that calls resolveRowActingContext has a row in DOORS", async () => {
    // Derived, not trusted: count the call sites in the route files, so a new
    // door through the helper fails here until it is driven below. (`block` and
    // `unblock` share one call site; `block` stands for both.)
    const { readFileSync, readdirSync } = await import("fs");
    const { dirname, join } = await import("path");
    const { fileURLToPath } = await import("url");
    const dir = dirname(fileURLToPath(import.meta.url));
    const sites = readdirSync(dir)
      .filter(
        (f) => f.endsWith(".ts") && !f.includes(".test.") && f !== "_shared.ts"
      )
      .flatMap(
        (f) =>
          readFileSync(join(dir, f), "utf8").match(
            /resolveRowActingContext\(c,/g
          ) ?? []
      );
    expect(sites.length).toBe(DOORS.length);
  });
  beforeEach(() => {
    h.reached = [];
  });
  afterEach(() => restore());

  it("an agent key acting for its human reaches the human's personal session (PATCH)", async () => {
    restore = serveRow(ME, null);
    const patch = DOORS[0];
    expect(patch.name).toBe("PATCH /focus-sessions/:id");
    await send(patch, {
      agentUserId: MY_AGENT,
      apiKeyId: "k",
      keyType: "hub_inbound",
    });
    expect(h.reached).toContain("membrane");
  });

  for (const door of DOORS) {
    describe(door.name, () => {
      it("another user's pod-personal row → the missing-row 404, nothing reached", async () => {
        restore = serveRow(THEM, null);
        const res = await send(door);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: door.notFound });
        expect(h.reached).toEqual([]);
      });

      it("the caller's own pod-personal row → the next step is reached", async () => {
        restore = serveRow(ME, null);
        await send(door);
        expect(h.reached).toContain(door.step);
      });

      it("a workspace row the caller is a member of → reached (membership, unchanged)", async () => {
        // The row is owned by someone else: membership, not ownership, decides.
        restore = serveRow(THEM, MEMBER_WS);
        await send(door);
        expect(h.reached).toContain(door.step);
      });

      it("a workspace row the caller is NOT a member of → refused, nothing reached", async () => {
        restore = serveRow(THEM, OTHER_WS);
        const res = await send(door);
        expect([403, 404]).toContain(res.status);
        expect(h.reached).toEqual([]);
      });
    });
  }
});

describe("resolveRowActingContext — who holds a pod-personal row", () => {
  const ctx = (vars: Record<string, unknown>) => ({
    get: (k: string) => ({ userId: ME, ...vars })[k],
  });
  const personal = (userId: string | null) => ({ workspaceId: null, userId });
  const opts = { notFound: "gone" };

  it("an agent key acting for its human reaches the human's row", async () => {
    const r = await resolveRowActingContext(
      ctx({ agentUserId: MY_AGENT, apiKeyId: "k", keyType: "hub_inbound" }),
      personal(ME),
      opts
    );
    expect(r).toMatchObject({ ok: true, userId: ME, workspaceId: null });
  });

  it("an agent key reaches a row its own agent principal owns", async () => {
    const r = await resolveRowActingContext(
      ctx({ agentUserId: MY_AGENT, apiKeyId: "k", keyType: "hub_inbound" }),
      personal(MY_AGENT),
      opts
    );
    expect(r.ok).toBe(true);
  });

  it("the IS's is_internal key reaches any user's row (it may already name any user)", async () => {
    const r = await resolveRowActingContext(
      ctx({ apiKeyId: "k", keyType: "is_internal" }),
      personal(THEM),
      opts
    );
    expect(r.ok).toBe(true);
  });

  it.each([
    ["a person's own PAT", { apiKeyId: "k", keyType: "user_pat" }],
    ["a self-mintable service key", { apiKeyId: "k", keyType: "service" }],
    [
      "an agent key",
      { agentUserId: MY_AGENT, apiKeyId: "k", keyType: "hub_inbound" },
    ],
    ["a session", {}],
  ])("%s cannot reach another user's row → 404", async (_l, vars) => {
    const r = await resolveRowActingContext(ctx(vars), personal(THEM), opts);
    expect(r).toEqual({ ok: false, status: 404, error: "gone" });
  });

  it("a row with no owner fails closed", async () => {
    const r = await resolveRowActingContext(ctx({}), personal(null), opts);
    expect(r).toEqual({ ok: false, status: 404, error: "gone" });
  });
});
