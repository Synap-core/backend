/**
 * Capability SHADOWS — stale copies that silently answer for a pack's verbs.
 *
 * A capability pack (`capabilities` container) owns its tools and skills
 * through `member_of` edges. A re-install, a pre-consolidation generation or a
 * swallowed attach can leave a skill or tool row with the SAME NAME as a pack
 * member but in NO pack. Nothing manages it any more — uninstall and the
 * template reconciler both reach a pack's parts only through `member_of` — yet
 * it is still live: verb resolution is by name, and an old approved code skill
 * named `calendar_list` beat the pack's declarative one and broke every Google
 * sync on a real pod (2026-09-24).
 *
 * This module is the ONE definition of "shadow", used by both the diagnose
 * surface (find) and the retire door (remove), so the list a person reviews and
 * the set a removal is allowed to touch can never disagree.
 *
 *   shadow = an ACTIVE skill (or a tool) that is `member_of` NO container and
 *            whose name equals the name of a same-type part that IS a member.
 *
 * A tool outside every pack carries no connection by construction: connections
 * (`secrets`) hang off the CONTAINER (`secrets.capability_id`), so removing a
 * shadow tool can never orphan a live connection.
 */

import {
  db,
  and,
  eq,
  inArray,
  or,
  capabilities,
  skills,
  tools,
  links,
  vaultGrants,
  isNull,
} from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { visibleSkillsWhere } from "../skills/visibility.js";

export interface ShadowPart {
  id: string;
  name: string;
  workspaceId: string | null;
}

export interface CapabilityShadow {
  type: "skill" | "tool";
  id: string;
  name: string;
  workspaceId: string | null;
  /** Skill only: `code` / `declarative` / … */
  skillKind?: string;
  /** Skill only: an approved shadow is the dangerous kind — it can WIN. */
  approved?: boolean;
  /** The pack member(s) it shadows — what should answer instead. */
  shadows: Array<{ id: string; containerId: string; containerName: string }>;
}

export interface ShadowInputs {
  /** `member_of` edges: part → container. */
  members: Array<{ fromType: string; fromId: string; toId: string }>;
  containers: Array<{ id: string; name: string }>;
  skills: Array<ShadowPart & { kind: string; approved: boolean }>;
  tools: ShadowPart[];
}

/** Pure: which of these parts shadow a pack member. */
export function classifyShadows(input: ShadowInputs): CapabilityShadow[] {
  const containerName = new Map(input.containers.map((c) => [c.id, c.name]));
  const memberOf = new Map<string, string[]>();
  for (const m of input.members) {
    const list = memberOf.get(m.fromId) ?? [];
    list.push(m.toId);
    memberOf.set(m.fromId, list);
  }

  const out: CapabilityShadow[] = [];
  const scan = (
    type: "skill" | "tool",
    parts: Array<ShadowPart & { kind?: string; approved?: boolean }>
  ) => {
    // name → the pack members carrying it
    const canonical = new Map<string, CapabilityShadow["shadows"]>();
    for (const p of parts) {
      for (const containerId of memberOf.get(p.id) ?? []) {
        const list = canonical.get(p.name) ?? [];
        list.push({
          id: p.id,
          containerId,
          containerName: containerName.get(containerId) ?? containerId,
        });
        canonical.set(p.name, list);
      }
    }
    for (const p of parts) {
      if (memberOf.has(p.id)) continue;
      const shadows = canonical.get(p.name);
      if (!shadows) continue;
      out.push({
        type,
        id: p.id,
        name: p.name,
        workspaceId: p.workspaceId,
        ...(type === "skill"
          ? { skillKind: p.kind, approved: p.approved }
          : {}),
        shadows,
      });
    }
  };
  scan("skill", input.skills);
  scan("tool", input.tools);
  return out.sort(
    (a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type)
  );
}

/** Every shadow this user can see. A failed read throws — never "no shadows". */
export async function findCapabilityShadows(
  userId: string
): Promise<CapabilityShadow[]> {
  const [members, containers, skillRows, toolRows] = await Promise.all([
    db
      .select({
        fromType: links.fromType,
        fromId: links.fromId,
        toId: links.toId,
      })
      .from(links)
      .where(
        and(
          eq(links.linkType, "member_of"),
          eq(links.toType, "capability"),
          inArray(links.fromType, ["skill", "tool"])
        )
      ),
    db
      .select({ id: capabilities.id, name: capabilities.name })
      .from(capabilities)
      .where(userVisibleWhere(capabilities.workspaceId, userId)),
    db
      .select({
        id: skills.id,
        name: skills.name,
        workspaceId: skills.workspaceId,
        kind: skills.kind,
        approved: skills.approved,
      })
      .from(skills)
      // Only an ACTIVE skill can answer a verb, so only an active one shadows.
      .where(and(visibleSkillsWhere(userId), eq(skills.status, "active"))),
    db
      .select({
        id: tools.id,
        name: tools.name,
        workspaceId: tools.workspaceId,
      })
      .from(tools)
      .where(userVisibleWhere(tools.workspaceId, userId)),
  ]);
  return classifyShadows({
    members: members.map((m) => ({ ...m, toId: String(m.toId) })),
    containers: containers.map((c) => ({ id: String(c.id), name: c.name })),
    skills: skillRows.map((s) => ({
      id: String(s.id),
      name: s.name,
      workspaceId: s.workspaceId ?? null,
      kind: String(s.kind),
      approved: s.approved === true,
    })),
    tools: toolRows.map((t) => ({
      id: String(t.id),
      name: t.name,
      workspaceId: t.workspaceId ?? null,
    })),
  });
}

