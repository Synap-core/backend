/**
 * REAL-POSTGRES (PGlite) behaviour test for the connection-governance SQL.
 *
 * The fake-db unit test (`connection-governance.test.ts`) serves queued rows and
 * ignores every WHERE clause, so it could not see:
 *   - the JSON-shape predicate in `isConnectionSyncProposal` (a JSON-null /
 *     array / scalar stamp, a non-import.graph proposal type);
 *   - the scope / principal / revoked / expired predicates in
 *     `resolveConnectionSyncDecision`;
 *   - `disableConnectionAutoRule` revoking only this connection+scope's AUTO rules.
 * These run the real helpers against real Postgres with minimal DDL for the two
 * tables they read. ONE PGlite instance for the file (booted once).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  isConnectionSyncProposal,
  resolveConnectionSyncDecision,
  disableConnectionAutoRule,
  retireConnectionRules,
  readConnectionSync,
  ensureConnectionAutoRule,
  ensureConnectionReviewRule,
  applyConnectionSyncApproval,
} from "./connection-governance.js";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const CONN = "conn-1";

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE governance_principal AS ENUM ('agent','any');
    CREATE TYPE governance_scope AS ENUM ('workspace','pod');
    CREATE TYPE governance_target AS ENUM ('action','profile','capability','connection');
    CREATE TYPE governance_verdict AS ENUM ('auto','propose');
    CREATE TABLE governance_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      principal_kind governance_principal NOT NULL,
      agent_user_id text,
      scope_kind governance_scope NOT NULL,
      workspace_id uuid,
      target_kind governance_target NOT NULL,
      target_pattern text NOT NULL,
      target_profile text,
      verdict governance_verdict NOT NULL,
      source_proposal_id uuid,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      expires_at timestamptz
    );
  `);
  // `proposals` — only the columns the helpers select or filter on.
  await pg.exec(`
    CREATE TABLE proposals (
      id uuid PRIMARY KEY,
      workspace_id text,
      proposal_type text NOT NULL,
      data jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending'
    );
  `);
  // `secrets` — only what the approval hook's owner check reads.
  await pg.exec(`
    CREATE TABLE secrets (
      id text PRIMARY KEY,
      user_id text NOT NULL
    );
  `);
  db = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

async function proposal(id: string, proposalType: string, data: unknown) {
  await pg.query(
    `INSERT INTO proposals (id, proposal_type, data) VALUES ($1, $2, $3::jsonb)`,
    [id, proposalType, JSON.stringify(data)]
  );
}

async function rule(opts: {
  scope: "workspace" | "pod";
  workspaceId?: string | null;
  verdict: "auto" | "propose";
  target?: string;
  principal?: "any" | "agent";
  revoked?: boolean;
  expired?: boolean;
  createdAt?: string;
}): Promise<string> {
  const res = await pg.query<{ id: string }>(
    `INSERT INTO governance_rules
       (principal_kind, scope_kind, workspace_id, target_kind, target_pattern,
        verdict, created_by, created_at, revoked_at, expires_at)
     VALUES ($1, $2, $3, 'connection', $4, $5, 'user:u1', COALESCE($6::timestamptz, now()),
             CASE WHEN $7 THEN now() ELSE NULL END,
             CASE WHEN $8 THEN now() - interval '1 day' ELSE NULL END)
     RETURNING id`,
    [
      opts.principal ?? "any",
      opts.scope,
      opts.workspaceId ?? null,
      opts.target ?? CONN,
      opts.verdict,
      opts.createdAt ?? null,
      opts.revoked ?? false,
      opts.expired ?? false,
    ]
  );
  return res.rows[0]!.id;
}

describe("isConnectionSyncProposal — agrees with readConnectionSync on every stamp shape", () => {
  const cases: Array<[string, string, unknown, boolean]> = [
    [
      "well-formed stamp",
      "import.graph",
      { connectionSync: { connectionId: "c", kinds: [] } },
      true,
    ],
    ["JSON null stamp", "import.graph", { connectionSync: null }, false],
    [
      "array stamp",
      "import.graph",
      { connectionSync: [{ connectionId: "c" }] },
      false,
    ],
    ["scalar stamp", "import.graph", { connectionSync: "c" }, false],
    [
      "object without connectionId",
      "import.graph",
      { connectionSync: { provider: "google" } },
      false,
    ],
    [
      "empty connectionId",
      "import.graph",
      { connectionSync: { connectionId: "" } },
      false,
    ],
    ["no stamp", "import.graph", { operations: [] }, false],
    [
      "well-formed stamp on another proposal type",
      "capture.graph",
      { connectionSync: { connectionId: "c" } },
      false,
    ],
  ];

  cases.forEach(([label, type, data, expected], i) => {
    it(`${label} → ${expected}`, async () => {
      const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
      await proposal(id, type, data);
      await expect(isConnectionSyncProposal(id, db)).resolves.toBe(expected);
      // Parity with the in-memory reader (only an import.graph can count):
      const reader = readConnectionSync(data);
      const readerSaysSync =
        type === "import.graph" && typeof reader === "object";
      expect(readerSaysSync, `reader/SQL disagree on: ${label}`).toBe(expected);
    });
  });
});

describe("resolveConnectionSyncDecision — the real scope / principal / lifecycle predicates", () => {
  it("ignores another workspace's, revoked, expired and agent-principal rules; takes this workspace's", async () => {
    await pg.exec(`DELETE FROM governance_rules`);
    await rule({ scope: "workspace", workspaceId: OTHER_WS, verdict: "auto" });
    await rule({
      scope: "workspace",
      workspaceId: WS,
      verdict: "auto",
      revoked: true,
    });
    await rule({
      scope: "workspace",
      workspaceId: WS,
      verdict: "auto",
      expired: true,
    });
    await rule({
      scope: "workspace",
      workspaceId: WS,
      verdict: "auto",
      principal: "agent",
    });
    await rule({
      scope: "workspace",
      workspaceId: WS,
      verdict: "auto",
      target: "conn-other",
    });
    await expect(
      resolveConnectionSyncDecision({
        db,
        userId: "u1",
        workspaceId: WS,
        connectionId: CONN,
      })
    ).resolves.toEqual({ verdict: "propose", source: "none" });

    const live = await rule({
      scope: "workspace",
      workspaceId: WS,
      verdict: "auto",
    });
    await expect(
      resolveConnectionSyncDecision({
        db,
        userId: "u1",
        workspaceId: WS,
        connectionId: CONN,
      })
    ).resolves.toEqual({ verdict: "auto", ruleId: live, source: "rule" });
  });

  it("a workspace sync still sees a pod-scope rule, and a workspace rule outranks it", async () => {
    await pg.exec(`DELETE FROM governance_rules`);
    const pod = await rule({ scope: "pod", verdict: "auto" });
    await expect(
      resolveConnectionSyncDecision({
        db,
        userId: "u1",
        workspaceId: WS,
        connectionId: CONN,
      })
    ).resolves.toEqual({ verdict: "auto", ruleId: pod, source: "rule" });

    // An OLDER workspace-scope rule still beats the newer pod-scope one.
    const ws = await rule({
      scope: "workspace",
      workspaceId: WS,
      verdict: "propose",
      createdAt: "2020-01-01T00:00:00Z",
    });
    await expect(
      resolveConnectionSyncDecision({
        db,
        userId: "u1",
        workspaceId: WS,
        connectionId: CONN,
      })
    ).resolves.toMatchObject({
      verdict: "propose",
      ruleId: ws,
      source: "rule",
    });
  });

  it("a pod-wide sync sees only pod-scope rules", async () => {
    await pg.exec(`DELETE FROM governance_rules`);
    await rule({ scope: "workspace", workspaceId: WS, verdict: "auto" });
    await expect(
      resolveConnectionSyncDecision({
        db,
        userId: "u1",
        workspaceId: null,
        connectionId: CONN,
      })
    ).resolves.toEqual({ verdict: "propose", source: "none" });
    const pod = await rule({ scope: "pod", verdict: "auto" });
    await expect(
      resolveConnectionSyncDecision({
        db,
        userId: "u1",
        workspaceId: null,
        connectionId: CONN,
      })
    ).resolves.toMatchObject({ verdict: "auto", ruleId: pod });
  });
});

describe("disableConnectionAutoRule — revokes every auto rule the resolver reads for the scope", () => {
  it("a workspace disable revokes this workspace's AND the pod's auto rules; propose rules, other workspaces and other connections stay", async () => {
    await pg.exec(`DELETE FROM governance_rules`);
    const wsAuto = await rule({
      scope: "workspace",
      workspaceId: WS,
      verdict: "auto",
    });
    const podAuto = await rule({ scope: "pod", verdict: "auto" });
    await rule({ scope: "workspace", workspaceId: WS, verdict: "propose" });
    await rule({ scope: "workspace", workspaceId: OTHER_WS, verdict: "auto" });
    await rule({
      scope: "workspace",
      workspaceId: WS,
      verdict: "auto",
      target: "conn-other",
    });

    const { revokedRuleIds } = await disableConnectionAutoRule({
      db,
      userId: "u1",
      workspaceId: WS,
      connectionId: CONN,
    });
    expect([...revokedRuleIds].sort()).toEqual([wsAuto, podAuto].sort());

    const active = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM governance_rules WHERE revoked_at IS NULL`
    );
    expect(active.rows[0]!.n).toBe(3);
  });

  it("keep-syncing OFF on a workspace sync with only a POD-scope auto rule: the next decision proposes", async () => {
    await pg.exec(`DELETE FROM governance_rules`);
    await rule({ scope: "pod", verdict: "auto" });
    const scope = { db, userId: "u1", workspaceId: WS, connectionId: CONN };
    await expect(resolveConnectionSyncDecision(scope)).resolves.toMatchObject({
      verdict: "auto",
    });

    await disableConnectionAutoRule(scope);

    await expect(resolveConnectionSyncDecision(scope)).resolves.toEqual({
      verdict: "propose",
      source: "none",
    });
  });

  it("a pod-wide disable leaves workspace-scope rules alone (the pod-wide resolver never reads them)", async () => {
    await pg.exec(`DELETE FROM governance_rules`);
    const podAuto = await rule({ scope: "pod", verdict: "auto" });
    await rule({ scope: "workspace", workspaceId: WS, verdict: "auto" });
    await expect(
      disableConnectionAutoRule({
        db,
        userId: "u1",
        workspaceId: null,
        connectionId: CONN,
      })
    ).resolves.toEqual({ revokedRuleIds: [podAuto] });
  });
});

describe("retireConnectionRules — a gone connection keeps no active rule", () => {
  it("revokes every rule of the named connections in every scope and verdict; other connections untouched", async () => {
    await pg.exec(`DELETE FROM governance_rules`);
    const retired = [
      await rule({ scope: "workspace", workspaceId: WS, verdict: "auto" }),
      await rule({
        scope: "workspace",
        workspaceId: OTHER_WS,
        verdict: "propose",
      }),
      await rule({ scope: "pod", verdict: "auto" }),
      await rule({ scope: "pod", verdict: "auto", target: "conn-2" }),
    ];
    const kept = await rule({
      scope: "pod",
      verdict: "auto",
      target: "conn-kept",
    });

    const { revokedRuleIds } = await retireConnectionRules({
      db,
      connectionIds: [CONN, "conn-2"],
    });
    expect([...revokedRuleIds].sort()).toEqual([...retired].sort());

    const active = await pg.query<{ id: string }>(
      `SELECT id FROM governance_rules WHERE revoked_at IS NULL`
    );
    expect(active.rows.map((r) => r.id)).toEqual([kept]);
    await expect(
      retireConnectionRules({ db, connectionIds: [] })
    ).resolves.toEqual({ revokedRuleIds: [] });
  });
});

describe("keep syncing OFF is a review rule naming the import — durable against the async approval hook", () => {
  const IMPORT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const IMPORT_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

  async function freshConnection() {
    await pg.exec(`DELETE FROM governance_rules; DELETE FROM secrets;`);
    await pg.query(`INSERT INTO secrets (id, user_id) VALUES ($1, 'u1')`, [
      CONN,
    ]);
  }

  async function activeRules() {
    const r = await pg.query<{
      verdict: string;
      scope_kind: string;
      source_proposal_id: string | null;
    }>(
      `SELECT verdict, scope_kind, source_proposal_id FROM governance_rules
       WHERE target_pattern = $1 AND revoked_at IS NULL ORDER BY created_at`,
      [CONN]
    );
    return r.rows;
  }

  const approvedImport = (id: string) => ({
    id,
    proposalType: "import.graph",
    workspaceId: null,
    data: {
      operations: [],
      connectionSync: { connectionId: CONN, keepSyncing: true },
    },
  });

  it("OFF revokes the auto rules the scope reads and keeps ONE review rule naming the import; same import is idempotent, a newer import replaces it", async () => {
    await freshConnection();
    await rule({ scope: "workspace", workspaceId: WS, verdict: "auto" });
    await rule({ scope: "pod", verdict: "auto" });
    const scope = { db, userId: "u1", workspaceId: WS, connectionId: CONN };

    await expect(
      ensureConnectionReviewRule({ ...scope, sourceProposalId: IMPORT_1 })
    ).resolves.toMatchObject({ created: true });
    expect(await activeRules()).toEqual([
      {
        verdict: "propose",
        scope_kind: "workspace",
        source_proposal_id: IMPORT_1,
      },
    ]);

    await expect(
      ensureConnectionReviewRule({ ...scope, sourceProposalId: IMPORT_1 })
    ).resolves.toMatchObject({ created: false });
    expect(await activeRules()).toHaveLength(1);

    await ensureConnectionReviewRule({ ...scope, sourceProposalId: IMPORT_2 });
    expect(await activeRules()).toEqual([
      {
        verdict: "propose",
        scope_kind: "workspace",
        source_proposal_id: IMPORT_2,
      },
    ]);
  });

  it("the approval hook does not mint an auto rule for an import the owner already turned off", async () => {
    await freshConnection();
    await ensureConnectionReviewRule({
      db,
      userId: "u1",
      workspaceId: null,
      connectionId: CONN,
      sourceProposalId: IMPORT_1,
    });

    await expect(
      applyConnectionSyncApproval({
        db,
        proposal: approvedImport(IMPORT_1),
        userId: "u1",
      })
    ).resolves.toEqual({ applied: false, skipped: "keep-syncing-off" });
    expect(await activeRules()).toEqual([
      { verdict: "propose", scope_kind: "pod", source_proposal_id: IMPORT_1 },
    ]);
  });

  it("a review rule from an OLDER import does not block a new approval: auto is minted, the stale rule revoked", async () => {
    await freshConnection();
    await ensureConnectionReviewRule({
      db,
      userId: "u1",
      workspaceId: null,
      connectionId: CONN,
      sourceProposalId: IMPORT_1,
    });

    await expect(
      applyConnectionSyncApproval({
        db,
        proposal: approvedImport(IMPORT_2),
        userId: "u1",
      })
    ).resolves.toMatchObject({ applied: true, created: true });
    expect(await activeRules()).toEqual([
      { verdict: "auto", scope_kind: "pod", source_proposal_id: IMPORT_2 },
    ]);
  });

  it("OFF then ON: auto wins", async () => {
    await freshConnection();
    const scope = { db, userId: "u1", workspaceId: null, connectionId: CONN };
    await ensureConnectionReviewRule({ ...scope, sourceProposalId: IMPORT_1 });
    await ensureConnectionAutoRule({ ...scope, sourceProposalId: IMPORT_1 });

    expect(await activeRules()).toEqual([
      { verdict: "auto", scope_kind: "pod", source_proposal_id: IMPORT_1 },
    ]);
    await expect(
      resolveConnectionSyncDecision({ ...scope })
    ).resolves.toMatchObject({ verdict: "auto" });
  });
});
