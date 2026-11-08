/**
 * An AI finds a marketplace capability, asks for it on a computer it names,
 * and the person's ONE approval adds it to the pod and queues the install
 * (founder, 2026-11-08). On PGlite through the REAL doors: the `market.search`
 * verb, MCP `synap_request_installation` and `synap_list_installations`, the
 * shared rule (`requestInstallation`), the `installation/request` executor,
 * the container door, the installable read and the reconciler. The catalog
 * row is Synap's `media-ffmpeg` 0.35.0 definition as the Control Plane serves
 * it (fixture), cached as the catalog sync caches it.
 *
 * Stubbed, each pinned elsewhere:
 *   - the gate's outcome (an agent's ask is proposed, a person's granted, as
 *     the ladder answers);
 *   - the catalog signature check (network; official-catalog-trust tests);
 *   - the marketplace applier's capability branch, replaced by the container
 *     door it hands the definition's computer blocks to
 *     (create-from-definition.computer-blocks.test.ts pins that hand-off).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  gate: [] as Array<Record<string, unknown>>,
  added: [] as string[],
  pending: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      h.gate.push(opts);
      return opts.agentUserId
        ? {
            granted: false,
            proposalId: randomUUID(),
            proposalType: "installation.request",
            reviewUrl: "https://pod.example/review",
          }
        : { granted: true };
    },
    // The marketplace door's proposal (an agent's `market.install`): its
    // writer holds its own connection, which PGlite does not serve.
    createPendingProposal: async (opts: Record<string, unknown>) => {
      h.pending.push(opts);
      return { id: randomUUID() };
    },
  };
});

vi.mock("../capabilities/official-catalog-trust.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertOfficialDefinition: async () => {} };
});

vi.mock("../capabilities/marketplace-install.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../capabilities/marketplace-install.js")
    >();
  return {
    ...actual,
    // What the applier hands the container door for a capability that runs
    // on a computer: its name and its computer blocks, at its catalog key.
    applyMarketInstall: async (input: { slug: string; userId: string }) => {
      h.added.push(input.slug);
      const entry = await actual.lookupCatalogEntry(
        "capability",
        input.slug,
        null
      );
      const def = entry!.definition!;
      const { capabilityContainersRouter } =
        await import("../../routers/capability-containers.js");
      await capabilityContainersRouter
        .createCaller({
          authenticated: true,
          userId: input.userId,
        } as never)
        .create({
          name: def.name as string,
          description: def.description as string,
          templateKey: input.slug,
          metadata: {
            computer: pickComputerSpec(def),
            templateKey: input.slug,
            contentHash: def.contentHash,
          },
        });
      return { kind: "capability", key: input.slug };
    },
  };
});

import { pickComputerSpec } from "@synap-core/types/capability-manifest";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";
import { runWithGrant } from "@synap/database";
import { officialCatalogUrl } from "@synap/jobs/workers/cp-catalog-sync.js";
import { mcpToolAllowed } from "../../access/grant-door-fence.js";
import { installationHandlers } from "../../routers/mcp/handlers/installations.js";
import { proposalExecRegistry } from "../../routers/proposals/execution-registry.js";
import type { ProposalExecutorArgs } from "../../routers/proposals/execution-registry.js";
import { registerInstallationExecutors } from "../../routers/proposals/executors/installations.js";
import { BUILTIN_VERBS } from "../capabilities/builtin-verbs.js";
import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEF = JSON.parse(
  readFileSync(
    resolve(here, "__fixtures__/media-ffmpeg.0.35.0.definition.json"),
    "utf8"
  )
) as Record<string, unknown>;
/** A capability that runs on the pod: no placement, nothing to install. */
const POD_DEF = {
  key: "web-reader",
  name: "Web reader",
  description: "Reads a web page into a note.",
};

