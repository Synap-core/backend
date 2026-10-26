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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

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

// ── D1: every agent mint names its computer ───────────────────────────────
// 12b90604: `/setup/agent` was called WITH a computer's key and never said
// so, minting agents their computer could not clip or revoke. The scanned
// set is DERIVED: every non-test source file under api/src, database/src and
// jobs/src that calls `provisionSurfaceAgentKey(` — a new door joins by
// existing. Each call's argument object must name `hostUserId` (null
// included: "no computer" is a decision, not an omission).
const PACKAGES = join(here, "../../..");
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (
      p.endsWith(".ts") &&
      !p.endsWith(".test.ts") &&
      !p.includes("__tests__") &&
      !p.includes("__tripwires__")
    )
      out.push(p);
  }
  return out;
}
/** The text of the call's argument list, balanced on parentheses. */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

describe("every provisionSurfaceAgentKey call names its computer (D1 tripwire)", () => {
  const sites = ["api/src", "database/src", "jobs/src"]
    .flatMap((r) => sourceFiles(join(PACKAGES, r)))
    .flatMap((file) => {
      const src = readFileSync(file, "utf8");
      return [...src.matchAll(/(?<!function )\bprovisionSurfaceAgentKey\(/g)]
        .filter((m) => {
          // A mention inside a comment is not a call.
          const line = src.slice(src.lastIndexOf("\n", m.index!) + 1, m.index);
          return !/^\s*(\*|\/\/)/.test(line);
        })
        .map((m) => ({
          file: relative(PACKAGES, file),
          args: callArgs(src, m.index! + m[0].length - 1),
        }));
    });

  it("finds the doors (the scan is live)", () => {
    const files = sites.map((s) => s.file);
    expect(files.length).toBeGreaterThanOrEqual(4);
    // Reachability: the door this wave fixed, and the device door.
    expect(files).toContain("api/src/routers/hub-protocol/rest/setup.ts");
    expect(files).toContain("api/src/services/machine-connect.ts");
  });

  it.each(sites.map((s) => [s.file, s.args] as const))(
    "%s passes hostUserId",
    (_file, args) => {
      expect(args).toMatch(/\bhostUserId\s*:/);
    }
  );

  it("/setup/agent takes the computer from the CALLING key, never the body", () => {
    const src = readFileSync(
      join(here, "../routers/hub-protocol/rest/setup.ts"),
      "utf8"
    );
    expect(src).toMatch(/surfaceHostUserId = identity\.principal\.hostUserId;/);
    expect(src).not.toMatch(/body\.hostUserId/);
  });
});
