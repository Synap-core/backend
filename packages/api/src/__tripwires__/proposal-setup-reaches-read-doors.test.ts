/**
 * Proposal SETUP reaches EVERY read door.
 *
 * Modelled on `proposal-class-reaches-read-doors.test.ts`, for the same failure
 * mode: `class` was pure, correct, and read by exactly ONE production caller,
 * so a decision that was knowable was simultaneously unreachable. `setup` is
 * strictly more severable, because it CANNOT be derived in a pure codec — it
 * needs the template cache, the vault and Nango — so its producer necessarily
 * sits upstream of the projections that carry it. A declared-but-unforwarded
 * `setup` would typecheck, satisfy its zod schema, and render as "no setup
 * needed" on every screen. That is the shape this file exists to make loud.
 *
 * The four doors:
 *   1. `enrichProposalsForDisplay`  → tRPC `proposals.list` / `proposals.get`
 *   2. `hub.proposals.listProposals` → the SOURCE of doors 3 and 4
 *   3. `toProposalBasic`            → Hub REST `view=basic` + MCP `list_proposals`
 *   4. `withProposalClass`          → Hub REST `view=full`
 *
 * Doors 3 and 4 are pure and asserted BEHAVIOURALLY (the field must arrive, and
 * must satisfy the schema that declares it). Doors 1 and 2 batch-join the
 * database and cannot run without one, so they are asserted by SOURCE SCAN —
 * the same mechanism, for the same reason, as the projection-parity tripwires.
 *
 * WHAT THIS DOES NOT COVER, measured: the source scans pin that the stamping
 * CALL EXISTS in each file, not that it is reached on every branch of that
 * handler. Verified by deleting the `withProposalSetup(` call from
 * `hub-protocol/proposals.ts` (red) and by renaming the `setups` variable only
 * (still green) — granularity is the call, not the code path.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ProposalBasicSchema,
  WireProposalSchema,
  toProposalBasic,
  withProposalClass,
} from "../routers/hub-protocol/rest/_codecs/proposal.js";
import {
  withProposalSetup,
  type ProposalSetup,
} from "../services/proposals/proposal-setup.js";

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// ── Data layer for the behavioural MCP case (door 5) ───────────────────────
// Only the three leaf reads are mocked; `resolveProposalSetups`,
// `extractInstallParams`, `deriveConnection`, `withProposalSetup`,
// `toProposalBasic` and the handler itself all run for real.
vi.mock("../services/proposals/proposals-service.js", () => ({
  listCreatedProposals: vi.fn(async () => [MCP_FIXTURE_ROW]),
}));
vi.mock("../services/capabilities/marketplace-install.js", async (orig) => ({
  ...((await orig()) as object),
  lookupCatalogEntry: vi.fn(async () => ({
    definition: {
      params: [
        { name: "apiKey", label: "API Key", type: "password", required: true },
        { name: "region", label: "Region", type: "string", required: false },
      ],
      tools: [],
    },
  })),
}));
vi.mock("../services/capabilities/capability-catalog.js", async (orig) => ({
  ...((await orig()) as object),
  // No Nango, no vault — the shape `loadConnState` returns when a pod has
  // neither. Keeps the test off the network and off the database.
  loadConnState: vi.fn(async () => ({
    providerConn: new Map<string, string>(),
    providerAvailable: null,
    providerConnFault: null,
    vaultExists: new Set<string>(),
    reauthConnIds: new Set<string>(),
  })),
}));

/** A blocking setup, of the shape the real derivation returns. */
const SETUP: ProposalSetup = {
  params: [
    {
      name: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
      secret: true,
      satisfied: false,
    },
  ],
  blocking: true,
};

const RAW_ROW = {
  id: "p1",
  workspaceId: null,
  targetType: "capability",
  targetId: "market:capability:acme",
  proposalType: "capability.install",
  data: { slug: "acme", kind: "capability", params: {} },
  status: "pending",
  correlationId: null,
  sessionId: null,
  agentUserId: null,
};

