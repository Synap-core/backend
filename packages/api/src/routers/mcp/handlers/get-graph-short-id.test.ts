/**
 * `synap_get_graph` must never hand a non-uuid to a uuid column.
 *
 * Measured live 2026-09-22: `synap_get_graph({ id: "9d43e988" })` — the 8-char
 * short id the product prints elsewhere — returned the generic pod-side fault
 * ("failed against the pod's storage layer... this is a pod-side fault, not
 * something your arguments caused"). It WAS the argument: the id went into a
 * uuid comparison and Postgres threw 22P02. The tool ALSO advertised
 * "uuid, or kind short-id", so the short-id path was promised and never built.
 *
 * Both halves are fixed: the door refuses a non-uuid with an actionable
 * message, and the schema no longer promises short ids.
 *
 * WHAT THIS DOES NOT COVER: it does not implement short-id resolution. If that
 * is wanted, mirror `resolveProposalId` (uuid passthrough → prefix regex →
 * visibility-scoped LIKE → ambiguity) per kind.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * BEHAVIOURAL, not positional. A first version of this test asserted only that
 * the guard's TEXT appeared before `buildGraphEnvelope(` — and
 * `if (false && !GRAPH_UUID_RE.test(gId))` kept that text exactly where it was,
 * so the mutation ran and the suite stayed GREEN. The mock below fails the test
 * if the envelope builder is reached at all, which `&& false` cannot survive.
 */
const h = vi.hoisted(() => ({ envelopeCalls: 0 }));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildGraphEnvelope: vi.fn(
    async (_u: string, _s: string[], _k: string, id: string) => {
      h.envelopeCalls += 1;
      // The REAL driver behaviour: a uuid column refuses a non-uuid with 22P02.
      // A kind whose ids are not uuids (capability: "exa-search") does NOT throw
      // — which is exactly why the handler catches the driver's verdict instead
      // of guessing the shape itself.
      const idIsUuidColumn = _k !== "capability"; // entity/session/... are uuid
      if (
        idIsUuidColumn &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id
        )
      ) {
        const e = new Error("Failed query") as Error & { cause?: unknown };
        e.cause = {
          code: "22P02",
          message: "invalid input syntax for type uuid",
        };
        throw e;
      }
      return {
        object: { kind: "entity", id },
        neighbors: [],
        counts: {},
        found: true,
      };
    }
  ),
}));

import { readHandlers } from "./read.js";
import type { McpToolContext } from "./shared.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(here, "../tools/mcp-tools.manifest.json"), "utf8")
) as { tools?: Array<{ name: string }> };

function ctx(id: string): McpToolContext {
  return {
    toolName: "synap_get_graph",
    args: { id },
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
  };
}

async function graph(id: string) {
  const result = await readHandlers.synap_get_graph!(ctx(id));
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text");
  return JSON.parse(block.text) as { error?: string; hint?: string };
}

describe("synap_get_graph refuses a non-uuid before it reaches SQL", () => {
  it("turns the driver's 22P02 into an actionable error, not a pod-side fault", async () => {
    const out = await graph("9d43e988");
    expect(out.error).toMatch(/not a valid id/i);
    expect(out.error).toMatch(/short ids are not resolved/i);
    expect(out.hint).toMatch(/name/);
  });

  it("does NOT refuse a non-uuid id for a kind whose ids are not uuids", async () => {
    // The regression this replaced: a blanket uuid guard broke `capability`,
    // whose ids look like "exa-search". The driver does not throw for those,
    // so neither may we.
    const result = await readHandlers.synap_get_graph!({
      ...ctx("exa-search"),
      args: { id: "exa-search", type: "capability" },
    } as McpToolContext);
    const block = result.content?.[0];
    const parsed = JSON.parse(block!.type === "text" ? block!.text : "{}");
    expect(parsed.error).toBeUndefined();
  });

  it("lets a real uuid THROUGH and returns the envelope", async () => {
    // Non-vacuity: if the handler errored on everything, the tests above would
    // still pass.
    h.envelopeCalls = 0;
    const out = (await graph("9d43e988-620f-41f7-8362-00b87126885d")) as Record<
      string,
      unknown
    >;
    expect(out.error).toBeUndefined();
    expect(h.envelopeCalls).toBe(1);
  });

  it("the SHIPPED schema no longer promises short ids", () => {
    const tool = (manifest.tools ?? []).find(
      (t) => t.name === "synap_get_graph"
    );
    expect(tool, "synap_get_graph missing from manifest").toBeTruthy();
    const text = JSON.stringify(tool);
    expect(text).not.toContain("short-id");
    expect(text).toContain("FULL uuid");
  });
});
