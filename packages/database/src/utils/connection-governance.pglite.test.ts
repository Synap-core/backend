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
  readConnectionSync,
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

describe("disableConnectionAutoRule — revokes only this connection+scope's auto rules", () => {
  it("leaves propose rules, other scopes and other connections untouched", async () => {
    await pg.exec(`DELETE FROM governance_rules`);
    const target = await rule({
      scope: "workspace",
      workspaceId: WS,
      verdict: "auto",
    });
    await rule({ scope: "workspace", workspaceId: WS, verdict: "propose" });
    await rule({ scope: "workspace", workspaceId: OTHER_WS, verdict: "auto" });
    await rule({ scope: "pod", verdict: "auto" });
    await rule({
      scope: "workspace",
      workspaceId: WS,
      verdict: "auto",
      target: "conn-other",
    });

    await expect(
      disableConnectionAutoRule({
        db,
        userId: "u1",
        workspaceId: WS,
        connectionId: CONN,
      })
    ).resolves.toEqual({ revokedRuleIds: [target] });

    const active = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM governance_rules WHERE revoked_at IS NULL`
    );
    expect(active.rows[0]!.n).toBe(4);
  });
});