const PERSON = randomUUID();
const MAC = randomUUID();
const SURFACE = randomUUID();
const NAS = randomUUID();
const AGENT = randomUUID();

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  const meta = (platform: string, arch: string, hostsServices: boolean) =>
    JSON.stringify({ platform, arch, hostsServices });
  await q(
    `INSERT INTO users (id, email, name, agent_type, created_by_user_id, host_user_id, agent_metadata) VALUES
      ($1, 'a@x', 'person', NULL, NULL, NULL, '{}'::jsonb),
      ($2, 'm@x', 'Mac', 'machine', $1, NULL, $6::jsonb),
      ($3, 's@x', 'Surface', 'machine', $1, NULL, $7::jsonb),
      ($4, 'n@x', 'NAS', 'machine', $1, NULL, $8::jsonb),
      ($5, 'c@x', 'Claude Code', 'claude-code', $1, $2, '{}'::jsonb)`,
    [
      PERSON,
      MAC,
      SURFACE,
      NAS,
      AGENT,
      meta("darwin", "arm64", true),
      meta("win32", "arm64", true),
      meta("linux", "x64", false),
    ]
  );
  for (const [slug, def, version] of [
    ["media-ffmpeg", DEF, "0.35.0"],
    ["web-reader", POD_DEF, "1.0.0"],
  ] as const)
    await q(
      `INSERT INTO cp_catalog_cache (source, kind, slug, name, description, version, definition)
       VALUES ($1, 'capability', $2, $3, $4, $5, $6::jsonb)`,
      [
        officialCatalogUrl(),
        slug,
        def.name,
        def.description,
        version,
        JSON.stringify(def),
      ]
    );
  registerInstallationExecutors();
}, 60_000);

/** Call an MCP tool as the agent (Claude Code on the Mac) and read its JSON. */
async function asAgent(tool: string, args: Record<string, unknown>) {
  const res = await installationHandlers[tool]!({
    toolName: tool,
    args,
    userId: PERSON,
    agentUserId: AGENT,
    apiKeyScopes: ["mcp.read", "mcp.write"],
  } as never);
  return JSON.parse((res.content[0] as { text: string }).text) as Record<
    string,
    unknown
  >;
}

describe("find: market.search says where a capability runs and which computers can take it", () => {
  it("media-ffmpeg runs on a computer, GPL, and only the Mac fits", async () => {
    const out = (await BUILTIN_VERBS["market.search"]!(
      { query: "ffmpeg", kind: "capability" },
      { userId: PERSON, workspaceId: null, agentUserId: AGENT }
    )) as { entries: Array<Record<string, unknown>> };
    const ffmpeg = out.entries.find((e) => e.slug === "media-ffmpeg")!;
    expect(ffmpeg).toMatchObject({
      installed: false,
      runsOn: ["computer"],
      systems: ["darwin", "linux", "win32"],
      licence: "GPL-2.0-or-later",
    });
    const computers = ffmpeg.computers as Array<Record<string, unknown>>;
    expect(computers.map((c) => [c.name, c.canInstall])).toEqual([
      ["Mac", true],
      ["NAS", false],
      ["Surface", false],
    ]);
    expect(computers.find((c) => c.name === "NAS")!.why).toMatch(
      /Installs from the pod/
    );
    expect(computers.find((c) => c.name === "Surface")!.why).toMatch(
      /processor \(arm64\)/
    );
  });

  it("a pod capability says it runs on the pod, with no computers", async () => {
    const out = (await BUILTIN_VERBS["market.search"]!(
      { query: "web reader", kind: "capability" },
      { userId: PERSON, workspaceId: null, agentUserId: AGENT }
    )) as { entries: Array<Record<string, unknown>> };
    const reader = out.entries.find((e) => e.slug === "web-reader")!;
    expect(reader.runsOn).toEqual(["pod"]);
    expect(reader.computers).toBeUndefined();
  });
});