/** Secret VALUE a human typed into an install param — must never be echoed. */
const MCP_SECRET_VALUE = "sk-live-TYPED-BY-A-HUMAN";

/** The row the mocked `listCreatedProposals` returns for the MCP door. */
const MCP_FIXTURE_ROW = {
  ...RAW_ROW,
  data: {
    slug: "acme",
    kind: "capability",
    params: { apiKey: MCP_SECRET_VALUE, region: "eu" },
  },
};

describe("door 3 — toProposalBasic (REST view=basic, MCP synap_list_proposals)", () => {
  it("FORWARDS the setup its upstream producer stamped", () => {
    const basic = toProposalBasic({ ...RAW_ROW, setup: SETUP });
    // Reachability, not shape: the VALUE must arrive. "the key is declared"
    // passes on the single most repeated defect in this codebase.
    expect(basic.setup).toEqual(SETUP);
    expect(basic.setup?.blocking).toBe(true);
    expect(basic.setup?.params[0]?.name).toBe("apiKey");
    expect(() => ProposalBasicSchema.parse(basic)).not.toThrow();
  });

  it("omits it entirely when the row carries none — absent ≠ nothing needed", () => {
    const basic = toProposalBasic(RAW_ROW);
    expect("setup" in basic).toBe(false);
    expect(() => ProposalBasicSchema.parse(basic)).not.toThrow();
  });

  it("never carries a param VALUE, because the schema has nowhere to put one", () => {
    const basic = ProposalBasicSchema.parse(
      toProposalBasic({ ...RAW_ROW, setup: SETUP })
    );
    expect(Object.keys(basic.setup!.params[0]!)).not.toContain("value");
  });
});

describe("door 4 — withProposalClass (REST view=full)", () => {
  it("keeps the setup on the row it stamps", () => {
    const row = withProposalClass({ ...RAW_ROW, setup: SETUP });
    expect((row as { setup?: ProposalSetup }).setup).toEqual(SETUP);
    expect(() => WireProposalSchema.parse(row)).not.toThrow();
  });

  it("the wire schema ACCEPTS the real setup shape", () => {
    // A schema that rejected the producer's own output would make the field
    // unreachable just as surely as not declaring it.
    const parsed = WireProposalSchema.parse(
      withProposalClass({ ...RAW_ROW, setup: SETUP })
    );
    expect(parsed.setup?.params).toHaveLength(1);
  });
});

describe("the stamping door itself", () => {
  it("stamps setup AND redacts in one act, never one without the other", () => {
    const setups = new Map<string, ProposalSetup>([["p1", SETUP]]);
    const stamped = withProposalSetup(
      { ...RAW_ROW, data: { params: { apiKey: "sk-live-LEAK" } } },
      setups
    );
    expect(stamped.setup).toBeDefined();
    expect(JSON.stringify(stamped)).not.toContain("sk-live-LEAK");
  });
});

describe("door 1 — enrichProposalsForDisplay (proposals.list / proposals.get)", () => {
  const src = readSrc("../routers/proposals/display.ts");

  it("resolves the setups for its page", () => {
    expect(src).toContain("await resolveProposalSetups(");
  });

  it("spreads the setup fields into the row it returns", () => {
    expect(src).toContain(
      "...proposalSetupFields(row.id, enrichedData, setups)"
    );
  });

  it("redacts the `request.data` copy too", () => {
    // `request.data` IS `row.data` under a second key; stripping only the
    // top-level spread would have left the credential on the wire.
    expect(src).toContain("redactSecretParams(enrichedData, rowSetup)");
  });
});

describe("door 2 — hub.proposals.listProposals (REST full+basic, MCP list)", () => {
  const src = readSrc("../routers/hub-protocol/proposals.ts");

  it("stamps the setup onto every row of the page", () => {
    expect(src).toContain("await resolveProposalSetups(");
    expect(src).toContain("withProposalSetup(");
  });
});

