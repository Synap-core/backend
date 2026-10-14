/**
 * Tripwire: surface agents are singleton per (createdByUserId, agentType).
 *
 * Locks the product rule that two humans on one pod each get their own
 * claude-code (etc.) principal — scorecards, caps, and audit must not collapse
 * onto a pod-wide agentType row.
 *
 * Also locks: hub_inbound surface keys MUST carry a non-null linkedUserId
 * (governance remap). Null linkedUserId = silent direct-as-operator writes.
 *
 * Pure structural test: static-reads the service source for required shapes
 * and error codes (NO_HUMAN_OWNER / NO_LINKED_HUMAN).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const servicePath = join(here, "../services/agent-identity-service.ts");
const migrationPath = join(
  here,
  "../../../database/migrations/0228_agent_creator_type_unique.sql"
);
const captureAgentPath = join(
  here,
  "../services/capture-agent/ensure-capture-agent.ts"
);

describe("agent creator×type singleton (tripwire)", () => {
  it("findOrCreateServiceAgentUser looks up by createdByUserId + agentType", () => {
    const src = readFileSync(servicePath, "utf8");
    expect(src).toMatch(/eq\(users\.createdByUserId,\s*creatorId\)/);
    expect(src).toMatch(/eq\(users\.agentType,\s*agentType\)/);
    expect(src).toMatch(/singleton per \*\*\(createdByUserId, agentType\)\*\*/);
    // Shared helper used by BOTH createNamedAgent and provisionSurfaceAgentKey
    expect(src).toMatch(/export async function findOrCreateServiceAgentUser/);
    expect(src).toMatch(/lost provision race/);
    // Old pod-wide comment must not remain as the active contract
    expect(src).not.toMatch(/pod-wide singleton per `agentType`/);
  });

  it("requires createdByUserId (fail closed)", () => {
    const src = readFileSync(servicePath, "utf8");
    expect(src).toMatch(/createdByUserId is required/);
    expect(src).toMatch(/NO_HUMAN_OWNER/);
  });

  it("requires linkedUserId on surface mint (never null hub_inbound)", () => {
    const src = readFileSync(servicePath, "utf8");
    // Fail-closed code when linked human cannot be resolved
    expect(src).toMatch(/NO_LINKED_HUMAN/);
    // Defaults omitted linked → creator; mints resolvedLinkedUserId, not null
    expect(src).toMatch(/resolvedLinkedUserId/);
    expect(src).toMatch(/linkedUserId:\s*resolvedLinkedUserId/);
    // Guard against the old coerce-to-null mint path
    expect(src).not.toMatch(/linkedUserId:\s*linkedUserId\s*\?\?\s*null/);
  });

  it("createNamedAgent shares race recovery + writesRequireProposal default", () => {
    const src = readFileSync(servicePath, "utf8");
    // Both doors call the shared find-or-create (race recovery lives there once)
    const createIdx = src.indexOf("export async function createNamedAgent");
    const provisionIdx = src.indexOf(
      "export async function provisionSurfaceAgentKey"
    );
    expect(createIdx).toBeGreaterThan(-1);
    expect(provisionIdx).toBeGreaterThan(-1);
    const createBody = src.slice(createIdx, provisionIdx);
    expect(createBody).toMatch(/findOrCreateServiceAgentUser/);
    // Non-twin service agents stamp writesRequireProposal: true
    expect(src).toMatch(/writesRequireProposal:\s*true/);
  });

  it("migration 0228 replaces type-only unique with creator×type", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(
      /DROP INDEX IF EXISTS idx_users_service_agent_type_unique/
    );
    expect(sql).toMatch(/idx_users_service_agent_creator_type_unique/);
    expect(sql).toMatch(/created_by_user_id,\s*agent_type/);
  });

  // ── Remaining find doors (must not stay agentType-only) ─────────────────
  // (The bundled-agent doors — provisionService, findProvisionedAgent, the
  // provision-agent script, the CP add-on activate — were removed 2026-10-14.)

  it("getCaptureAgentUserId resolves via owner creator×type", () => {
    const src = readFileSync(captureAgentPath, "utf8");
    expect(src).toMatch(/resolvePodOwnerUserId/);
    expect(src).toMatch(/findCaptureAgent\(ownerUserId\)/);
  });
});