describe("wrong choices answer with a reason the AI can act on", () => {
  it.each([
    ["Surface", "UNSUPPORTED_COMPUTER", /processor \(arm64\)/],
    ["NAS", "INSTALLS_FROM_POD_OFF", /Installs from the pod/],
  ])("media-ffmpeg on %s: %s", async (computer, reason, words) => {
    const gateBefore = h.gate.length;
    const out = await asAgent("synap_request_installation", {
      capabilityKey: "media-ffmpeg",
      computer,
    });
    expect(out).toMatchObject({
      status: "refused",
      code: "CANNOT_INSTALL",
      reason,
    });
    expect(out.error).toMatch(words);
    // It names where it CAN go.
    const fits = (out.computers as Array<Record<string, unknown>>)
      .filter((c) => c.canInstall)
      .map((c) => c.name);
    expect(fits).toEqual(["Mac"]);
    expect(h.gate.length, "nothing reached the gate").toBe(gateBefore);
    expect(out).not.toHaveProperty("manifest");
    expect(out).not.toHaveProperty("httpStatus");
  });

  it("a pod capability sent to a computer: ask with computer pod", async () => {
    const out = await asAgent("synap_request_installation", {
      capabilityKey: "web-reader",
      computer: "Mac",
    });
    expect(out).toMatchObject({
      status: "refused",
      code: "CANNOT_INSTALL",
      reason: "RUNS_ON_POD",
    });
    expect(out.error).toMatch(/computer "pod"/);
  });

  it("a computer capability sent to the pod: name a computer, here are the ones that fit", async () => {
    const out = await asAgent("synap_request_installation", {
      capabilityKey: "media-ffmpeg",
      computer: "pod",
    });
    expect(out).toMatchObject({
      status: "refused",
      code: "CANNOT_INSTALL",
      reason: "RUNS_ON_COMPUTER",
    });
    const fits = (out.computers as Array<Record<string, unknown>>)
      .filter((c) => c.canInstall)
      .map((c) => c.name);
    expect(fits).toEqual(["Mac"]);
  });

  it("a person's own ask never adds from the catalog: that is the Marketplace's, with its sign-in", async () => {
    const res = await installationHandlers.synap_request_installation!({
      toolName: "synap_request_installation",
      args: { capabilityKey: "media-ffmpeg", computer: "Mac" },
      userId: PERSON,
      apiKeyScopes: ["mcp.read", "mcp.write"],
    } as never);
    const out = JSON.parse((res.content[0] as { text: string }).text);
    expect(out).toMatchObject({ status: "refused", code: "NOT_INSTALLABLE" });
    expect(out.error).toMatch(/Marketplace first/);
    expect(h.added).toEqual([]);
  });

  it("a computer the person does not have: their computers to pick from", async () => {
    const out = await asAgent("synap_request_installation", {
      capabilityKey: "media-ffmpeg",
      computer: "Laptop",
    });
    expect(out).toMatchObject({
      status: "refused",
      code: "COMPUTER_NOT_FOUND",
    });
    expect(
      (out.computers as Array<Record<string, unknown>>).map((c) => c.name)
    ).toEqual(["Mac", "NAS", "Surface"]);
  });
});

