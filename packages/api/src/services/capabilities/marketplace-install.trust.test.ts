/**
 * The install door enforces a source's trust level. Real
 * sha256 + content versions, the real trust rule and the real verifier; only
 * the database rows, the settings snapshot, the network and the appliers are
 * stand-ins. Every refusal also proves nothing was fetched or installed.
 *
 *   official  — a person installs; an agent proposes (unchanged);
 *   trusted   — a person installs after confirming code / network reach /
 *               existing connections; an agent is REFUSED unless the source
 *               opted in, then proposes with those named for the reviewer;
 *   showcase  — never installs, for anyone, and is never fetched;
 *   blocked   — a key change, a lapsed index or a switched-off source refuses;
 *   integrity — a definition that does not match its signed digest or its
 *               content version is refused; a supplied definition never
 *               installs as another source's package;
 *   identity  — what an added source installs is stamped `<source>/<slug>`
 *               and may not take over anything the pod already has: a
 *               capability key, a tool (by credential or name), an MCP server,
 *               a skill, a secret, a pod-wide kind's lifecycle / options, or a
 *               template automation / playbook matched by name in a space;
 *   approval  — an approved proposal installs only the listing it disclosed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type * as Database from "@synap/database";
import type * as SourceFetch from "@synap/jobs/workers/marketplace-source-fetch.js";
import {
  automations,
  cpCatalogCache,
  capabilities as capabilitiesTable,
  mcpServers,
  playbooks,
  profiles,
  propertyDefs,
  secrets,
  skills,
  tools,
} from "@synap/database/schema";
import { appliedPackageVersion } from "../applied-package-version.js";

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  /** What the pod already holds, per table (an existing-row lookup's answer). */
  existing: new Map<unknown, Array<Record<string, unknown>>>(),
  snapshot: { sources: [], official: null, status: {} } as Record<
    string,
    unknown
  >,
  installCell: vi.fn(async (_input: Record<string, unknown>) => ({
    typeKey: "cell:x:y",
    changeType: "created" as const,
  })),
  propose: vi.fn(async (_input: Record<string, unknown>) => ({ id: "p-1" })),
  tier: vi.fn(async () => undefined),
  fetch: vi.fn(),
}));

vi.mock("../cells/install-cell-from-definition.js", () => ({
  installCellFromDefinition: h.installCell,
}));
vi.mock("../workspace-creation-service.js", () => ({
  createWorkspaceFromDefinitionIdempotent: vi.fn(),
}));
vi.mock("./create-from-definition.js", () => ({
  createCapabilityFromDefinition: vi.fn(async () => ({
    capabilityKey: "x",
    created: true,
  })),
  loadCapabilityTemplate: vi.fn(),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(),
}));
vi.mock("../../utils/permission-check.js", () => ({
  createPendingProposal: h.propose,
}));
vi.mock("../../utils/tier-check.js", () => ({
  assertPackageTierAccess: h.tier,
}));
// Every source fetch goes through the test's network stand-in (the module's
// own default is the public-address-only fetch).
vi.mock(
  "@synap/jobs/workers/marketplace-source-fetch.js",
  async (importOriginal) => {
    const actual = await importOriginal<typeof SourceFetch>();
    return {
      ...actual,
      fetchDefinitionBytes: (url: string, max: number) =>
        actual.fetchDefinitionBytes(url, max, h.fetch),
    };
  }
);
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof Database>();
  return {
    ...actual,
    db: {
      // A whole-row read of the cache is the catalog lookup; a projected one
      // is the "does Synap's catalog use this key" check.
      select: (fields?: unknown) => {
        let table: unknown;
        const rows = () =>
          table === cpCatalogCache && !fields
            ? h.row
              ? [h.row]
              : []
            : (h.existing.get(table) ?? []);
        const chain = {
          from: (t: unknown) => {
            table = t;
            return chain;
          },
          innerJoin: () => chain,
          where: () => chain,
          limit: async () => rows(),
        };
        return chain;
      },
    },
    readMarketplaceSources: async () => h.snapshot,
    getWorkspaceMembership: vi.fn(async () => ({ role: "owner" })),
  };
});

import { applyMarketInstall, runMarketInstall } from "./marketplace-install.js";

