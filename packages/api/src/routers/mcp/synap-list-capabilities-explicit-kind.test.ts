/**
 * `synap_list_capabilities` — an EXPLICIT `kind` overrides the default fold.
 *
 * The adapter folds `builtin-tool` and `teaching-doc` out of the actionable
 * view on purpose: they bury the ~20 things an agent can actually do. That
 * default is correct and stays.
 *
 * What was NOT correct: the fold ran unconditionally, so a caller that
 * deliberately asked for one of those kinds got zero rows plus a COUNT — and
 * an `excluded.note` advertising a `kind:"builtin-tool"` hatch that returned
 * nothing either (the built-in filter ignored what was asked). Verified live
 * on 2026-09-03 against pod.antoinesrvt.synap.live:
 *   kind:"teaching-doc"  → {skills: [], excluded: {teachingDocs: 122}}
 *   kind:"builtin-tool"  → {skills: [], excluded: {builtinTools: 91}}
 * A door that counts rows, refuses to list them, and points at a hatch that
 * does not cover them is a non-answer three times over.
 *
 * Same stubbing pattern as `synap-list-capabilities-truncation.test.ts` — the
 * DB is neutralized, `listCapabilities` is a fixture, and the real
 * `sectionCapabilities` does the folding under test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RegistryCapability } from "../../services/capabilities/capability-registry.js";

const { listCapabilities } = vi.hoisted(() => ({
  listCapabilities: vi.fn(),
}));

vi.mock(
  "../../services/capabilities/capability-registry.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../services/capabilities/capability-registry.js")
    >()),
    listCapabilities,
  })
);

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: vi.fn(async () => ({}) as never),
}));

vi.mock("../hub-protocol/rest/_shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hub-protocol/rest/_shared.js")>()),
  verifyWorkspaceAccess: vi.fn(async () => true),
}));

import { executeMCPToolViaHubProtocol } from "./adapter.js";

function parse(
  result: Awaited<ReturnType<typeof executeMCPToolViaHubProtocol>>
) {
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text) as Record<string, unknown>;
}

function cap(
  partial: Partial<RegistryCapability> & {
    kind: RegistryCapability["kind"];
    name: string;
    id: string;
  }
): RegistryCapability {
  return {
    description: null,
    inputSchema: {},
    executor: "is-agent",
    governance: "propose",
    ...partial,
  } as RegistryCapability;
}

const CATALOG: RegistryCapability[] = [
  cap({ kind: "tool", name: "exa_api", id: "exa-1" }),
  cap({
    kind: "teaching-doc",
    name: "Capabilities",
    id: "doc-1",
    slug: "system/synap/capabilities",
  }),
  cap({
    kind: "teaching-doc",
    name: "Escalation ladder",
    id: "doc-2",
    slug: "system/synap/escalation-ladder",
  }),
  // A legacy row with no slug: it must still be LISTED, with a null ref rather
  // than its name silently standing in for one (a name is not a load_skill ref).
  cap({ kind: "teaching-doc", name: "legacy doc", id: "doc-3" }),
  cap({ kind: "builtin-tool", name: "b_one", id: "b1", catalogOnly: true }),
  cap({ kind: "builtin-tool", name: "b_two", id: "b2", catalogOnly: true }),
];

/** Mimics `listCapabilities`' own exact-kind filter. */
function fixtureFor(kind?: string): RegistryCapability[] {
  return kind ? CATALOG.filter((c) => c.kind === kind) : CATALOG;
}

async function call(args: Record<string, unknown>) {
  return parse(
    await executeMCPToolViaHubProtocol(
      "synap_list_capabilities",
      { workspaceId: "ws-1", ...args },
      "user-1",
      ["mcp.read"]
    )
  );
}

describe("synap_list_capabilities — explicit kind overrides the default fold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCapabilities.mockImplementation(
      async (_ctx: unknown, opts?: { kind?: string }) => fixtureFor(opts?.kind)
    );
  });

  it('kind:"teaching-doc" returns ROWS carrying the load_skill ref, not just a count', async () => {
    const payload = await call({ kind: "teaching-doc" });
    const docs = payload.teachingDocs as Array<{
      ref: string | null;
      name: string;
    }>;
    expect(docs).toBeDefined();
    expect(docs.map((d) => d.ref)).toEqual([
      "system/synap/capabilities",
      "system/synap/escalation-ladder",
      null,
    ]);
    // Nothing was withheld, so nothing may be reported as excluded — the count
    // standing next to the rows it counts was the original defect.
    expect((payload.excluded as { teachingDocs: number }).teachingDocs).toBe(0);
  });

  it('kind:"builtin-tool" actually returns the built-ins the note advertises', async () => {
    const payload = await call({ kind: "builtin-tool" });
    expect(
      (payload.builtins as Array<{ name: string }>).map((b) => b.name)
    ).toEqual(["b_one", "b_two"]);
    expect((payload.excluded as { builtinTools: number }).builtinTools).toBe(0);
  });

  it("the DEFAULT view still folds both kinds out and still counts them", async () => {
    const payload = await call({});
    expect(payload.teachingDocs).toBeUndefined();
    expect(payload.builtins).toBeUndefined();
    expect(
      (payload.integrations as Array<{ name: string }>).map((i) => i.name)
    ).toEqual(["exa_api"]);
    const excluded = payload.excluded as {
      teachingDocs: number;
      builtinTools: number;
      note: string;
    };
    expect(excluded.teachingDocs).toBe(3);
    expect(excluded.builtinTools).toBe(2);
    // The note must name doors that WORK. Both kind filters now do, and
    // load_skill("catalog") is the door that lists teaching docs by topic.
    expect(excluded.note).toContain('kind:"teaching-doc"');
    expect(excluded.note).toContain('kind:"builtin-tool"');
    expect(excluded.note).toContain('synap_load_skill("catalog")');
  });

  it("an explicit limit still caps, and the remainder is honestly excluded", async () => {
    const payload = await call({ kind: "teaching-doc", limit: 2 });
    expect((payload.teachingDocs as unknown[]).length).toBe(2);
    expect((payload.excluded as { teachingDocs: number }).teachingDocs).toBe(1);
  });
});
