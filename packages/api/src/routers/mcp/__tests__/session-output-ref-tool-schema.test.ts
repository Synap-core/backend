/**
 * The MCP door can SAY `ref` — and what it advertises actually parses.
 *
 * ASSERT REACHABILITY, NOT SHAPE. "The key is declared" is the single most
 * repeated defect in this tree: a field declared on the wire, populated by
 * nobody, rendering as permanently absent while every type checks. So this does
 * not merely look for the string `ref` in a JSON Schema. It takes the shapes the
 * tool DESCRIBES to the model and runs them through the pod's own enforcing
 * parse (`expectedOutputWireSchema`), in both arms, plus the refusals — because
 * a tool schema that advertises something the wire rejects is worse than one
 * that advertises nothing.
 *
 * The MCP handler forwards `expectedOutputs` and `addOutput` as whole objects
 * rather than re-listing fields, so the tool schema IS the contract for what a
 * model may send. That is why this block audits the schema and the parse, and
 * not a field list in the handler.
 *
 * WHAT THIS BLOCK DOES NOT COVER: whether the DOOR runs that parse. It used not
 * to — the second describe below is that seam, driven through the real handler.
 * Neither block proves the committed manifest is in step with `tools.list()`;
 * `gen:mcp-manifest` and `manifest-freshness.test.ts` own that.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectedOutputWireSchema } from "../../../services/focus-sessions/update-session.js";

const MANIFEST = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../tools/mcp-tools.manifest.json"),
    "utf8"
  )
) as { tools: Array<{ name: string; inputSchema: Record<string, any> }> };

const tool = (name: string) => {
  const t = MANIFEST.tools.find((x) => x.name === name);
  expect(t, `${name} is missing from the committed MCP manifest`).toBeDefined();
  return t!;
};

describe("MCP advertises `ref` on the declare doors", () => {
  it("the manifest is non-vacuous and still carries the session tools", () => {
    // A scan over an empty manifest passes every assertion after it.
    expect(MANIFEST.tools.length).toBeGreaterThan(20);
    expect(tool("synap_update_session")).toBeTruthy();
    expect(tool("synap_start_session")).toBeTruthy();
  });

  it.each([
    ["synap_update_session", "expectedOutputs"],
    ["synap_start_session", "expectedOutputs"],
  ])("%s.%s items declare ref with both arms", (name, prop) => {
    const items = tool(name).inputSchema.properties[prop].items;
    expect(items.properties.ref, `${name}.${prop}[].ref`).toBeDefined();
    const arms = items.properties.ref.oneOf as Array<Record<string, any>>;
    expect(arms).toHaveLength(2);
    expect(arms[0].required).toEqual(["kind", "id"]);
    expect(arms[1].required).toEqual(["url"]);
    // Both arms closed — an unknown key must be an error, never a silent strip.
    expect(arms.every((a) => a.additionalProperties === false)).toBe(true);
  });

  it("synap_update_session.addOutput declares ref too", () => {
    // Without it, "block this slot on the human AND point them at the page"
    // needs a second, wholesale patch — the field would be advertised on the
    // array door and unreachable on the one-call door beside it.
    const addOutput = tool("synap_update_session").inputSchema.properties
      .addOutput;
    expect(addOutput.properties.ref).toBeDefined();
    expect(addOutput.properties.ref.oneOf).toHaveLength(2);
  });

  it("every kind the manifest advertises is one the wire ACCEPTS", () => {
    // The reachability half. A kind a model is told to send and the parse then
    // refuses is an advertised dead end.
    const arms = tool("synap_update_session").inputSchema.properties
      .expectedOutputs.items.properties.ref.oneOf as Array<Record<string, any>>;
    const kinds = arms[0].properties.kind.enum as string[];
    expect(kinds.length).toBeGreaterThanOrEqual(6);
    for (const kind of kinds) {
      expect(() =>
        expectedOutputWireSchema.parse({
          kind: "document",
          label: "Launch brief",
          ref: { kind, id: "33333333-3333-4333-8333-333333333333" },
        })
      ).not.toThrow();
    }
  });

  it("the url arm the manifest advertises parses, and its abuses do not", () => {
    const slot = (ref: unknown) => ({
      kind: "url",
      label: "Stripe key",
      ref,
    });
    expect(() =>
      expectedOutputWireSchema.parse(
        slot({ url: "https://dashboard.stripe.com" })
      )
    ).not.toThrow();
    expect(() =>
      expectedOutputWireSchema.parse(slot({ url: "javascript:alert(1)" }))
    ).toThrow();
  });
});

/**
 * THE DOOR PARSES IT — the seam, not the schema.
 *
 * The block above proves the advertised shapes are ones the pod's parse
 * accepts. It cannot prove the MCP door ever RUNS that parse, and until this
 * wave it did not: `handlers/session.ts` cast `expectedOutputs` and `addOutput`
 * with `as` and handed them straight to the service. `outputRefWireSchema` ran
 * on the tRPC and Hub REST doors and on nothing that arrived here, so a seventh
 * `ref.kind` — outside the six every mirror of this union declares — was stored
 * verbatim by the one door a language model actually speaks through.
 *
 * Driven through the REAL handler with the REAL schemas (only the service is
 * replaced, and it THROWS): a refusal that reaches the write fails this test
 * rather than passing quietly, and a handler that stopped parsing would let the
 * bad ref through to the throw. Nothing here is hand-built downstream of the
 * parse.
 */
