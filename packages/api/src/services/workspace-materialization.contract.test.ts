/**
 * Contract tests — "green must mean works" net for the shared workspace
 * install core.
 * ============================================================================
 *
 * Drives the REAL entry points BOTH install doors converge on:
 *   1. `materializeWorkspaceCore` (Hub `POST /api/hub/packages/apply` +
 *      tRPC `workspaces.createFromDefinition` share this ONE resolve/create/
 *      compose step — see workspace-materialization-service.ts's own header).
 *   2. `applyPackagePostWorkspace` (the ONE post-workspace door — capabilities/
 *      automations/playbooks/loops — both doors' "phase 2").
 *
 * In-process, REAL Postgres, NO live Control Plane: a capability template is
 * seeded directly into the pod-local `capability_template_cache` table (the
 * SAME table `loadCapabilityTemplate` → `fetchCPCapabilityTemplate` reads
 * cache-first — see cp-template-client.ts), so resolution is fully
 * deterministic offline. The fixture mirrors the REAL "the-arch" grant
 * capability (`stellar-grant-client`: 4 automations / 1 skill / 1 playbook /
 * 0 tools) that shipped with its automations/playbooks silently dropped this
 * session — this is the exact bug class these tests are a net for.
 *
 * Requires a live Postgres (see packages/api/vitest.config.ts DATABASE_URL;
 * prefer `synap_test`). Run: `DATABASE_URL=postgresql://postgres:synap_dev_password@localhost:5432/synap_test pnpm --filter @synap/api test workspace-materialization.contract`
 *
 * ── ANTI-SKIP GUARDRAIL ─────────────────────────────────────────────────────
 * `describe.skipIf` renders identically to a pass in most CI summaries — a
 * silently-false `SCHEMA_LOADS` (or a beforeAll that no-ops) would make this
 * whole net vanish without a single red line. Two independent defenses:
 *   1. `SCHEMA_LOADS_SANITY` below is a plain (never-skipped) `it` — if the
 *      schema import gate ever flips false, THIS fails loudly instead of the
 *      whole suite quietly disappearing.
 *   2. Every contract test asserts a SENTINEL (the seeded cache row is
 *      actually readable back, count === 1) BEFORE its real assertions — a
 *      test body that never ran can't satisfy either.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { sql } from "@synap/database";
import { capabilityTemplateCache } from "@synap/database/schema";
import { materializeWorkspaceCore } from "./workspace-materialization-service.js";
import { applyPackagePostWorkspace } from "./package-apply-post-workspace.js";
import { createWorkspaceFromDefinition } from "@synap/database";
import type { WorkspaceDefinitionInput } from "@synap/database";

// Same circular-import defense as
// `packages/database/src/__tests__/reconcile-workspace-from-definition.test.ts`:
// guard on a real schema export actually being bound, so a broken SSR
// transform skips cleanly instead of throwing "table X is undefined" deep
// inside a repository. See SCHEMA_LOADS_SANITY below for why a false here is
// never silent.
const SCHEMA_LOADS = !!capabilityTemplateCache;

const suf = randomUUID().slice(0, 8);
const userId = `test-matcore-${suf}`;

/** A CapabilityDefinition fixture shaped exactly like the real
 * `stellar-grant-client` template that shipped with 4 automations / 1 skill /
 * 1 playbook silently dropped — the bug this net exists for. */
function grantCapabilityFixture(key: string, tag: string) {
  return {
    key,
    name: `Contract Grant Capability ${tag}`,
    description: "contract-test fixture mirroring stellar-grant-client",
    params: [],
    vault: [],
    tools: [],
    skills: [
      {
        name: `grant-advisor-skill-${tag}`,
        kind: "instruction",
        scope: "pod",
        description: "Advisor skill fixture",
        code: "When asked about a grant, advise on scope/abstract/build stages.",
      },
    ],
    automations: [
      {
        name: `grant-automation-1-${tag}`,
        triggerType: "cron",
        triggerConfig: { expression: "0 9 * * *" },
        flowDefinition: { nodes: [], edges: [] },
      },
      {
        name: `grant-automation-2-${tag}`,
        triggerType: "cron",
        triggerConfig: { expression: "0 10 * * *" },
        flowDefinition: { nodes: [], edges: [] },
      },
      {
        name: `grant-automation-3-${tag}`,
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: { nodes: [], edges: [] },
      },
      {
        name: `grant-automation-4-${tag}`,
        triggerType: "event",
        triggerConfig: { eventPattern: "entity.create.*" },
        flowDefinition: { nodes: [], edges: [] },
      },
    ],
    playbooks: [
      {
        name: `grant-playbook-${tag}`,
        description: "Grant client playbook fixture",
        goalTemplate: `Advance the grant client through the pipeline (${tag}).`,
        executor: "is-agent",
        status: "draft",
      },
    ],
  };
}

