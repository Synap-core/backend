/**
 * TEMPLATE RULES — the rules a space's template ships (package `rules[]`),
 * installed and converged through the ONE rule door.
 *
 * Every write goes through `createRuleGoverned` / `updateRuleGoverned`; this
 * module only decides WHICH write, using a three-way stamp per rule
 * (founder decision 2026-09-28 — your edits win, conflicts are reported):
 *
 *   `metadata.rule.seed = { template, key, hash }` where `hash` covers exactly
 *   the fields this applier writes: `intent` + `sentence`.
 *
 *   row found, fields hash to the seed → untouched → take a template update
 *                                        (restamped), or nothing if unchanged
 *   row found, fields differ           → the owner edited it → kept; CONFLICT
 *                                        only when the template moved too
 *   no row, no ref in the brief        → install it (stamped)
 *   no row, ref WITH a ruleId          → the owner deleted it → not reinstalled
 *   no row, ref WITHOUT a ruleId       → offered before (proposed, or the
 *                                        proposal was declined) → not re-offered
 *
 * The space brief lists the refs (`onboarding.rules = [{key, ruleId?}]`),
 * never the rule bodies — that is how the brief names its rules, and how this
 * reconcile remembers what it already offered.
 */

import { createHash } from "node:crypto";
import {
  db,
  skills,
  workspaces,
  and,
  eq,
  inArray,
  getDb,
  eventRepository,
  WorkspaceRepository,
  drizzleSql,
} from "@synap/database";
import {
  normalizeSpaceBrief,
  type SpaceBriefRuleRef,
} from "@synap-core/types/space-brief";
import { RULE_CATEGORY, readRuleMetadata, type RuleSeed } from "./index.js";
import { createRuleGoverned } from "./create.js";
import { updateRuleGoverned } from "./update.js";

export interface TemplateRuleDecl {
  key: string;
  intent: string;
  sentence?: unknown;
}

export type TemplateRuleStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "kept" // owner-edited, template unchanged (or already equal)
  | "conflict" // owner-edited AND the template moved
  | "deleted_by_owner"
  | "offered" // a proposal was filed now, or earlier (ref without ruleId)
  | "denied"
  | "failed";