const CELL = {
  key: "bar",
  code: "export default () => null",
  externalHosts: ["api.acme.test"],
};
const BYTES = Buffer.from(JSON.stringify(CELL));
const SHA = createHash("sha256").update(BYTES).digest("hex");
const DEF_URL = "https://market.acme.test/defs/bar.json";

function source(over: Record<string, unknown> = {}) {
  return {
    id: "acme",
    url: "https://market.acme.test/synap-index.json",
    name: "Acme",
    trust: "trusted",
    publicKey: "k",
    keyFingerprint: "f",
    agentsMayPropose: false,
    addedBy: "u",
    addedAt: "2026-10-01T00:00:00Z",
    enabled: true,
    ...over,
  };
}
const OK_STATUS = {
  state: "ok",
  lastSyncAt: "2026-10-13T00:00:00Z",
  lastOkAt: "2026-10-13T00:00:00Z",
  packageCount: 1,
  validUntil: "2099-01-01T00:00:00Z",
  message: null,
};

function useSource(
  over: Record<string, unknown> = {},
  status: Record<string, unknown> = OK_STATUS
) {
  h.snapshot = {
    sources: [source(over)],
    official: null,
    status: { acme: status },
  };
}

function cellRow(over: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    source: "acme",
    kind: "cell",
    slug: "charts/bar",
    name: "Bar chart",
    description: null,
    version: appliedPackageVersion(CELL),
    tier: null,
    vendor: null,
    definition: null,
    listing: { definitionUrl: DEF_URL, sha256: SHA },
    retiredAt: null,
    replacedBySlug: null,
    ...over,
  };
}

function serve(body: Buffer) {
  h.fetch.mockImplementation(async () => new Response(new Uint8Array(body)));
}

const PERSON = { userId: "user-1", workspaceId: null };
const AGENT = { ...PERSON, agentUserId: "agent-1" };
const ACK = { code: true, network: true, connectors: true };

beforeEach(() => {
  h.installCell.mockClear();
  h.propose.mockClear();
  h.tier.mockClear();
  h.fetch.mockReset();
  h.existing = new Map();
  vi.stubGlobal("fetch", h.fetch);
  h.row = cellRow();
  useSource();
  serve(BYTES);
});

const install = (over: Record<string, unknown> = {}) =>
  runMarketInstall({
    kind: "cell",
    slug: "charts/bar",
    source: "acme",
    ...PERSON,
    ...over,
  });

async function refusal(p: Promise<unknown>) {
  const err = (await p.catch((e) => e)) as {
    code?: string;
    cause?: { code?: string };
  };
  return { code: err.code, cause: err.cause?.code };
}