/** Insert (or refresh) a capability_template_cache row — the ONE fixture door
 * these tests need; mirrors `upsertCapabilityTemplateCache`. Uses
 * JSON.stringify + ::jsonb (NOT postgres.js sql.json()) — sql.json() crashes
 * on this driver version (known repo gotcha). */
async function seedCapabilityTemplate(
  key: string,
  def: ReturnType<typeof grantCapabilityFixture>
): Promise<void> {
  const defJson = JSON.stringify(def);
  await sql`
    INSERT INTO capability_template_cache (key, name, description, definition, synced_at)
    VALUES (${key}, ${def.name}, ${def.description}, ${defJson}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      definition = excluded.definition,
      synced_at = now()
  `;
}

async function insertTestUser(id: string): Promise<void> {
  await sql`
    INSERT INTO users (id, email, name)
    VALUES (${id}, ${`${id}@test.local`}, 'Contract Test')
    ON CONFLICT (id) DO NOTHING
  `;
}

function minimalDefinition(tag: string): WorkspaceDefinitionInput {
  return {
    workspaceName: `Contract WS ${tag}`,
    profiles: [
      {
        slug: `cwsprofile-${tag}`,
        displayName: "Item",
        properties: [{ slug: "status", label: "Status", valueType: "text" }],
      },
    ],
  };
}

async function countAutomations(
  workspaceId: string,
  namePrefix: string
): Promise<number> {
  const rows = await sql`
    SELECT id, name FROM automations
    WHERE workspace_id = ${workspaceId} AND name LIKE ${namePrefix + "%"}
  `;
  return rows.length;
}

async function countSkills(name: string): Promise<number> {
  const rows = await sql`
    SELECT id FROM skills WHERE name = ${name}
  `;
  return rows.length;
}

async function countPlaybooks(
  workspaceId: string,
  name: string
): Promise<number> {
  const rows = await sql`
    SELECT id FROM playbooks WHERE workspace_id = ${workspaceId} AND name = ${name}
  `;
  return rows.length;
}

