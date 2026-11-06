/**
 * market.install — an agent template reaches the one install door.
 *
 * The browser routes an `agent` package (Marketplace "Agents" tab) to
 * `market.install` with `kind: "agent"`; `runMarketInstall` has a
 * `case "agent"` (one write: `installAgentTemplate`). This drives the REAL
 * registered handler and its REAL param schema into a mocked
 * `runMarketInstall`, so the seam between the verb and the install door is
 * what is tested: the kind is accepted (not a 400 at the schema) and arrives
 * unchanged. Like `builtin-verbs-market-scaffold.test.ts`, it does not mock
 * `@synap/database`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";

const runMarketInstallMock = vi.fn();
vi.mock("./marketplace-install.js", () => ({
  runMarketInstall: runMarketInstallMock,
}));
vi.mock("./market-sources.js", () => ({
  resolveMarketSource: async () => ({ official: true, cacheKey: "synap" }),
  listMarketSources: async () => [],
}));

import { BUILTIN_VERBS, BUILTIN_VERB_PARAM_SCHEMAS } from "./builtin-verbs.js";

const ctx = { userId: "user-1", workspaceId: null };

beforeEach(() => {
  runMarketInstallMock.mockReset();
  runMarketInstallMock.mockResolvedValue({
    kind: "agent",
    status: "installed",
  });
});

describe("market.install — kind agent", () => {
  it("the param schema accepts an agent package", () => {
    // The record is typed by its `shape` only; the value is a Zod object.
    const schema = BUILTIN_VERB_PARAM_SCHEMAS[
      "market.install"
    ] as unknown as z.ZodTypeAny;
    expect(schema).toBeDefined();
    expect(
      schema.safeParse({ slug: "claude-code", kind: "agent" }).success
    ).toBe(true);
    // Non-vacuity: the schema still refuses a kind it does not know.
    expect(
      schema.safeParse({ slug: "claude-code", kind: "robot" }).success
    ).toBe(false);
  });

  it("the handler hands the agent kind to runMarketInstall unchanged", async () => {
    const out = await BUILTIN_VERBS["market.install"]!(
      { slug: "claude-code", kind: "agent" },
      ctx as never
    );
    expect(runMarketInstallMock).toHaveBeenCalledTimes(1);
    expect(runMarketInstallMock.mock.calls[0]![0]).toMatchObject({
      slug: "claude-code",
      kind: "agent",
      userId: "user-1",
    });
    expect(out).toEqual({ kind: "agent", status: "installed" });
  });
});