/**
 * Door 5 — the MCP `synap_list_proposals` tool, driven BEHAVIOURALLY.
 *
 * This case used to be a source scan asserting the file mentions
 * `toProposalBasic`. It passed throughout the whole defect: the handler calls
 * `listCreatedProposals` DIRECTLY — it is not, and never was, a caller of
 * `hub.proposals.listProposals` despite a comment there saying so — so nothing
 * on this path ever RAN `resolveProposalSetups`. `setup` was declared on the
 * wire, forwarded by the codec, and produced by nobody; `detail:"full"` echoed
 * the raw `data.params`, so a credential a human typed into an install param
 * was readable by the agent that authored the proposal.
 *
 * A scan for a symbol cannot see "produced by nobody". So this drives the real
 * handler with the data layer mocked, and asserts the two things that matter:
 * `setup` ARRIVES, and the secret param VALUE does not.
 */
describe("door 5 — MCP synap_list_proposals (behavioural)", () => {
  const SECRET_VALUE = MCP_SECRET_VALUE;
  const ROW = MCP_FIXTURE_ROW;

  async function callMcp(detail?: "full") {
    const { readHandlers } = await import("../routers/mcp/handlers/read.js");
    const handler = readHandlers.synap_list_proposals!;
    const res = await handler({
      toolName: "synap_list_proposals",
      args: detail ? { detail } : {},
      userId: "user-1",
      apiKeyScopes: ["mcp.read"],
      workspaceAccessible: false,
    } as never);
    const text = (res.content as Array<{ text: string }>)[0].text;
    const json = JSON.parse(text) as unknown;
    // `detail:"full"` answers with a bare array when the service returned one;
    // BASIC always wraps. Both shapes are read the same way here.
    const rows = (
      Array.isArray(json)
        ? json
        : ((json as { proposals?: unknown[] }).proposals ?? [])
    ) as Array<Record<string, unknown>>;
    return { raw: text, rows };
  }

  it("non-vacuity: the fixture really carries a raw secret param value", () => {
    expect(JSON.stringify(ROW)).toContain(SECRET_VALUE);
  });

  it("BASIC: stamps `setup` and never echoes the secret value", async () => {
    const { raw, rows } = await callMcp();
    expect(rows).toHaveLength(1); // the mocked data layer really ran
    const setup = rows[0].setup as ProposalSetup | undefined;
    expect(setup, "setup was produced by NOBODY on the MCP door").toBeDefined();
    expect(setup!.params.map((p) => p.name)).toContain("apiKey");
    expect(setup!.params.find((p) => p.name === "apiKey")!.secret).toBe(true);
    expect(raw).not.toContain(SECRET_VALUE);
  });

  it("FULL: stamps `setup` and redacts `data.params` — the branch that echoed it", async () => {
    const { raw, rows } = await callMcp("full");
    expect(rows).toHaveLength(1);
    expect(rows[0].setup).toBeDefined();
    // The whole `data` payload is still there — only the VALUE is gone.
    const data = rows[0].data as { params: Record<string, unknown> };
    expect(data.params.region).toBe("eu");
    expect(data.params.apiKey).not.toBe(SECRET_VALUE);
    expect(raw).not.toContain(SECRET_VALUE);
  });
});

/**
 * NON-VACUITY. Every scan above passes trivially if the file it reads is empty,
 * moved, or renamed. These assertions fail in that world.
 */
describe("the scans have teeth", () => {
  const FILES = [
    "../routers/proposals/display.ts",
    "../routers/hub-protocol/proposals.ts",
    "../routers/mcp/handlers/read.ts",
  ] as const;

  for (const rel of FILES) {
    it(`${rel} is present and plausibly large`, () => {
      const src = readSrc(rel);
      expect(src.length).toBeGreaterThan(2000);
      // A literal sample of what these scans hunt — if the door moved wholesale,
      // this fails rather than passing on an empty read.
      expect(src).toContain("proposal");
    });
  }
});