async function cleanupWorkspace(workspaceId: string | undefined) {
  if (!workspaceId) return;
  await sql`DELETE FROM playbooks WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM automations WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM capabilities WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM property_defs WHERE profile_id IN (SELECT id FROM profiles WHERE workspace_id = ${workspaceId})`;
  await sql`DELETE FROM profiles WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM views WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
}

/** The grant capability's container is POD-SCOPED (workspace_id NULL — see
 * `isPodScoped` in create-from-definition.ts, driven by the fixture's
 * `scope: "pod"` skill), so it is NOT covered by `cleanupWorkspace`'s
 * workspace-scoped deletes. Cleaned separately, keyed by its unique name. */
async function cleanupPodCapabilityContainer(name: string) {
  await sql`DELETE FROM capabilities WHERE workspace_id IS NULL AND name = ${name}`;
}

// ── Anti-skip sanity — NEVER gated by skipIf. If this fails, the schema
// import gate flipped false and the whole contract suite below silently
// skipped — a red failure here, not a quiet green no-op. ─────────────────────
describe("SCHEMA_LOADS sanity (never skipped)", () => {
  it("the schema module resolved a real table binding", () => {
    expect(SCHEMA_LOADS).toBe(true);
  });
});

describe.skipIf(!SCHEMA_LOADS)(
  "materializeWorkspaceCore + applyPackagePostWorkspace — contract tests",
  () => {
    beforeAll(async () => {
      await insertTestUser(userId);
    });

    afterAll(async () => {
      await sql`DELETE FROM users WHERE id = ${userId}`;
    });

    // ── A. exact capability materialization (the shipped bug) ───────────────
    it("A: install a grant capability → materializes exactly 4 automations / 1 skill / 1 playbook", async () => {
      const tag = `a-${suf}`;
      const capKey = `contract-grant-${tag}`;
      const def = grantCapabilityFixture(capKey, tag);
      let workspaceId: string | undefined;

      try {
        await seedCapabilityTemplate(capKey, def);

        // SENTINEL — prove the fixture seed actually executed (anti-skip
        // guardrail #2): if this were 0, the test body did not really run
        // the setup and every assertion below would be vacuous.
        const [seeded] = await sql`
          SELECT count(*)::int AS count FROM capability_template_cache WHERE key = ${capKey}
        `;
        expect(seeded.count).toBe(1);

        const created = await materializeWorkspaceCore({
          definition: minimalDefinition(tag),
          userId,
          deferCreate: false,
          workspaceName: `Contract WS ${tag}`,
          createdBy: "provisioning",
        });
        expect(created.status).toBe("created");
        if (created.status !== "created") throw new Error("unreachable");
        workspaceId = created.workspaceId;

        await applyPackagePostWorkspace({
          workspaceId,
          userId,
          body: { capabilities: [{ templateKey: capKey }] },
        });

        // ── The exact bug: automations/playbooks silently dropped. ─────────
        const automationCount = await countAutomations(
          workspaceId,
          `grant-automation-`
        );
        expect(automationCount).toBe(4);

        const skillCount = await countSkills(`grant-advisor-skill-${tag}`);
        expect(skillCount).toBe(1);

        const playbookCount = await countPlaybooks(
          workspaceId,
          `grant-playbook-${tag}`
        );
        expect(playbookCount).toBe(1);
      } finally {
        await cleanupWorkspace(workspaceId);
        await cleanupPodCapabilityContainer(def.name);
        await sql`DELETE FROM skills WHERE name = ${`grant-advisor-skill-${tag}`}`;
        await sql`DELETE FROM capability_template_cache WHERE key = ${capKey}`;
      }
    });

    // ── B. two-door parity (Hub non-deferred vs tRPC deferCreate:true) ──────
    it("B: Hub's non-deferred create and tRPC's deferCreate:true produce IDENTICAL capability sets", async () => {
      const tag = `b-${suf}`;
      const capKey = `contract-grant-${tag}`;
      const def = grantCapabilityFixture(capKey, tag);
      let hubWorkspaceId: string | undefined;
      let trpcWorkspaceId: string | undefined;

      try {
        await seedCapabilityTemplate(capKey, def);

        // SENTINEL — same anti-skip proof as test A.
        const [seeded] = await sql`
          SELECT count(*)::int AS count FROM capability_template_cache WHERE key = ${capKey}
        `;
        expect(seeded.count).toBe(1);

        // ── Door 1: Hub's call-shape — materializeWorkspaceCore creates directly. ──
        const hubResult = await materializeWorkspaceCore({
          definition: minimalDefinition(`${tag}-hub`),
          userId,
          deferCreate: false,
          workspaceName: `Contract WS ${tag}-hub`,
          createdBy: "provisioning",
        });
        expect(hubResult.status).toBe("created");
        if (hubResult.status !== "created") throw new Error("unreachable");
        hubWorkspaceId = hubResult.workspaceId;

        // ── Door 2: tRPC's call-shape — materializeWorkspaceCore defers, the
        // caller performs its own (richer) create afterwards. ──────────────
        const trpcResolve = await materializeWorkspaceCore({
          definition: minimalDefinition(`${tag}-trpc`),
          userId,
          deferCreate: true,
        });
        expect(trpcResolve.status).toBe("resolved");
        const trpcCreated = await createWorkspaceFromDefinition({
          definition: minimalDefinition(`${tag}-trpc`),
          userId,
          createdBy: "user",
        });
        trpcWorkspaceId = trpcCreated.workspaceId;

        // Same capability body applied on both doors' resulting workspace.
        await applyPackagePostWorkspace({
          workspaceId: hubWorkspaceId,
          userId,
          body: { capabilities: [{ templateKey: capKey }] },
        });
        await applyPackagePostWorkspace({
          workspaceId: trpcWorkspaceId,
          userId,
          body: { capabilities: [{ templateKey: capKey }] },
        });

        const hubAutomationRows = await sql`
          SELECT name FROM automations WHERE workspace_id = ${hubWorkspaceId} AND name LIKE ${"grant-automation-%"} ORDER BY name
        `;
        const trpcAutomationRows = await sql`
          SELECT name FROM automations WHERE workspace_id = ${trpcWorkspaceId} AND name LIKE ${"grant-automation-%"} ORDER BY name
        `;
        expect(hubAutomationRows.length).toBe(4);
        expect(trpcAutomationRows.length).toBe(4);
        expect(hubAutomationRows.map((r) => r.name)).toEqual(
          trpcAutomationRows.map((r) => r.name)
        );

        const hubPlaybookCount = await countPlaybooks(
          hubWorkspaceId,
          `grant-playbook-${tag}`
        );
        const trpcPlaybookCount = await countPlaybooks(
          trpcWorkspaceId,
          `grant-playbook-${tag}`
        );
        expect(hubPlaybookCount).toBe(1);
        expect(trpcPlaybookCount).toBe(1);

        // The skill is pod-scoped (workspace_id NULL) — created once, REUSED
        // (idempotent, by name) on the second door's apply, never duplicated.
        const skillCount = await countSkills(`grant-advisor-skill-${tag}`);
        expect(skillCount).toBe(1);
      } finally {
        await cleanupWorkspace(hubWorkspaceId);
        await cleanupWorkspace(trpcWorkspaceId);
        await cleanupPodCapabilityContainer(def.name);
        await sql`DELETE FROM skills WHERE name = ${`grant-advisor-skill-${tag}`}`;
        await sql`DELETE FROM capability_template_cache WHERE key = ${capKey}`;
      }
    });

    // ── C. reconcile applies drift, then is a no-op when already current ────
    it("C: re-applying a capability heals a STALE (drifted) workspace, then no-ops when current", async () => {
      const tag = `c-${suf}`;
      const capKey = `contract-grant-${tag}`;
      const def = grantCapabilityFixture(capKey, tag);
      let workspaceId: string | undefined;

      try {
        await seedCapabilityTemplate(capKey, def);

        // SENTINEL — same anti-skip proof as tests A/B.
        const [seeded] = await sql`
          SELECT count(*)::int AS count FROM capability_template_cache WHERE key = ${capKey}
        `;
        expect(seeded.count).toBe(1);

        const created = await materializeWorkspaceCore({
          definition: minimalDefinition(tag),
          userId,
          deferCreate: false,
          workspaceName: `Contract WS ${tag}`,
          createdBy: "provisioning",
        });
        expect(created.status).toBe("created");
        if (created.status !== "created") throw new Error("unreachable");
        workspaceId = created.workspaceId;

        // Initial install — the full 4/1/1 set.
        await applyPackagePostWorkspace({
          workspaceId,
          userId,
          body: { capabilities: [{ templateKey: capKey }] },
        });
        expect(await countAutomations(workspaceId, "grant-automation-")).toBe(
          4
        );

        // Simulate a STALE workspace: one automation is missing (drift —
        // e.g. it was manually deleted, or an earlier partial install).
        await sql`
          DELETE FROM automations
          WHERE workspace_id = ${workspaceId} AND name = ${`grant-automation-2-${tag}`}
        `;
        expect(await countAutomations(workspaceId, "grant-automation-")).toBe(
          3
        );

        // Re-install (reconcile) — the drift is HEALED: the missing
        // automation is re-added, existing ones are reused (not duplicated).
        await applyPackagePostWorkspace({
          workspaceId,
          userId,
          body: { capabilities: [{ templateKey: capKey }] },
        });
        expect(await countAutomations(workspaceId, "grant-automation-")).toBe(
          4
        );

        // Re-install AGAIN on an already-current workspace — a pure no-op,
        // no duplicates.
        await applyPackagePostWorkspace({
          workspaceId,
          userId,
          body: { capabilities: [{ templateKey: capKey }] },
        });
        expect(await countAutomations(workspaceId, "grant-automation-")).toBe(
          4
        );
        expect(await countPlaybooks(workspaceId, `grant-playbook-${tag}`)).toBe(
          1
        );
        expect(await countSkills(`grant-advisor-skill-${tag}`)).toBe(1);
      } finally {
        await cleanupWorkspace(workspaceId);
        await cleanupPodCapabilityContainer(def.name);
        await sql`DELETE FROM skills WHERE name = ${`grant-advisor-skill-${tag}`}`;
        await sql`DELETE FROM capability_template_cache WHERE key = ${capKey}`;
      }
    });
  }
);
