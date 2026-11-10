/**
 * An AI's install ask, approved by the person, installs: the REAL path end to
 * end (live defect, 2026-11-09: proposal 55928891, filed by Claude Code
 * through MCP `synap_request_installation` for media-ffmpeg on the founder's
 * Mac, failed on approval with "this computer is not yours, or it is no
 * longer connected").
 *
 * THE DEFECT: the gate files the ask's payload NESTED (`proposal.data.data`,
 * under the request envelope), and the `installation/request` executor read
 * `action`, `capabilityKey` and `catalog` at the top of `proposal.data`. So
 * `action` was undefined and every agent's ask failed on approval with a
 * sentence about the computer. The older suite inserted the payload flat,
 * which no filer writes, so it never saw it.
 *
 * Driven here with no stub between the doors: the agent files through the
 * MCP handler and the REAL gate (`checkPermissionOrPropose`, which writes
 * the proposal row), the person approves through the REAL
 * `proposals.approve` with a fresh sign-in, and the executor runs. The
 * request and the approval read the person's computer through ONE read
 * (`listPersonsComputers` → the machine roster).
 *
 * Stubbed, each pinned elsewhere: delivery side effects (events, realtime,
 * audit), the catalog signature check (network), and the marketplace
 * applier's capability branch, replaced by the container door it hands the
 * computer blocks to (as request-installation.pglite.test.ts does).
 *
 * A failed approval names the check that failed: not their computer, not a
 * computer, or "Installs from the pod" off; never "no longer connected",
 * which nothing checks.
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
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  // PGlite is ONE connection: a write inside `db.transaction` that reads
  // through the module handle (the gate's receipt-session and focus reads)
  // waits on the transaction it is in. Run the callback on the handle
  // itself; atomicity is not what this suite asserts.
  (db as unknown as { transaction: unknown }).transaction = (
    fn: (tx: unknown) => unknown
  ) => fn(db);
  h.db = db;
  return {
    ...actual,
    db,
    getDb: async () => db,
    registerIdentitySignals: async () => undefined,
    eventRepository: new Proxy(
      {},
      { get: () => async () => ({ id: randomUUID() }) }
    ),
    // The gate's proposal writer and its dedup peek, on this database (their
    // default handle is their own connection, which PGlite does not serve).
    insertPendingProposal: (input: unknown) =>
      (actual.insertPendingProposal as (i: unknown, e: unknown) => unknown)(
        input,
        db
      ),
    findExistingPendingDuplicate: (input: unknown) =>
      (
        actual.findExistingPendingDuplicate as (
          i: unknown,
          e: unknown
        ) => unknown
      )(input, db),
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../lib/event-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logEvent: vi.fn(async () => randomUUID()),
}));
vi.mock("../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../../utils/domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: vi.fn(async () => null),
}));
vi.mock("../../notifications/notify-pod-wide-proposal.js", () => ({
  notifyPodWideProposal: vi.fn(async () => undefined),
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  broadcastNotification: vi.fn(async () => undefined),
}));
vi.mock("../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
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
    applyMarketInstall: async (input: { slug: string; userId: string }) => {
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

// The recipe run's input file: one the person can read, with stored bytes.
vi.mock("../../routers/file-upload.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readableFileEntity: async (_userId: string, id: string) => ({
    ok: true,
    entity: { id, storageKey: `k/${id}`, title: "take.mp4", size: 1 },
  }),
}));

import { pickComputerSpec } from "@synap-core/types/capability-manifest";
import { officialCatalogUrl } from "@synap/jobs/workers/cp-catalog-sync.js";
import { installationHandlers } from "../../routers/mcp/handlers/installations.js";
import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEF = JSON.parse(
  readFileSync(
    resolve(here, "__fixtures__/media-ffmpeg.0.35.0.definition.json"),
    "utf8"
  )
) as Record<string, unknown>;

const HASH_VERSION = `h-${(DEF.contentHash as string).slice(0, 12)}`;

const PERSON = randomUUID();
const STRANGER = randomUUID();
const MAC = randomUUID();
const AGENT = randomUUID();

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** Loaded in `beforeAll`: its cold import is the whole approval graph. */
let proposalsRouter: (typeof import("../../routers/proposals.js"))["proposalsRouter"];

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `INSERT INTO users (id, email, name, user_type, agent_type, created_by_user_id, host_user_id, agent_metadata) VALUES
      ($1, 'a@x', 'person', 'human', NULL, NULL, NULL, '{}'::jsonb),
      ($2, 'z@x', 'stranger', 'human', NULL, NULL, NULL, '{}'::jsonb),
      ($3, 'm@x', 'MacBook-Pro-de-Antoine.local', 'agent', 'machine', $1, NULL, $5::jsonb),
      ($4, 'c@x', 'Claude Code', 'agent', 'claude-code', $1, $3, '{}'::jsonb)`,
    [
      PERSON,
      STRANGER,
      MAC,
      AGENT,
      JSON.stringify({
        platform: "darwin",
        arch: "arm64",
        hostsServices: true,
      }),
    ]
  );
  await q(
    `INSERT INTO cp_catalog_cache (source, kind, slug, name, description, version, definition)
     VALUES ($1, 'capability', 'media-ffmpeg', $2, $3, $5, $4::jsonb)`,
    [
      officialCatalogUrl(),
      DEF.name,
      DEF.description,
      JSON.stringify(DEF),
      // As the live catalog lists a capability: its version is its content
      // hash (`contentHashVersion`), not a package version.
      HASH_VERSION,
    ]
  );
  ({ proposalsRouter } = await import("../../routers/proposals.js"));
}, 120_000);