export interface RetireShadowsResult {
  retired: Array<{ type: "skill" | "tool"; id: string; name: string }>;
  /** Requested ids that were NOT removed, and why. Never silently dropped. */
  refused: Array<{ id: string; reason: string }>;
}

/**
 * Remove shadows. The set is RE-DERIVED here from `findCapabilityShadows` —
 * a requested id that is not a shadow right now is refused, never deleted, so
 * this door can only ever remove what the diagnose list shows. `authorize`
 * enforces the caller's floor per row scope (workspace owner / pod admin — the
 * same floor as `capabilities.uninstall`) and throws to refuse.
 *
 * A shadow TOOL is refused while a skill that is NOT being retired still
 * requires it — removing it would strand that skill.
 */
export async function retireCapabilityShadows(input: {
  userId: string;
  ids: string[];
  authorize: (workspaceId: string | null) => Promise<void>;
  /** The shadow set to re-derive from. Defaults to the real read. */
  load?: (userId: string) => Promise<CapabilityShadow[]>;
}): Promise<RetireShadowsResult> {
  const load = input.load ?? findCapabilityShadows;
  const current = new Map((await load(input.userId)).map((s) => [s.id, s]));
  const refused: RetireShadowsResult["refused"] = [];
  const chosen: CapabilityShadow[] = [];
  for (const id of [...new Set(input.ids)]) {
    const shadow = current.get(id);
    if (!shadow) {
      refused.push({ id, reason: "not a shadow (or not visible to you)" });
      continue;
    }
    try {
      await input.authorize(shadow.workspaceId);
    } catch (err) {
      refused.push({
        id,
        reason: err instanceof Error ? err.message : "not allowed",
      });
      continue;
    }
    chosen.push(shadow);
  }

  const retiringSkills = new Set(
    chosen.filter((s) => s.type === "skill").map((s) => s.id)
  );
  const toolIds = chosen.filter((s) => s.type === "tool").map((s) => s.id);
  if (toolIds.length > 0) {
    const requirers = await db
      .select({ skillId: links.fromId, toolId: links.toId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "skill"),
          eq(links.toType, "tool"),
          eq(links.linkType, "requires"),
          inArray(links.toId, toolIds)
        )
      );
    const blocked = new Map<string, number>();
    for (const r of requirers) {
      if (!retiringSkills.has(r.skillId)) {
        blocked.set(r.toolId, (blocked.get(r.toolId) ?? 0) + 1);
      }
    }
    for (const [toolId, n] of blocked) {
      refused.push({
        id: toolId,
        reason: `${n} skill(s) outside this removal still require this tool`,
      });
    }
    for (let i = chosen.length - 1; i >= 0; i--) {
      if (blocked.has(chosen[i]!.id)) chosen.splice(i, 1);
    }
  }

  if (chosen.length === 0) return { retired: [], refused };

  const ids = chosen.map((s) => s.id);
  const skillIds = chosen.filter((s) => s.type === "skill").map((s) => s.id);
  const removeToolIds = chosen
    .filter((s) => s.type === "tool")
    .map((s) => s.id);
  await db.transaction(async (tx) => {
    // Every edge touching a removed part — grants, requires, lineage. A shadow
    // has no `member_of`, so no pack is touched.
    await tx
      .delete(links)
      .where(or(inArray(links.fromId, ids), inArray(links.toId, ids)));
    if (skillIds.length > 0) {
      await tx.delete(skills).where(inArray(skills.id, skillIds));
    }
    if (removeToolIds.length > 0) {
      await tx.delete(tools).where(inArray(tools.id, removeToolIds));
    }
    // Grants are polymorphic (no FK), so a removed part's grants would linger
    // as dead rows. Revoke rather than delete: the grant ledger is an audit
    // trail.
    await tx
      .update(vaultGrants)
      .set({ revokedAt: new Date() })
      .where(
        and(
          inArray(vaultGrants.grantableType, ["skill", "tool"]),
          inArray(vaultGrants.grantableId, ids),
          isNull(vaultGrants.revokedAt)
        )
      );
  });
  return {
    retired: chosen.map((s) => ({ type: s.type, id: s.id, name: s.name })),
    refused,
  };
}
