/**
 * The catalogue's `blocked:{kind:"enable"}` and its `allSpaces` read, driven
 * through the REAL `listCapabilities` SQL (PGlite) → the REAL
 * `sectionCapabilities` fold → the REAL run door's gate.
 *
 * ── 1. ENABLE ≠ GRANT (2026-09-28) ──────────────────────────────────────────
 * `sections` used to derive "needs enable" from a TOOL-level `vault_grants` row
 * while the run door refuses only on APPROVAL (`not_approved`). Nothing an
 * operator can press issues a tool grant (enable flips `approved`), so a pack
 * whose verbs all ran — Google on antoinesrvt: 11 verbs, all
 * `backingSkillExecutable` — read "needs enable" forever. The tool grant is a
 * governance POSTURE for agent runs (no grant ⇒ propose, never refuse) and
 * authorises no credential (vault secrets carry their own `secret` grant;
 * Nango resolves by connection). So the ONE predicate is approval:
 * `isToolRowLaunchable`, shared with the runnable-action projection.
 *
 * The test asserts the display AGREES with the gate on every row, rather than
 * pinning one answer: `blocked.kind === "enable"` ⇔ the gate DENIES a human run
 * of the verb's backing skill ⇔ the projection advertises nothing for the row.
 *
 * ── 2. ONE READ FOR ALL SPACES ──────────────────────────────────────────────
 * Rows in two visible spaces + pod-wide + one space the caller cannot see.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
      exec: (sql: string) => Promise<unknown>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = await h.init();
  return { ...actual, db, getDb: async () => db };
});
// No IS in a unit test: the IS-native manifest fetch degrades to [] (its
// documented behaviour when the IS is unreachable).
vi.mock("@synap/intelligence-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDefaultActiveService: async () => {
      throw new Error("no IS in test");
    },
  };
});

import * as schema from "@synap/database/schema";
import type { PgTable } from "drizzle-orm/pg-core";
import { gateCapabilityExecution } from "@synap/capability-gate";
import { pgliteSchemaDdl } from "../../__tests__/pglite-ddl.js";
import {
  listCapabilities,
  sectionCapabilities,
} from "./capability-registry.js";
import { projectRunnableActions } from "./action-projection.js";

const U = randomUUID(); // the caller
const STRANGER = randomUUID();
const WS_A = randomUUID(); // U is a member
const WS_B = randomUUID(); // U owns it, no member row (sovereign-owner shape)
const WS_C = randomUUID(); // U can NOT see it
const PACK = randomUUID();

const q = (sql: string, params: unknown[] = []) =>
  h.client!.query(sql, params) as Promise<{ rows: Array<Record<string, any>> }>;

async function tool(
  name: string,
  opts: {
    approved: boolean;
    kind?: string;
    workspaceId?: string | null;
    verbs?: string[];
  }
) {
  const id = randomUUID();
  const catalog = (opts.verbs ?? []).map((v) => ({
    id: v,
    kind: "read",
    label: v,
    govDefault: "propose",
  }));
  await q(
    `insert into tools (id, name, kind, approved, status, workspace_id, created_by, capabilities, credential_ref)
     values ($1,$2,$3,$4,'active',$5,$6,$7::jsonb,$8)`,
    [
      id,
      name,
      opts.kind ?? "api",
      opts.approved,
      opts.workspaceId ?? null,
      U,
      JSON.stringify(catalog),
      opts.kind === "provider" ? `nango://${name}` : null,
    ]
  );
  await q(
    `insert into links (from_type, from_id, to_type, to_id, link_type) values ('tool',$1,'capability',$2,'member_of')`,
    [id, PACK]
  );
  return id;
}

async function skill(
  name: string,
  approved: boolean,
  scope: "pod" | "workspace" = "pod",
  workspaceId: string | null = null
) {
  const id = randomUUID();
  await q(
    `insert into skills (id, name, kind, status, approved, scope, workspace_id, user_id, metadata)
     values ($1,$2,'code','active',$3,$4,$5,$6,'{}'::jsonb)`,
    [id, name, approved, scope, workspaceId, U]
  );
  return id;
}

beforeAll(async () => {
  await h.init();
  const s = schema as unknown as Record<string, PgTable>;
  await h.client!.exec(
    pgliteSchemaDdl([
      s.tools!,
      s.skills!,
      s.vaultGrants!,
      s.links!,
      s.secrets!,
      s.capabilities!,
      s.intelligenceCommands!,
      s.workspaces!,
      s.workspaceMembers!,
      s.podMembers!,
      s.users!,
      s.projectMembers!,
      s.governanceRules!,
    ])
  );
  await q(`insert into users (id, email) values ($1,'u@x'),($2,'s@x')`, [
    U,
    STRANGER,
  ]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'A',$4,'{}'::jsonb),($2,'B',$5,'{}'::jsonb),($3,'C',$4,'{}'::jsonb)`,
    [WS_A, WS_B, WS_C, STRANGER, U]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'editor')`,
    [WS_A, U]
  );
  await q(`insert into capabilities (id, name) values ($1,'Pack')`, [PACK]);
});

describe("enable is approval, never grant — display agrees with the run gate", () => {
  it("every integration's `enable` block matches the gate + projection verdict", async () => {
    // Google-shaped: approved tool, approved backing skills, NO tool grant.
    const google = await tool("google", {
      approved: true,
      kind: "provider",
      verbs: ["gmail_search", "calendar_list"],
    });
    await skill("gmail_search", true);
    await skill("calendar_list", true);
    // Connected, so `connect` is not what blocks it.
    const secretId = randomUUID();
    await q(
      `insert into secrets (id, user_id, name, capability_id, account_hint) values ($1,$2,'g',$3,'me@x')`,
      [secretId, U, PACK]
    );
    // A pack whose backing skill is OFF — must read `enable`.
    await tool("acme", { approved: true, verbs: ["acme_do"] });
    await skill("acme_do", false);
    // Tool row itself off, skill on — the projection refuses it; so must the block.
    await tool("zeta", { approved: false, verbs: ["zeta_do"] });
    await skill("zeta_do", true);
    // A GRANTED tool whose skill is off: a grant must not mask the refusal.
    const granted = await tool("granted_off", {
      approved: true,
      verbs: ["granted_do"],
    });
    await skill("granted_do", false);
    await q(
      `insert into vault_grants (grantable_type, grantable_id, exec_mode) values ('tool',$1,'auto')`,
      [granted]
    );

    const caps = await listCapabilities(
      { workspaceId: null, userId: U },
      { limit: null }
    );
    const sections = sectionCapabilities(caps);
    const runnableTools = new Set(
      projectRunnableActions(caps).map((a) => a.tool)
    );
    const byName = new Map(sections.integrations.map((r) => [r.name, r]));

    // The fact the old predicate ignored is still reported, where it belongs:
    // no grant ⇒ an agent run PROPOSES. It is not an enable block.
    const g = byName.get("google")!;
    expect(g.verbs.every((v) => v.granted === false)).toBe(true);
    expect(g.governance).toBe("propose");
    expect(g.blocked).toBeUndefined();
    expect(g.id).toBe(google);

    expect(byName.get("acme")!.blocked?.kind).toBe("enable");
    expect(byName.get("zeta")!.blocked?.kind).toBe("enable");
    expect(byName.get("granted_off")!.blocked?.kind).toBe("enable");

    // Non-vacuity: all four rows present, both answers represented.
    expect([...byName.keys()].sort()).toEqual(
      ["acme", "google", "granted_off", "zeta"].sort()
    );

    // AGREEMENT, row by row, with two independent judges of "can it run".
    for (const row of sections.integrations) {
      const saysEnable = row.blocked?.kind === "enable";
      expect(saysEnable, `${row.name}: projection`).toBe(
        !runnableTools.has(row.name)
      );
      // The run door's gate on the backing skill, as the human owner (no
      // agent ⇒ no grant consulted, exactly as execute-capability calls it).
      const [sk] = (
        await q(
          `select id, approved, user_id, name from skills where name = $1`,
          [row.verbs[0]!.id]
        )
      ).rows;
      const verdict = await gateCapabilityExecution({
        capabilityKind: "skill",
        capabilityId: sk!.id,
        skill: {
          id: sk!.id,
          approved: sk!.approved,
          userId: sk!.user_id,
          name: sk!.name,
        },
        actorUserId: U,
        workspaceId: null,
      });
      // `zeta` passes the SKILL gate but its tool row is off, which the
      // write-path tool gate refuses — so only the skill-gated rows are
      // compared to the skill verdict here; zeta is covered by the projection.
      if (row.name !== "zeta") {
        expect(saysEnable, `${row.name}: gate`).toBe(
          verdict.decision === "deny"
        );
      }
    }
  });

  it("an AGENT run of an approved, ungranted verb is PROPOSED, not refused — a grant is posture", async () => {
    const [sk] = (
      await q(
        `select id, approved, user_id, name from skills where name = 'gmail_search'`
      )
    ).rows;
    const verdict = await gateCapabilityExecution({
      capabilityKind: "skill",
      capabilityId: sk!.id,
      skill: {
        id: sk!.id,
        approved: sk!.approved,
        userId: sk!.user_id,
        name: sk!.name,
      },
      actorUserId: U,
      agentUserId: randomUUID(),
      workspaceId: null,
    });
    expect(verdict.decision).toBe("propose");
  });
});

describe("allSpaces — one read, every visible space, deduped and tagged", () => {
  it("returns pod-wide once + each visible space's row tagged, never an invisible space", async () => {
    // Pod-wide, installed TWICE (the duplicate-install shape): one row.
    await tool("slack", { approved: true });
    await tool("slack", { approved: true });
    // Same name, pod-wide + two visible spaces: three rows, one per space.
    await tool("notion", { approved: true });
    await tool("notion", { approved: true, workspaceId: WS_A });
    await tool("notion", { approved: true, workspaceId: WS_B });
    // A space U cannot see.
    await tool("hidden_tool", { approved: true, workspaceId: WS_C });
    // A space-scoped standalone skill in A, and one in C.
    await skill("space_a_skill", true, "workspace", WS_A);
    await skill("space_c_skill", true, "workspace", WS_C);
    const cmd = randomUUID();
    await q(
      `insert into intelligence_commands (id, title, workspace_id) values ($1,'Brief A',$2)`,
      [cmd, WS_A]
    );

    const caps = await listCapabilities(
      { workspaceId: null, userId: U, allSpaces: true },
      { limit: null }
    );
    const out = sectionCapabilities(caps, { bySpace: true });

    const slack = out.integrations.filter((r) => r.name === "slack");
    expect(slack).toHaveLength(1);
    expect(slack[0]!.workspaceId).toBeNull();

    const notion = out.integrations
      .filter((r) => r.name === "notion")
      .map((r) => r.workspaceId)
      .sort();
    expect(notion).toEqual([null, WS_A, WS_B].sort());

    expect(out.integrations.some((r) => r.name === "hidden_tool")).toBe(false);
    expect(
      out.skills.find((s) => s.name === "space_a_skill")?.workspaceId
    ).toBe(WS_A);
    expect(out.skills.some((s) => s.name === "space_c_skill")).toBe(false);
    expect(out.commands.find((c) => c.id === cmd)?.workspaceId).toBe(WS_A);

    // Every row carries the tag (null or a visible space) — none untagged.
    for (const r of [...out.integrations, ...out.skills, ...out.commands]) {
      expect(r).toHaveProperty("workspaceId");
      expect([null, WS_A, WS_B]).toContain(r.workspaceId);
    }
  });

  it("the lensed read is unchanged: space A folds by name and carries no tag", async () => {
    const caps = await listCapabilities(
      { workspaceId: WS_A, userId: U },
      { limit: null }
    );
    const out = sectionCapabilities(caps);
    const notion = out.integrations.filter((r) => r.name === "notion");
    expect(notion).toHaveLength(1);
    expect(notion[0]).not.toHaveProperty("workspaceId");
    // B's copy is outside lens A.
    expect(caps.some((c) => c.name === "notion" && c.workspaceId)).toBe(false);
  });
});