const serviceCalls = vi.hoisted(() => ({ update: 0, create: 0 }));

vi.mock("../../../services/focus-sessions/update-session.js", async (orig) => {
  const actual =
    await orig<
      typeof import("../../../services/focus-sessions/update-session.js")
    >();
  return {
    ...actual,
    updateFocusSession: async () => {
      serviceCalls.update += 1;
      throw new Error("THE WRITE WAS REACHED");
    },
  };
});
vi.mock("../../../services/focus-sessions/create-session.js", async (orig) => {
  const actual =
    await orig<
      typeof import("../../../services/focus-sessions/create-session.js")
    >();
  return {
    ...actual,
    createFocusSession: async () => {
      serviceCalls.create += 1;
      throw new Error("THE WRITE WAS REACHED");
    },
  };
});

const { sessionHandlers } = await import("../handlers/session.js");

const SESSION_ID = "44444444-4444-4444-8444-444444444444";

function ctxFor(toolName: string, args: Record<string, unknown>) {
  return {
    toolName,
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.write", "mcp.read"],
    workspaceAccessible: false,
    caller: {} as never,
    lensCaller: {} as never,
  };
}

/** The tool's text payload, which is where an MCP refusal is surfaced. */
function textOf(result: unknown): string {
  const first = (result as { content?: Array<Record<string, unknown>> })
    .content?.[0];
  return typeof first?.text === "string" ? first.text : "";
}

describe("the MCP door PARSES `ref` (it used to cast)", () => {
  beforeEach(() => {
    serviceCalls.update = 0;
    serviceCalls.create = 0;
  });

  it.each([
    [
      "a kind outside the union",
      { kind: "task", id: "33333333-3333-4333-8333-333333333333" },
    ],
    ["a script-capable url", { url: "javascript:alert(1)" }],
    [
      "both arms at once (strict)",
      { kind: "view", id: SESSION_ID, url: "https://x.test" },
    ],
  ])(
    "synap_update_session refuses %s on expectedOutputs, and writes nothing",
    async (_label, ref) => {
      const result = await sessionHandlers.synap_update_session!(
        ctxFor("synap_update_session", {
          sessionId: SESSION_ID,
          expectedOutputs: [{ kind: "document", label: "Brief", ref }],
        }) as never
      );
      expect(textOf(result)).toContain("Invalid output slot");
      expect(serviceCalls.update).toBe(0);
    }
  );

  it("synap_update_session refuses a bad `addOutput.ref` too", async () => {
    const result = await sessionHandlers.synap_update_session!(
      ctxFor("synap_update_session", {
        sessionId: SESSION_ID,
        addOutput: {
          kind: "url",
          label: "Key",
          ref: { url: "data:text/html,x" },
        },
      }) as never
    );
    expect(textOf(result)).toContain("Invalid output slot");
    expect(serviceCalls.update).toBe(0);
  });

  it("synap_start_session refuses one on the create door", async () => {
    const result = await sessionHandlers.synap_start_session!(
      ctxFor("synap_start_session", {
        goal: "Ship it",
        expectedOutputs: [
          {
            kind: "document",
            label: "Brief",
            ref: { kind: "task", id: SESSION_ID },
          },
        ],
      }) as never
    );
    expect(textOf(result)).toContain("Invalid output slot");
    expect(serviceCalls.create).toBe(0);
  });

  it("NON-VACUITY: a VALID ref reaches the service on both doors", async () => {
    // Without this, a handler that refused everything would pass every
    // assertion above. The service throws, so reaching it is observable.
    const good = {
      kind: "document",
      label: "Brief",
      ref: { kind: "view", id: SESSION_ID },
    };
    await expect(
      sessionHandlers.synap_update_session!(
        ctxFor("synap_update_session", {
          sessionId: SESSION_ID,
          expectedOutputs: [good],
        }) as never
      )
    ).rejects.toThrow("THE WRITE WAS REACHED");
    expect(serviceCalls.update).toBe(1);

    await expect(
      sessionHandlers.synap_start_session!(
        ctxFor("synap_start_session", {
          goal: "Ship it",
          expectedOutputs: [good],
        }) as never
      )
    ).rejects.toThrow("THE WRITE WAS REACHED");
    expect(serviceCalls.create).toBe(1);
  });
});