describe("trusted source", () => {
  it("a person installs after confirming code and network reach, stamped acme/…", async () => {
    const out = await install({ acknowledge: ACK });
    expect(out.status).toBe("installed");
    expect(h.installCell).toHaveBeenCalledWith(
      expect.objectContaining({ packageSlug: "acme/charts", cellKey: "bar" })
    );
    // Fetched once, anonymously, from the signed address only.
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(url).toBe(DEF_URL);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(init.headers).toEqual({ accept: "application/json" });
    // Synap's tier check is Synap's: not applied to another source's package.
    expect(h.tier).not.toHaveBeenCalled();
  });

  it("without the confirms, nothing installs", async () => {
    expect(await refusal(install())).toEqual({
      code: "PRECONDITION_FAILED",
      cause: "MARKET_ACK_REQUIRED",
    });
    expect(
      await refusal(install({ acknowledge: { code: true } }))
    ).toMatchObject({
      cause: "MARKET_ACK_REQUIRED",
    });
    expect(h.installCell).not.toHaveBeenCalled();
  });

  it("an AGENT is refused when the source did not opt in — nothing fetched or proposed", async () => {
    expect(await refusal(install(AGENT))).toEqual({
      code: "FORBIDDEN",
      cause: "MARKET_SOURCE_REFUSED",
    });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("an agent PROPOSES where the source opted in — with the source and risks on the proposal", async () => {
    useSource({ agentsMayPropose: true });
    const out = await install({ ...AGENT, acknowledge: ACK });
    expect(out.status).toBe("proposed");
    expect(h.installCell).not.toHaveBeenCalled();
    const filed = h.propose.mock.calls[0]![0] as {
      data: Record<string, unknown>;
      targetId: string;
      notificationDescription: string;
    };
    expect(filed.data).toMatchObject({ source: "acme", slug: "charts/bar" });
    expect(filed.data.risks).toEqual([
      "Runs code: bar.",
      "Can reach: api.acme.test.",
    ]);
    expect(filed.targetId).toBe("market:cell:acme/charts/bar");
    expect(filed.notificationDescription).toContain("Acme (acme)");
  });
});

describe("showcase source", () => {
  it("never installs and is never fetched — for a person or an agent", async () => {
    useSource({ trust: "showcase", publicKey: null, agentsMayPropose: true });
    h.row = cellRow({
      listing: {
        definitionUrl: DEF_URL,
        sha256: SHA,
        installUrl: "https://acme.test/install",
      },
    });
    for (const who of [PERSON, AGENT]) {
      expect(await refusal(install({ ...who, acknowledge: ACK }))).toEqual({
        code: "PRECONDITION_FAILED",
        cause: "MARKET_SHOWCASE_ONLY",
      });
    }
    // The approval path refuses too.
    expect(
      await refusal(
        applyMarketInstall({
          kind: "cell",
          slug: "charts/bar",
          source: "acme",
          ...PERSON,
        })
      )
    ).toMatchObject({ cause: "MARKET_SHOWCASE_ONLY" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.installCell).not.toHaveBeenCalled();
  });
});

describe("a blocked source refuses — before any fetch", () => {
  const cases: Array<
    [string, Record<string, unknown>, Record<string, unknown>]
  > = [
    [
      "a key change awaiting re-approval",
      {},
      { ...OK_STATUS, state: "key_changed" },
    ],
    [
      "a lapsed index",
      {},
      { ...OK_STATUS, validUntil: "2020-01-01T00:00:00Z" },
    ],
    ["a switched-off source", { enabled: false }, OK_STATUS],
    ["a source never verified", {}, { ...OK_STATUS, validUntil: null }],
  ];
  for (const [label, over, status] of cases) {
    it(label, async () => {
      useSource(over, status);
      expect(await refusal(install({ acknowledge: ACK }))).toEqual({
        code: "FORBIDDEN",
        cause: "MARKET_SOURCE_REFUSED",
      });
      // An approved proposal re-checks, so a block since filing still holds.
      expect(
        await refusal(
          applyMarketInstall({
            kind: "cell",
            slug: "charts/bar",
            source: "acme",
            ...PERSON,
          })
        )
      ).toMatchObject({ code: "FORBIDDEN" });
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.installCell).not.toHaveBeenCalled();
    });
  }
});

describe("integrity", () => {
  it("a definition that does not match its signed digest is refused", async () => {
    serve(Buffer.from(JSON.stringify({ ...CELL, code: "steal()" })));
    expect(await refusal(install({ acknowledge: ACK }))).toEqual({
      code: "PRECONDITION_FAILED",
      cause: "MARKET_DEFINITION_REJECTED",
    });
    expect(h.installCell).not.toHaveBeenCalled();
  });

  it("a definition that does not match its listed content version is refused", async () => {
    h.row = cellRow({ version: "h-000000000000" });
    expect(await refusal(install({ acknowledge: ACK }))).toEqual({
      code: "PRECONDITION_FAILED",
      cause: "MARKET_DEFINITION_REJECTED",
    });
    expect(h.installCell).not.toHaveBeenCalled();
  });

  it("a supplied definition never installs as another source's package", async () => {
    expect(
      (
        await refusal(
          install({ acknowledge: ACK, definition: { key: "bar", code: "x" } })
        )
      ).code
    ).toBe("BAD_REQUEST");
    expect(h.installCell).not.toHaveBeenCalled();
  });

  it("an unknown source is refused, never guessed", async () => {
    expect((await refusal(install({ source: "nobody" }))).code).toBe(
      "NOT_FOUND"
    );
  });
});

/** List `definition` from Acme under (kind, slug), digest and version intact. */
function listFromAcme(kind: string, slug: string, definition: unknown) {
  const bytes = Buffer.from(JSON.stringify(definition));
  serve(bytes);
  h.row = cellRow({
    kind,
    slug,
    name: slug,
    version: appliedPackageVersion(definition as Record<string, unknown>),
    listing: {
      definitionUrl: DEF_URL,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
}

describe("takeover — an added source only ADDS", () => {
  const CAP = {
    key: "acme-mail",
    name: "Acme mail",
    vault: [{ ref: "token", name: "Acme token", value: "{{token}}" }],
    mcpServers: [
      { slug: "acme-mcp", transport: "http", url: "https://mcp.acme.test" },
    ],
    tools: [
      { name: "acme-api", credentialRef: "token" },
      { name: "gmail-bridge", credentialRef: "nango://google-mail" },
      { name: "{{name}} helper" },
    ],
    skills: [{ name: "acme.send", scope: "pod" }],
  };
  const installCap = (over: Record<string, unknown> = {}) =>
    runMarketInstall({
      kind: "capability",
      slug: "acme-mail",
      source: "acme",
      ...PERSON,
      acknowledge: ACK,
      params: { token: "t" },
      ...over,
    });

  beforeEach(() => listFromAcme("capability", "acme-mail", CAP));

  it("installs when nothing clashes", async () => {
    expect((await installCap()).status).toBe("installed");
  });

  it("a nango:// tool would use the pod's existing connection: refused until the person accepts that", async () => {
    const err = (await installCap({
      acknowledge: { code: true, network: true },
    }).catch((e) => e)) as {
      code: string;
      message: string;
      cause: { code: string };
    };
    expect(err.code).toBe("PRECONDITION_FAILED");
    expect(err.cause.code).toBe("MARKET_ACK_REQUIRED");
    expect(err.message).toBe(
      "It can use your existing Gmail connection — confirm that you accept that."
    );
  });

  it("an agent's proposal names the existing connection for the reviewer", async () => {
    useSource({ agentsMayPropose: true });
    expect((await installCap({ agentUserId: "agent-1" })).status).toBe(
      "proposed"
    );
    const filed = h.propose.mock.calls[0]![0] as {
      data: { risks: string[] };
      notificationDescription: string;
    };
    expect(filed.data.risks).toContain("Uses your existing Gmail connection.");
    expect(filed.notificationDescription).toContain(
      "Uses your existing Gmail connection."
    );
  });

  const clashes: Array<[string, unknown, Record<string, unknown>]> = [
    ["a capability key", capabilitiesTable, { key: "acme-mail" }],
    ["an MCP server slug", mcpServers, { slug: "acme-mcp" }],
    ["a tool's credential", tools, { name: "Gmail" }],
    ["a tool's name", tools, { name: "Acme mail helper" }],
    ["a skill's name", skills, { name: "acme.send" }],
    ["a secret's name", secrets, { name: "Acme token" }],
  ];
  for (const [label, table, row] of clashes) {
    it(`refuses a clash on ${label}, naming it — nothing applied`, async () => {
      h.existing.set(table, [row]);
      const err = (await installCap().catch((e) => e)) as {
        code: string;
        message: string;
        cause: { code: string };
      };
      expect(err.code).toBe("CONFLICT");
      expect(err.cause.code).toBe("MARKET_CAPABILITY_TAKEOVER");
      expect(err.message).toContain(String(Object.values(row)[0]));
      expect(err.message).toContain("Acme can't replace it");
    });
  }

  it("refuses a key Synap's catalog uses", async () => {
    h.existing.set(cpCatalogCache, [{ key: "acme-mail" }]);
    expect(await refusal(installCap())).toEqual({
      code: "CONFLICT",
      cause: "MARKET_CAPABILITY_TAKEOVER",
    });
  });

  it("refuses a published literal link to an existing secret", async () => {
    listFromAcme("capability", "acme-mail", {
      ...CAP,
      vault: [
        {
          ref: "token",
          name: "Acme token",
          value: "vault://00000000-0000-4000-8000-000000000001",
        },
      ],
    });
    expect(await refusal(installCap())).toEqual({
      code: "CONFLICT",
      cause: "MARKET_CAPABILITY_TAKEOVER",
    });
  });

  it("the same rule holds on an approved proposal (the approval path)", async () => {
    h.existing.set(skills, [{ name: "acme.send" }]);
    expect(
      await refusal(
        applyMarketInstall({
          kind: "capability",
          slug: "acme-mail",
          source: "acme",
          ...PERSON,
          proposedListingSha256: (h.row!.listing as { sha256: string }).sha256,
        })
      )
    ).toEqual({ code: "CONFLICT", cause: "MARKET_CAPABILITY_TAKEOVER" });
  });

  it("a template's inline capabilities are checked too", async () => {
    listFromAcme("template", "crm", {
      workspaceName: "CRM",
      capabilities: [{ definition: CAP, params: { token: "t" } }],
    });
    h.existing.set(mcpServers, [{ slug: "acme-mcp" }]);
    expect(
      await refusal(
        runMarketInstall({
          kind: "template",
          slug: "crm",
          source: "acme",
          ...PERSON,
          acknowledge: ACK,
        })
      )
    ).toEqual({ code: "CONFLICT", cause: "MARKET_CAPABILITY_TAKEOVER" });
  });

  describe("a template's automations and playbooks, matched by name in a space", () => {
    const installCrm = () =>
      runMarketInstall({
        kind: "template",
        slug: "crm",
        source: "acme",
        ...PERSON,
        acknowledge: ACK,
      });
    const TEMPLATE = {
      workspaceName: "CRM",
      automations: [
        {
          name: "Daily digest",
          key: "crm.digest",
          triggerType: "cron",
          triggerConfig: {},
        },
      ],
      playbooks: [{ name: "Weekly review" }],
      loops: [
        {
          definition: {
            key: "follow-up",
            name: "Follow up",
            params: [{ name: "who", default: "Leads" }],
            playbooks: [{ ref: "a", name: "Chase {{who}}", goalTemplate: "x" }],
          },
        },
      ],
    };

    beforeEach(() => listFromAcme("template", "crm", TEMPLATE));

    const named: Array<[string, unknown, string]> = [
      ["an automation", automations, "Daily digest"],
      ["a playbook", playbooks, "Weekly review"],
      ["a playbook an inline loop creates", playbooks, "Chase Leads"],
    ];
    for (const [label, table, name] of named) {
      it(`refuses ${label} whose name is already in one of the person's spaces, naming it`, async () => {
        h.existing.set(table, [{ name }]);
        const err = (await installCrm().catch((e) => e)) as {
          code: string;
          message: string;
          cause: { code: string };
        };
        expect(err.code).toBe("CONFLICT");
        expect(err.cause.code).toBe("MARKET_CAPABILITY_TAKEOVER");
        expect(err.message).toContain(`"${name}"`);
        expect(err.message).toContain("is already in one of your spaces");
      });
    }

    it("the approval path refuses the same clash", async () => {
      h.existing.set(automations, [{ name: "Daily digest" }]);
      expect(
        await refusal(
          applyMarketInstall({
            kind: "template",
            slug: "crm",
            source: "acme",
            ...PERSON,
            proposedListingSha256: (h.row!.listing as { sha256: string })
              .sha256,
          })
        )
      ).toEqual({ code: "CONFLICT", cause: "MARKET_CAPABILITY_TAKEOVER" });
    });
  });

  it("a template may not give a pod-wide kind a lifecycle or new options for its fields", async () => {
    const installCrm = () =>
      runMarketInstall({
        kind: "template",
        slug: "crm",
        source: "acme",
        ...PERSON,
        acknowledge: ACK,
      });
    h.existing.set(profiles, [{ id: "p-deal", slug: "deal" }]);

    listFromAcme("template", "crm", {
      profiles: [{ slug: "deal", lifecycle: { property: "stage" } }],
    });
    expect(await refusal(installCrm())).toEqual({
      code: "CONFLICT",
      cause: "MARKET_CAPABILITY_TAKEOVER",
    });

    listFromAcme("template", "crm", {
      profiles: [
        {
          slug: "deal",
          properties: [
            {
              slug: "stage",
              valueType: "string",
              enumValues: ["won", "pwned"],
            },
          ],
        },
      ],
    });
    h.existing.set(propertyDefs, [{ slug: "stage" }]);
    expect(await refusal(installCrm())).toEqual({
      code: "CONFLICT",
      cause: "MARKET_CAPABILITY_TAKEOVER",
    });
  });
});

describe("approval — the listing the reviewer was shown", () => {
  const approve = (proposedListingSha256: string | null) =>
    applyMarketInstall({
      kind: "cell",
      slug: "charts/bar",
      source: "acme",
      ...PERSON,
      proposedListingSha256,
    });

  it("the proposal records the listing digest it disclosed", async () => {
    useSource({ agentsMayPropose: true });
    await install({ ...AGENT });
    expect(
      (h.propose.mock.calls[0]![0] as { data: Record<string, unknown> }).data
        .listingSha256
    ).toBe(SHA);
  });

  it("installs when the source still lists exactly that package", async () => {
    await approve(SHA);
    expect(h.installCell).toHaveBeenCalled();
  });

  it("refuses — 'propose it again' — when the package changed since, or the proposal carried no digest", async () => {
    for (const digest of ["0".repeat(64), null]) {
      const err = (await approve(digest).catch((e) => e)) as {
        code: string;
        message: string;
        cause: { code: string };
      };
      expect(err.code).toBe("PRECONDITION_FAILED");
      expect(err.cause.code).toBe("MARKET_LISTING_CHANGED");
      expect(err.message).toContain("propose it again");
    }
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.installCell).not.toHaveBeenCalled();
  });

  it("an official proposal with no digest on either side is unchanged", async () => {
    h.snapshot = { sources: [], official: null, status: {} };
    h.row = cellRow({
      source: process.env.CONTROL_PLANE_URL ?? "https://api.synap.live",
      listing: null,
      definition: CELL,
    });
    await applyMarketInstall({
      kind: "cell",
      slug: "charts/bar",
      ...PERSON,
      proposedListingSha256: null,
    });
    expect(h.installCell).toHaveBeenCalled();
  });
});

describe("identity", () => {
  it("a capability from an added source may not take over an existing key", async () => {
    const cap = { key: "gmail", tools: [] };
    const bytes = Buffer.from(JSON.stringify(cap));
    serve(bytes);
    h.row = cellRow({
      kind: "capability",
      slug: "gmail",
      version: appliedPackageVersion(cap),
      listing: {
        definitionUrl: DEF_URL,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    h.existing.set(capabilitiesTable, [{ key: "gmail" }]);
    expect(
      await refusal(
        runMarketInstall({
          kind: "capability",
          slug: "gmail",
          source: "acme",
          ...PERSON,
        })
      )
    ).toEqual({ code: "CONFLICT", cause: "MARKET_CAPABILITY_TAKEOVER" });
  });

  it("the official source is unchanged: an agent proposes, a person installs, tier is checked", async () => {
    h.snapshot = { sources: [], official: null, status: {} };
    h.row = cellRow({
      source: process.env.CONTROL_PLANE_URL ?? "https://api.synap.live",
      listing: null,
      definition: CELL,
    });
    const proposed = await runMarketInstall({
      kind: "cell",
      slug: "charts/bar",
      ...AGENT,
    });
    expect(proposed.status).toBe("proposed");
    expect(
      (h.propose.mock.calls[0]![0] as { data: { source: string } }).data.source
    ).toBe("synap");
    const installed = await runMarketInstall({
      kind: "cell",
      slug: "charts/bar",
      ...PERSON,
    });
    expect(installed.status).toBe("installed");
    expect(h.installCell).toHaveBeenCalledWith(
      expect.objectContaining({ packageSlug: "charts", cellKey: "bar" })
    );
    expect(h.tier).toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("an official install is refused once a pod admin turns Synap off", async () => {
    h.snapshot = { sources: [], official: { enabled: false }, status: {} };
    h.row = cellRow({ listing: null, definition: CELL });
    expect(
      await refusal(
        runMarketInstall({ kind: "cell", slug: "charts/bar", ...PERSON })
      )
    ).toEqual({ code: "FORBIDDEN", cause: "MARKET_SOURCE_REFUSED" });
  });
});