/** The agent (Claude Code on the Mac) asks through MCP, as it did live. */
async function agentAsks(capabilityKey: string): Promise<string> {
  const res = await installationHandlers["synap_request_installation"]!({
    toolName: "synap_request_installation",
    args: { capabilityKey, computer: "MacBook-Pro-de-Antoine.local" },
    userId: PERSON,
    agentUserId: AGENT,
    apiKeyScopes: ["mcp.read", "mcp.write"],
  } as never);
  const out = JSON.parse((res.content[0] as { text: string }).text) as {
    status: string;
    proposalId?: string;
  };
  expect(out.status, JSON.stringify(out)).toBe("proposed");
  return out.proposalId!;
}

/** The person approves on the console, freshly signed in. */
function personApproves(proposalId: string) {
  return proposalsRouter
    .createCaller({
      db: h.db,
      authenticated: true,
      userId: PERSON,
      workspaceId: null,
      session: { device: { id: "console", authTime: new Date() } },
    } as never)
    .approve({ proposalId } as never);
}

async function proposalRow(id: string) {
  return (
    await q<{
      status: string;
      rejection_reason: string | null;
      data: Record<string, unknown>;
    }>(`SELECT status, rejection_reason, data FROM proposals WHERE id = $1`, [
      id,
    ])
  ).rows[0]!;
}

async function setMac(sql: string, params: unknown[] = []) {
  await q(`UPDATE users SET ${sql} WHERE id = $1`, [MAC, ...params]);
}

describe("an AI asks to install media-ffmpeg on the person's Mac, and the person approves", () => {
  let proposalId: string;

  it("the gate files ONE proposal whose ask is nested under the request envelope", async () => {
    proposalId = await agentAsks("media-ffmpeg");
    const row = await proposalRow(proposalId);
    expect(row.status).toBe("pending");
    // The shape the live row had: the ask sits under `data.data`.
    expect(row.data.data).toMatchObject({
      computerId: MAC,
      capabilityKey: "media-ffmpeg",
      action: "install",
      catalog: { slug: "media-ffmpeg", version: HASH_VERSION },
    });
  });

  it("lists and notifications read what it does, and the hash is not shown as a version", async () => {
    const row = await proposalRow(proposalId);
    // The stored summary is the card's own title (one derivation), never
    // the generic "Request Installation".
    expect(row.data.summary).toBe(
      'Add "ffmpeg on your computer" from the marketplace and install it on MacBook-Pro-de-Antoine.local'
    );
    // The person's sentence names the licence, never the content hash; the
    // hash stays on the ask for the approval's check (above).
    expect(row.data.reasoning).toMatch(/licence GPL-2\.0-or-later/);
    expect(row.data.reasoning).not.toContain(HASH_VERSION);
    expect(row.data.reasoning).not.toMatch(/version/);
  });

  it("approving it adds the capability, records the installation and queues the Mac's install", async () => {
    await personApproves(proposalId);
    const row = await proposalRow(proposalId);
    expect(row.rejection_reason).toBeNull();
    expect(row.status).toBe("approved");
    const inst = (
      await q<{ id: string; status: string; approved_by: string }>(
        `SELECT id, status, approved_by FROM installations WHERE machine_user_id = $1 AND capability_key = 'media-ffmpeg'`,
        [MAC]
      )
    ).rows;
    expect(inst).toEqual([
      expect.objectContaining({ status: "planned", approved_by: PERSON }),
    ]);
    const jobs = (
      await q<{ kind: string; status: string }>(
        `SELECT kind, status FROM host_jobs WHERE installation_id = $1`,
        [inst[0]!.id]
      )
    ).rows;
    expect(jobs).toEqual([{ kind: "install", status: "queued" }]);
  });
});

