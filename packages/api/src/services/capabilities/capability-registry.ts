/**
 * Capability Registry Adapter — the unified READ-MODEL over the existing
 * capability source systems.
 *
 * Phase 1 of the Playbooks & Capability Substrate normalizes four disjoint
 * systems behind one `Capability` contract so a Playbook can grant capabilities
 * uniformly and the AI can discover them. THIS slice is the read-only adapter:
 * it reads existing rows and maps them into the `Capability` shape. It performs
 * NO writes and NO governance (callers gate; reads are auto-approved).
 *
 * Sources mapped today:
 *   - `tools` rows                 → kind by tool.kind (builtin-tool | tool | source-provider)
 *   - `skills` rows                → kind "skill"
 *   - `intelligence_commands` rows → kind "command"
 *
 * NOT yet mapped (TODO): the hardcoded builtin IS tools live in the Intelligence
 * Service, not the backend DB — exposing them requires an IS-side manifest
 * endpoint. Until that lands we return [] for them rather than hardcoding a fake
 * list that would drift from the real IS tool set.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx (§4.1)
 */

import { getDb, or, isNull, eq } from "@synap/database";
import { tools, skills, intelligenceCommands } from "@synap/database/schema";
import type { Capability, CapabilityKind, ExecutorRef } from "@synap/playbooks";

export interface CapabilityRegistryContext {
  workspaceId: string;
  userId: string;
}

/** Map a `tools.kind` value to the read-model CapabilityKind. */
function toolKindToCapabilityKind(kind: string): CapabilityKind {
  switch (kind) {
    case "builtin":
      return "builtin-tool";
    case "provider":
      return "source-provider";
    // "api" | "mcp" | "external" are all granted as a plain "tool"
    default:
      return "tool";
  }
}

/** Coerce a loosely-typed jsonb input schema into the contract shape. */
function asInputSchema(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Derive the read-model `governance` from a capability row's persisted
 * `approved` state instead of a hardcoded literal (C-DEAD-3). This is a
 * DISCOVERY read-model, NOT enforcement (the real gate is `decideAgentPolicy`
 * rung 2.6 + `gate-capability-execution.ts`), so it is intentionally minimal:
 *   - UNAPPROVED (born `false`) → "propose" — never auto-runnable, needs review;
 *   - APPROVED                  → "auto"    — operator-approved capability.
 * The point is to STOP hardcoding `"propose"`: the value now reflects the row.
 * The grant's per-grant exec-mode still narrows this at the gate (an approved
 * capability granted "propose-each" is proposed per run regardless).
 */
function deriveGovernance(
  approved: boolean | null | undefined
): "auto" | "propose" {
  return approved ? "auto" : "propose";
}

/**
 * List every capability visible to the caller in this workspace, normalized into
 * the `Capability` read-model. Read-only — no writes, no governance.
 *
 * Visibility: pod-wide (workspaceId IS NULL) OR rows belonging to this workspace.
 * (Reads are auto-approved by governance-policy "*.read" entries.)
 */
export async function listCapabilities(
  ctx: CapabilityRegistryContext
): Promise<Capability[]> {
  const db = await getDb();

  // ── Tools ──────────────────────────────────────────────────────────────────
  const toolRows = await db
    .select()
    .from(tools)
    .where(
      or(isNull(tools.workspaceId), eq(tools.workspaceId, ctx.workspaceId))
    );

  const toolCaps: Capability[] = toolRows.map((row) => ({
    kind: toolKindToCapabilityKind(row.kind),
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    inputSchema: asInputSchema(row.inputSchema),
    executor: row.executor as ExecutorRef,
    governance: deriveGovernance(row.approved),
  }));

  // ── Skills (instruction | code) ─────────────────────────────────────────────
  // Visible = pod-wide (NULL) OR this workspace OR owned by the caller (user scope).
  const skillRows = await db
    .select()
    .from(skills)
    .where(
      or(
        isNull(skills.workspaceId),
        eq(skills.workspaceId, ctx.workspaceId),
        eq(skills.userId, ctx.userId)
      )
    );

  const skillCaps: Capability[] = skillRows.map((row) => ({
    kind: "skill",
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    inputSchema: asInputSchema(row.parameters),
    executor: "is-agent",
    governance: deriveGovernance(row.approved),
  }));

  // ── Commands (intelligence_commands) ────────────────────────────────────────
  const commandRows = await db
    .select()
    .from(intelligenceCommands)
    .where(
      or(
        isNull(intelligenceCommands.workspaceId),
        eq(intelligenceCommands.workspaceId, ctx.workspaceId)
      )
    );

  const commandCaps: Capability[] = commandRows.map((row) => ({
    kind: "command",
    id: row.id,
    name: row.title,
    description: null,
    // Commands declare inputs as DerivedInput[] — surfaced as the raw array under
    // a `derivedInputs` key (the contract's inputSchema is an open record).
    inputSchema: { derivedInputs: row.derivedInputs ?? [] },
    executor: "is-agent",
    // intelligence_commands has no `approved` column → always the conservative
    // needs-review default (no row state to derive from yet).
    governance: deriveGovernance(undefined),
  }));

  // TODO(phase-1): builtin IS tools — requires an IS manifest endpoint; returns
  // nothing today rather than hardcoding a list that would drift from IS.
  const builtinCaps: Capability[] = [];

  return [...builtinCaps, ...toolCaps, ...skillCaps, ...commandCaps];
}
