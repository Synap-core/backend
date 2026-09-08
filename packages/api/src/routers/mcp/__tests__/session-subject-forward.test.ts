/**
 * The MCP door can SAY `subjectEntityId` — and the value REACHES the service.
 *
 * ASSERT REACHABILITY, NOT SHAPE. "The key is declared" is the most repeated
 * defect in this tree: a field on the wire that nobody populates, permanently
 * absent while every type checks. `synap_update_session` forwards its fields by
 * NAME — nine hand-listed lines — so a field declared in the tool schema and
 * omitted from that list is advertised to every model and silently dropped by
 * the one door a model actually speaks through. That is exactly what the tRPC
 * and Hub doors did with this field until 2026-09-08.
 *
 * So this drives the REAL handler with the REAL tool schema and captures what
 * the service was called with. The service is the only thing replaced.
 *
 * THREE MEANINGS, and the middle one is the trap: `undefined` leaves the anchor
 * alone, `null` CLEARS it, a uuid re-points it. A forward written as a truthy
 * check (`args.x ? {x: args.x} : {}`) passes the set case and turns the clear
 * into a no-op — an agent told "cleared" over a subject that is still there.
 *
 * WHAT THIS DOES NOT COVER: the visibility floor. It is not at this handler by
 * design — it lives inside `updateFocusSession`, the one door every caller of
 * that service passes through, and is pinned by
 * `routers/focus-sessions.subject-and-channel.test.ts`. A second copy here
 * would be the fork that made the output-ref check drift across doors in the
 * first place. This file proves the FORWARD; that one proves the FLOOR.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const captured = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../services/focus-sessions/update-session.js", async (orig) => {
  const actual =
    await orig<
      typeof import("../../../services/focus-sessions/update-session.js")
    >();
  return {
    ...actual,
    updateFocusSession: async (params: Record<string, unknown>) => {
      captured.calls.push(params);
      return { status: "updated", session: { id: params.sessionId } };
    },
  };
});

const { sessionHandlers } = await import("../handlers/session.js");

const MANIFEST = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../tools/mcp-tools.manifest.json"),
    "utf8"
  )
) as { tools: Array<{ name: string; inputSchema: Record<string, any> }> };

const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const ENTITY_ID = "55555555-5555-4555-8555-555555555555";

const run = async (args: Record<string, unknown>) =>
  sessionHandlers.synap_update_session!({
    toolName: "synap_update_session",
    args: { sessionId: SESSION_ID, ...args },
    userId: "user-1",
    apiKeyScopes: ["mcp.write", "mcp.read"],
    workspaceAccessible: false,
    caller: {} as never,
    lensCaller: {} as never,
  } as never);

const lastCall = () => captured.calls.at(-1)!;

beforeEach(() => {
  captured.calls.length = 0;
});

describe("the MANIFEST advertises the subject field", () => {
  it("is non-vacuous and still carries the tool", () => {
    // A scan over an empty manifest passes every assertion after it.
    expect(MANIFEST.tools.length).toBeGreaterThan(20);
  });

  it("declares subjectEntityId as nullable, and says the clear is a null", () => {
    const tool = MANIFEST.tools.find((t) => t.name === "synap_update_session");
    expect(
      tool,
      "synap_update_session missing from the manifest"
    ).toBeDefined();
    const field = tool!.inputSchema.properties.subjectEntityId;
    expect(field, "subjectEntityId is not advertised").toBeDefined();
    // `type: "string"` alone would advertise a field that cannot express the
    // clear — a model reading the schema would have no way to say "remove it".
    expect(field.type).toEqual(["string", "null"]);
    expect(String(field.description).toLowerCase()).toContain("null");
  });
});

describe("the HANDLER forwards it — all three meanings", () => {
  it("a uuid REACHES the service", async () => {
    await run({ subjectEntityId: ENTITY_ID });
    expect(lastCall()).toMatchObject({ subjectEntityId: ENTITY_ID });
  });

  it("an explicit null REACHES the service as null, not as absent", async () => {
    // THE discriminating row. A truthy-guarded forward passes the test above
    // and fails only here, and a schema check cannot see the difference at all.
    await run({ subjectEntityId: null });
    expect(lastCall()).toHaveProperty("subjectEntityId", null);
  });

  it("omitting it leaves the key OFF the service call", async () => {
    // Not `subjectEntityId: undefined` — the service distinguishes "absent"
    // from "cleared" by `!== undefined`, so a key that is always present with
    // an undefined value would still read as absent, but the day someone
    // changes that test to `in` it would silently start clearing anchors.
    await run({ goal: "Ship it" });
    expect(lastCall()).not.toHaveProperty("subjectEntityId");
  });

  it("a non-string, non-null value is DROPPED, never handed to the column", async () => {
    // A blanket `as string | null | undefined` cast would let this through to
    // a uuid column. The narrowing is what stops it.
    await run({ subjectEntityId: 42 });
    expect(lastCall()).not.toHaveProperty("subjectEntityId");
  });

  it("the forward does not disturb the fields beside it", async () => {
    await run({ subjectEntityId: ENTITY_ID, goal: "Ship it", progress: 60 });
    expect(lastCall()).toMatchObject({
      subjectEntityId: ENTITY_ID,
      goal: "Ship it",
      progress: 60,
    });
  });
});