describe("a failed approval names the check that failed", () => {
  // A capability already on the pod (added above): the ask is an update, so
  // it is filed again for approval.
  async function fileThenChangeMac(
    change: () => Promise<void>
  ): Promise<{ status: string; reason: string | null }> {
    const res = await installationHandlers["synap_request_installation"]!({
      toolName: "synap_request_installation",
      args: {
        capabilityKey: "media-ffmpeg",
        computer: MAC,
        action: "update",
        version: `9.${randomUUID().slice(0, 4)}`,
      },
      userId: PERSON,
      agentUserId: AGENT,
      apiKeyScopes: ["mcp.read", "mcp.write"],
    } as never);
    const out = JSON.parse((res.content[0] as { text: string }).text) as {
      status: string;
      proposalId?: string;
    };
    expect(out.status, JSON.stringify(out)).toBe("proposed");
    await change();
    try {
      await personApproves(out.proposalId!).catch(() => undefined);
      const row = await proposalRow(out.proposalId!);
      return { status: row.status, reason: row.rejection_reason };
    } finally {
      await setMac(
        `created_by_user_id = $2, agent_type = 'machine', agent_metadata = $3::jsonb`,
        [
          PERSON,
          JSON.stringify({
            platform: "darwin",
            arch: "arm64",
            hostsServices: true,
          }),
        ]
      );
    }
  }

  it('"Installs from the pod" turned off: says so', async () => {
    const out = await fileThenChangeMac(() =>
      setMac(`agent_metadata = $2::jsonb`, [
        JSON.stringify({ platform: "darwin", arch: "arm64" }),
      ])
    );
    expect(out.status).toBe("approval_failed");
    expect(out.reason).toMatch(/Installs from the pod/);
    expect(out.reason).not.toMatch(/no longer connected/);
  });

  it("the computer now belongs to someone else: says it is not theirs", async () => {
    const out = await fileThenChangeMac(() =>
      setMac(`created_by_user_id = $2`, [STRANGER])
    );
    expect(out.status).toBe("approval_failed");
    expect(out.reason).toMatch(/not one of your computers/);
    expect(out.reason).not.toMatch(/no longer connected/);
  });

  it("the target is no longer a computer: says so", async () => {
    const out = await fileThenChangeMac(() =>
      setMac(`agent_type = 'claude-code'`)
    );
    expect(out.status).toBe("approval_failed");
    expect(out.reason).toMatch(/is not a computer/);
    expect(out.reason).not.toMatch(/no longer connected/);
  });
});

/**
 * The pod's media-ffmpeg gained a recipe after the Mac's approval (live,
 * 2026-11-10: range-cut entered the catalog at 0.38; installation 4ed7c8a5
 * kept its approval-time snapshot; two `action: "update"` asks came back
 * `approved` at once and reinstalled the SAME snapshot, so the refusal's own
 * advice "ask for its update" led nowhere).
 *
 * An update with no version now moves the snapshot to the pod's CURRENT
 * definition: an ask when it differs (founder decision 2: upgrades ask),
 * naming what it adds; a repair when it is the same. Through the real MCP
 * handler, gate, `proposals.approve` and executor, then the real
 * `computer.run_recipe` handler.
 *
 * Negative control: with `requestNeedsApproval` ignoring the definition (the
 * pre-fix rule), the ask is `approved` at once, nothing moves, and the
 * range-cut run is refused.
 */