export interface TemplateRuleOutcome {
  key: string;
  status: TemplateRuleStatus;
  ruleId?: string;
  proposalId?: string;
  reason?: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/**
 * THE projection the marker covers — exactly the fields this applier writes.
 * Both sides (template decl, stored rule) are hashed through this one function.
 */
export function templateRuleHash(r: {
  intent: string;
  sentence?: unknown;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({ intent: r.intent.trim(), sentence: r.sentence ?? null })
    )
    .digest("hex")
    .slice(0, 32);
}

/** Parse untrusted package JSON into declarations; malformed entries are dropped. */
export function readTemplateRules(raw: unknown): TemplateRuleDecl[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TemplateRuleDecl[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { key, intent, sentence } = r as Record<string, unknown>;
    if (typeof key !== "string" || !key.trim() || seen.has(key)) continue;
    if (typeof intent !== "string" || !intent.trim()) continue;
    seen.add(key);
    out.push({
      key,
      intent: intent.trim(),
      ...(sentence !== undefined && sentence !== null ? { sentence } : {}),
    });
  }
  return out;
}

/** What to do for one declared rule — PURE, so the three-way is unit-tested. */
export function decideTemplateRule(input: {
  decl: TemplateRuleDecl;
  stored: { intent: string; sentence?: unknown; seed?: RuleSeed } | null;
  ref: SpaceBriefRuleRef | null;
  /** Does the ref's ruleId still name a row? (only asked when there is one) */
  refRowExists: boolean;
}):
  | { action: "create" }
  | { action: "update" }
  | { action: "none"; status: TemplateRuleStatus } {
  const { decl, stored, ref } = input;
  const hT = templateRuleHash(decl);
  if (!stored) {
    if (!ref) return { action: "create" };
    if (!ref.ruleId) return { action: "none", status: "offered" };
    // A ref to a row that no longer exists: the owner deleted it.
    return input.refRowExists
      ? { action: "none", status: "kept" }
      : { action: "none", status: "deleted_by_owner" };
  }
  const hS = templateRuleHash(stored);
  const seed = stored.seed?.hash;
  if (hS === seed) {
    return hT === seed
      ? { action: "none", status: "unchanged" }
      : { action: "update" };
  }
  if (hT === seed || hS === hT) return { action: "none", status: "kept" };
  return { action: "none", status: "conflict" };
}

/**
 * Did this pass converge the template's rules? The boot pass withholds the
 * whole-template `packageVersion` stamp when it did not (backend-rules: a
 * marker asserts only what was checked). `conflict` / `kept` /
 * `deleted_by_owner` ARE converged — the owner's choice wins and is reported.
 * An offer filed THIS pass (`proposalId`) is queued, not applied, so it
 * withholds; an offer remembered from an earlier pass (a declined or pending
 * proposal, ref without ruleId) does not, or one declined offer would keep the
 * space "stale" forever.
 */
export function templateRulesConverged(
  outcomes: ReadonlyArray<TemplateRuleOutcome>
): boolean {
  return outcomes.every(
    (o) =>
      o.status !== "failed" &&
      o.status !== "denied" &&
      !(o.status === "offered" && o.proposalId)
  );
}

/**
 * Install / converge a template's rules in one space. Non-fatal per rule;
 * returns one outcome per declared rule. Writes the brief's rule refs through
 * the brief's compare-and-set door.
 */
export async function applyTemplateRules(input: {
  workspaceId: string;
  userId: string;
  agentUserId?: string;
  /** The template (package slug) — the seed's namespace. */
  templateSlug: string;
  rules: unknown;
}): Promise<TemplateRuleOutcome[]> {
  const decls = readTemplateRules(input.rules);
  if (decls.length === 0) return [];

  const [ws] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  if (!ws) throw new Error(`workspace ${input.workspaceId} not found`);
  const rawBrief = (ws.settings as Record<string, unknown> | null)?.onboarding;
  const brief = normalizeSpaceBrief(rawBrief);
  const refs = new Map<string, SpaceBriefRuleRef>(
    (brief?.rules ?? []).map((r) => [r.key, r])
  );

  const rows = await db
    .select({ id: skills.id, metadata: skills.metadata })
    .from(skills)
    .where(
      and(
        eq(skills.workspaceId, input.workspaceId),
        eq(skills.category, RULE_CATEGORY),
        drizzleSql`${skills.metadata}->'rule'->'seed'->>'template' = ${input.templateSlug}`
      )
    );
  const byKey = new Map<
    string,
    { id: string; meta: NonNullable<ReturnType<typeof readRuleMetadata>> }
  >();
  for (const row of rows) {
    const meta = readRuleMetadata(row.metadata as Record<string, unknown>);
    if (meta?.seed && !byKey.has(meta.seed.key))
      byKey.set(meta.seed.key, { id: row.id, meta });
  }

  const refIds = [...refs.values()].flatMap((r) =>
    r.ruleId && !byKey.has(r.key) ? [r.ruleId] : []
  );
  const liveRefIds = new Set(
    refIds.length
      ? (
          await db
            .select({ id: skills.id })
            .from(skills)
            .where(inArray(skills.id, refIds))
        ).map((r) => r.id)
      : []
  );

  const outcomes: TemplateRuleOutcome[] = [];
  const nextRefs = new Map(refs);
  for (const decl of decls) {
    const found = byKey.get(decl.key) ?? null;
    const ref = refs.get(decl.key) ?? null;
    const seed: RuleSeed = {
      template: input.templateSlug,
      key: decl.key,
      hash: templateRuleHash(decl),
    };
    try {
      const d = decideTemplateRule({
        decl,
        stored: found ? found.meta : null,
        ref,
        refRowExists: !!ref?.ruleId && liveRefIds.has(ref.ruleId),
      });
      if (found) nextRefs.set(decl.key, { key: decl.key, ruleId: found.id });
      if (d.action === "none") {
        outcomes.push({
          key: decl.key,
          status: d.status,
          ...(found ? { ruleId: found.id } : {}),
        });
        continue;
      }
      if (d.action === "create") {
        const r = await createRuleGoverned({
          userId: input.userId,
          ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
          workspaceId: input.workspaceId,
          intent: decl.intent,
          scope: { kind: "workspace", workspaceId: input.workspaceId },
          ...(decl.sentence !== undefined ? { sentence: decl.sentence } : {}),
          seed,
          auditSource: "template",
        });
        if (r.status === "created") {
          nextRefs.set(decl.key, { key: decl.key, ruleId: r.ruleId });
          outcomes.push({ key: decl.key, status: "created", ruleId: r.ruleId });
        } else if (r.status === "proposed") {
          // Remember the offer, so a later pass never files it twice.
          nextRefs.set(decl.key, { key: decl.key });
          outcomes.push({
            key: decl.key,
            status: "offered",
            proposalId: r.proposalId,
          });
        } else {
          outcomes.push({ key: decl.key, status: "denied", reason: r.reason });
        }
        continue;
      }
      // update: untouched since last write, and the template moved.
      const stored = found!.meta;
      const r = await updateRuleGoverned({
        userId: input.userId,
        ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
        ruleId: found!.id,
        workspaceId: input.workspaceId,
        intent: decl.intent,
        scope: stored.scope,
        // Template dropped its sentence ⇒ remove the stored one; else replace.
        sentence:
          decl.sentence !== undefined
            ? decl.sentence
            : stored.sentence !== undefined
              ? null
              : undefined,
        seed,
        auditSource: "template",
      });
      if (r.status === "updated")
        outcomes.push({ key: decl.key, status: "updated", ruleId: found!.id });
      else if (r.status === "proposed")
        outcomes.push({
          key: decl.key,
          status: "offered",
          proposalId: r.proposalId,
          ruleId: found!.id,
        });
      else
        outcomes.push({
          key: decl.key,
          status: "denied",
          ruleId: found!.id,
          reason: "reason" in r ? r.reason : r.status,
        });
    } catch (err) {
      outcomes.push({
        key: decl.key,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Refs: one per declared-or-remembered key, declaration order first.
  const ordered: SpaceBriefRuleRef[] = [
    ...decls.flatMap((d) =>
      nextRefs.has(d.key) ? [nextRefs.get(d.key)!] : []
    ),
    ...[...nextRefs.values()].filter(
      (r) => !decls.some((d) => d.key === r.key)
    ),
  ];
  const before = JSON.stringify(brief?.rules ?? []);
  if (JSON.stringify(ordered) !== before) {
    const raw =
      rawBrief && typeof rawBrief === "object"
        ? (rawBrief as Record<string, unknown>)
        : {};
    const repo = new WorkspaceRepository(await getDb(), eventRepository);
    const wrote = await repo.replaceSpaceBrief(
      input.workspaceId,
      { expected: rawBrief, brief: { ...raw, rules: ordered } },
      input.userId
    );
    if (!wrote) {
      // A concurrent brief edit won; the rule rows are stamped, so the next
      // pass re-derives the refs from them.
      outcomes.push({
        key: "(brief rule refs)",
        status: "failed",
        reason: "brief changed concurrently; refs are re-derived next pass",
      });
    }
  }
  return outcomes;
}