describe("ask, approve, observe: one card adds media-ffmpeg and installs it on the Mac", () => {
  it("the agent's one call files ONE proposal that names the addition, the computer and the licence", async () => {
    const out = await asAgent("synap_request_installation", {
      capabilityKey: "media-ffmpeg",
      computer: "mac",
    });
    expect(out.status, JSON.stringify(out)).toBe("proposed");
    const filed = h.gate.at(-1)!;
    expect(filed).toMatchObject({
      subjectType: "installation",
      action: "request",
      agentUserId: AGENT,
      proposeBeyondGrant: true,
      data: {
        computerId: MAC,
        computerName: "Mac",
        capabilityKey: "media-ffmpeg",
        kind: "tool",
        action: "install",
        catalog: {
          slug: "media-ffmpeg",
          version: "0.35.0",
          licence: "GPL-2.0-or-later",
        },
      },
    });
    expect(filed.reasoning).toMatch(
      /^Add "ffmpeg on your computer" \(media-ffmpeg, version 0\.35\.0, licence GPL-2\.0-or-later\) from the marketplace to the pod, then install it on Mac/
    );
    // Nothing is added before the person approves.
    expect(h.added).toEqual([]);
    const caps = await q(
      `SELECT id FROM capabilities WHERE template_key = 'media-ffmpeg'`
    );
    expect(caps.rows).toHaveLength(0);
  });

  it("approving it adds the capability with its computer blocks and queues the Mac's install job", async () => {
    const filed = h.gate.at(-1)!;
    const data = filed.data as Record<string, unknown>;
    const proposalId = randomUUID();
    await q(
      `INSERT INTO proposals (id, target_type, target_id, proposal_type, data, status, revision_history, created_at, updated_at)
       VALUES ($1, 'installation', $2, 'request', $3::jsonb, 'pending', '[]'::jsonb, now(), now())`,
      [proposalId, MAC, JSON.stringify(data)]
    );
    const executor = proposalExecRegistry.resolve(
      "installation/request",
      "request"
    );
    expect(executor, "installation/request executor").toBeDefined();
    const reviewed: string[] = [];
    await executor!.execute({
      proposal: {
        id: proposalId,
        targetType: "installation",
        targetId: MAC,
        proposalType: "request",
        workspaceId: null,
        sessionId: null,
        projectId: null,
        agentUserId: AGENT,
        sourceMessageId: null,
        data,
      },
      payload: data,
      userId: PERSON,
      input: { proposalId },
      ctx: {} as ProposalExecutorArgs["ctx"],
      deps: {
        db: null,
        emitProposalReviewed: (id: string) => reviewed.push(id),
        reportProposalOutcome: () => {},
        stampProjectMembership: async () => {},
        resolveMessagingAccountForPlatform: async () => null,
      },
    } as unknown as ProposalExecutorArgs);

    expect(h.added).toEqual(["media-ffmpeg"]);
    const cap = (
      await q<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM capabilities WHERE template_key = 'media-ffmpeg'`
      )
    ).rows;
    expect(cap).toHaveLength(1);
    expect(cap[0]!.metadata.computer).toEqual(pickComputerSpec(DEF));

    const inst = (
      await q<{
        id: string;
        status: string;
        kind: string;
        approved_by: string;
        proposal_id: string;
      }>(
        `SELECT id, status, kind, approved_by, proposal_id FROM installations WHERE machine_user_id = $1 AND capability_key = 'media-ffmpeg'`,
        [MAC]
      )
    ).rows;
    expect(inst).toHaveLength(1);
    expect(inst[0]).toMatchObject({
      status: "planned",
      kind: "tool",
      approved_by: PERSON,
      proposal_id: proposalId,
    });
    const jobs = (
      await q<{ kind: string; status: string; machine_user_id: string }>(
        `SELECT kind, status, machine_user_id FROM host_jobs WHERE installation_id = $1`,
        [inst[0]!.id]
      )
    ).rows;
    expect(jobs).toEqual([
      { kind: "install", status: "queued", machine_user_id: MAC },
    ]);
    const status = (
      await q<{ status: string }>(
        `SELECT status FROM proposals WHERE id = $1`,
        [proposalId]
      )
    ).rows;
    expect(status[0]!.status).toBe("approved");
    expect(reviewed).toEqual([proposalId]);
  });

  it("asked again, it is already approved for the Mac: a repair asks nobody", async () => {
    const gateBefore = h.gate.length;
    const out = await asAgent("synap_request_installation", {
      capabilityKey: "media-ffmpeg",
      computer: MAC,
    });
    expect(out.status).toBe("approved");
    expect(h.gate.length).toBe(gateBefore);
  });

  it("the agent reads the result with synap_list_installations under the AI preset grant", async () => {
    const AI = {
      scopes: [
        {
          permissions: GRANT_PRESETS.find(
            (r) => r.id === AI_READ_PROPOSE_ROLE_ID
          )!.grant.permissions,
        },
      ],
      clientId: null,
    } as never;
    expect(mcpToolAllowed("synap_list_installations", true, AI)).toBe(true);
    expect(mcpToolAllowed("synap_request_installation", false, AI)).toBe(true);
    const out = await runWithGrant(AI, () =>
      asAgent("synap_list_installations", { capabilityKey: "media-ffmpeg" })
    );
    expect(out.installations).toEqual([
      expect.objectContaining({
        computerId: MAC,
        computerName: "Mac",
        capabilityKey: "media-ffmpeg",
        kind: "tool",
        status: "planned",
        desiredState: "installed",
      }),
    ]);
  });
});

describe("the pod as the target", () => {
  it("a pod capability is proposed through the marketplace door", async () => {
    const out = await asAgent("synap_request_installation", {
      capabilityKey: "web-reader",
      computer: "pod",
    });
    expect(out.status, JSON.stringify(out)).toBe("proposed");
    expect(h.pending.at(-1)).toMatchObject({
      targetType: "capability",
      targetId: "market:capability:web-reader",
      proposalType: "capability.install",
      agentUserId: AGENT,
      data: { slug: "web-reader", kind: "capability" },
    });
  });
});