describe("the pod's media-ffmpeg gained a recipe: an update asks, and approving it moves the Mac's snapshot", () => {
  const NEW_HASH = "d".repeat(64);
  const RANGE_CUT = {
    name: "range-cut",
    description: "Keep one time range of a video.",
    params: {
      in: { type: "file", description: "The video.", required: true },
      out: { type: "output", description: "The result.", required: true },
    },
    steps: [{ program: "ffmpeg", args: ["-y", "-i", "{in}", "{out}"] }],
    gotchas: ["Re-encodes the range."],
  };
  const SPACE = randomUUID();
  let installationId: string;

  const installation = async () =>
    (
      await q<{
        id: string;
        manifest: { recipes?: Array<{ name: string }> };
        capability_version: string | null;
      }>(
        `SELECT id, manifest, capability_version FROM installations WHERE machine_user_id = $1 AND capability_key = 'media-ffmpeg' AND status <> 'removed'`,
        [MAC]
      )
    ).rows[0]!;
  const recipeNames = (m: { recipes?: Array<{ name: string }> }) =>
    (m.recipes ?? []).map((r) => r.name);

  async function agentAsksUpdate() {
    const res = await installationHandlers["synap_request_installation"]!({
      toolName: "synap_request_installation",
      args: {
        capabilityKey: "media-ffmpeg",
        computer: "MacBook-Pro-de-Antoine.local",
        action: "update",
      },
      userId: PERSON,
      agentUserId: AGENT,
      apiKeyScopes: ["mcp.read", "mcp.write"],
    } as never);
    return JSON.parse((res.content[0] as { text: string }).text) as {
      status: string;
      proposalId?: string;
    };
  }

  const runRangeCut = async () => {
    const { BUILTIN_VERBS } = await import("../capabilities/builtin-verbs.js");
    return BUILTIN_VERBS["computer.run_recipe"]!(
      {
        capability: "media-ffmpeg",
        recipe: "range-cut",
        params: { in: randomUUID(), out: "take-cut.mp4" },
        computer: "mac",
      },
      { userId: PERSON, workspaceId: SPACE, agentUserId: AGENT } as never
    );
  };

  beforeAll(async () => {
    // The Mac's install ran and was checked; no job is open.
    installationId = (await installation()).id;
    await q(`DELETE FROM host_jobs WHERE installation_id = $1`, [
      installationId,
    ]);
    await q(
      `UPDATE installations SET status = 'installed', verified_at = now(),
         health = '{"verify":{"ok":true,"exitCode":0}}'::jsonb
       WHERE id = $1`,
      [installationId]
    );
  });

  it("the pod's definition is the snapshot: an update is a repair, nobody is asked", async () => {
    const out = await agentAsksUpdate();
    expect(out.status, JSON.stringify(out)).toBe("approved");
    expect(recipeNames((await installation()).manifest)).not.toContain(
      "range-cut"
    );
    await q(`DELETE FROM host_jobs WHERE installation_id = $1`, [
      installationId,
    ]);
  });

  it("before: range-cut is refused, and the refusal offers the update", async () => {
    // The catalog adds range-cut; the pod's capability converges to it.
    await q(
      `UPDATE capabilities
         SET metadata = jsonb_set(
               jsonb_set(metadata, '{computer,recipes}', (metadata->'computer'->'recipes') || $1::jsonb),
               '{contentHash}', to_jsonb($2::text))
       WHERE template_key = 'media-ffmpeg'`,
      [JSON.stringify([RANGE_CUT]), NEW_HASH]
    );
    await expect(runRangeCut()).rejects.toMatchObject({
      code: "UNKNOWN_RECIPE",
      message: expect.stringMatching(
        /the pod's current one has it\. Ask for the update/
      ),
    });
  });

  let proposalId: string;
  it("the agent's update is ONE ask that names what it adds", async () => {
    const out = await agentAsksUpdate();
    expect(out.status, JSON.stringify(out)).toBe("proposed");
    proposalId = out.proposalId!;
    const row = await proposalRow(proposalId);
    expect(row.data.data).toMatchObject({
      action: "update",
      definition: {
        to: `h-${NEW_HASH.slice(0, 12)}`,
        recipesAdded: ["range-cut"],
        recipesRemoved: [],
      },
    });
    expect(row.data.reasoning).toMatch(
      /Update media-ffmpeg on MacBook-Pro-de-Antoine\.local to the pod's current definition \(adds recipe: range-cut\)/
    );
    // Asked, not applied: the Mac still runs the approved snapshot.
    expect(recipeNames((await installation()).manifest)).not.toContain(
      "range-cut"
    );
  });

  it("approving it moves the snapshot, stamps the version, and queues the update", async () => {
    await personApproves(proposalId);
    const row = await proposalRow(proposalId);
    expect(row.rejection_reason).toBeNull();
    expect(row.status).toBe("approved");
    const inst = await installation();
    expect(recipeNames(inst.manifest)).toContain("range-cut");
    expect(inst.capability_version).toBe(`h-${NEW_HASH.slice(0, 12)}`);
    const jobs = (
      await q<{ kind: string; status: string }>(
        `SELECT kind, status FROM host_jobs WHERE installation_id = $1`,
        [installationId]
      )
    ).rows;
    expect(jobs).toEqual([{ kind: "update", status: "queued" }]);
  });

  it("after: a range-cut run is accepted on the Mac", async () => {
    const out = (await runRangeCut()) as {
      status: string;
      recipe: string;
      computer: { name: string };
    };
    expect(out).toMatchObject({
      status: "queued",
      recipe: "range-cut",
      computer: { name: "MacBook-Pro-de-Antoine.local" },
    });
  });

  it("asked again, the snapshot is the pod's definition: a repair again", async () => {
    await q(`DELETE FROM host_jobs WHERE installation_id = $1`, [
      installationId,
    ]);
    expect((await agentAsksUpdate()).status).toBe("approved");
  });
});
