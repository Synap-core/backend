/**
 * WHAT A SPACE NEEDS, AND WHETHER EACH NEED IS FILLED (founder decisions D2
 * and D3, 16 Nov 2026). The intent coverage chain (`workspaceIntentCoverage`
 * → `resolveIntentGap` → `proposeIntentGapInstall`, which had no caller),
 * extended from intents to needs and wired.
 *
 * DECLARED: the needs the space's processes name ({@link readSpaceDeclaredNeeds}):
 * every `need:` ref of its playbooks (`tools`, `requires`, criteria, and each
 * stage's) and of its automations' `capability` nodes (`data.need`). Derived,
 * never stored: this REPLACES the space's `settings.taskIntents`, which the
 * template install wrote and no runtime path read since 0419 (retired here:
 * the install no longer writes it).
 *
 * FILLED: the space's live binding (`space-needs.ts`), with its provider.
 * EMPTY: no binding, or its provider was deleted. An empty need lists the
 * installed capabilities that declare they fill it (`metadata.fills`), so
 * the person picks one.
 *
 * {@link reconcileSpaceNeeds} runs at template install. For each EMPTY need:
 *   - exactly ONE installed provider fills it → it already fills the need
 *     IMPLICITLY (`withImplicitBindings`, so a converted playbook keeps
 *     running on upgrade); the reconcile RECORDS it as a row (named default:
 *     nothing to choose; the person can rebind);
 *   - none → an install proposal for a catalog pack whose `fills` names it
 *     (the existing `capability.install` proposal seam, never an install);
 *   - several → left empty: the person chooses (the needs read shows them).
 * A failed read is never "the space needs nothing": it throws, or comes back
 * `failed` per need.
 */
import { createLogger } from "@synap-core/core";
import {
  and,
  automations,
  db,
  eq,
  isNull,
  ne,
  playbooks,
} from "@synap/database";
import {
  canonicalNeedSlug,
  declaredNeedsOf,
  needOf,
  parseNeedRef,
  type NeedDeclaringPlaybook,
} from "@synap-core/types/needs";
import {
  applySpaceNeedBinding,
  declaresFill,
  readInstalledNeedProviders,
  readSpaceNeedBindings,
  type InstalledNeedProvider,
  type SpaceNeedBindings,
} from "./space-needs.js";

const logger = createLogger({ module: "space-need-coverage" });

/** One declared need of a space and its state. */
export interface SpaceNeedCoverage {
  need: string;
  /** The vocabulary's words; null for a slug the vocabulary does not know. */
  label: string | null;
  known: boolean;
  state: "filled" | "empty";
  provider: { capabilityId: string; name: string | null } | null;
  /**
   * True when no binding row exists and the space's ONE filling provider
   * stands in (an implicit binding: the run uses it; the reconcile records it).
   */
  implicit: boolean;
  /**
   * When filled by a row: who set it, when, and HOW it was chosen (`person`,
   * or `automatic`: the pod bound the space's one filling provider; it stays
   * bound when a second provider is installed, and `candidates` then lists
   * both so a surface can offer the choice). Null for an implicit binding.
   */
  binding: {
    bindingId: string;
    setBy: string;
    updatedAt: Date;
    origin: "person" | "automatic";
  } | null;
  /** Installed capabilities that declare they fill it (the person's choices). */
  candidates: Array<{ capabilityId: string; name: string }>;
}

export interface SpaceNeedCoverageResult {
  workspaceId: string;
  /** In declaration order. `[]` = the space's processes name no need (a real answer). */
  needs: SpaceNeedCoverage[];
  /** The empty needs, in order. */
  empty: string[];
}

/** The `need` refs of an automation flow's `capability` nodes. PURE. */
export function needRefsOfFlow(flow: unknown): string[] {
  const nodes = (flow as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: string[] = [];
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const node = n as { type?: unknown; data?: { need?: unknown } };
    if (node.type !== "capability") continue;
    const need = node.data?.need;
    if (typeof need === "string" && parseNeedRef(need) && !out.includes(need)) {
      out.push(need);
    }
  }
  return out;
}

/** Join declared needs × bindings × installed providers. PURE. */
export function foldNeedCoverage(input: {
  workspaceId: string;
  declared: readonly string[];
  bindings: SpaceNeedBindings;
  installed: readonly InstalledNeedProvider[];
}): SpaceNeedCoverageResult {
  const needs: SpaceNeedCoverage[] = [];
  const empty: string[] = [];
  for (const raw of input.declared) {
    const slug = canonicalNeedSlug(raw) ?? raw;
    if (needs.some((n) => n.need === slug)) continue;
    const def = needOf(slug);
    const binding = input.bindings.get(slug);
    const filled = !!binding?.providerCapabilityId;
    const candidates = input.installed
      .filter((c) => declaresFill(c.metadata, slug))
      .map((c) => ({ capabilityId: c.id, name: c.name }));
    if (!filled) empty.push(slug);
    const implicit = filled && binding!.implicit === true;
    needs.push({
      need: slug,
      label: def?.label ?? null,
      known: !!def,
      state: filled ? "filled" : "empty",
      implicit,
      provider: filled
        ? {
            capabilityId: binding!.providerCapabilityId!,
            name: binding!.providerName,
          }
        : null,
      binding:
        filled && !implicit && binding!.bindingId && binding!.setBy
          ? {
              bindingId: binding!.bindingId,
              setBy: binding!.setBy,
              updatedAt: binding!.updatedAt ?? new Date(0),
              origin: binding!.origin ?? "person",
            }
          : null,
      candidates,
    });
  }
  return { workspaceId: input.workspaceId, needs, empty };
}

/**
 * The needs a space's processes declare: its playbooks' and automations'
 * `need:` refs, canonical slugs, first-seen order. Archived ones excluded.
 */
export async function readSpaceDeclaredNeeds(
  workspaceId: string
): Promise<string[]> {
  const [pbs, autos] = await Promise.all([
    db
      .select({
        tools: playbooks.tools,
        requires: playbooks.requires,
        stages: playbooks.stages,
        criteria: playbooks.criteria,
      })
      .from(playbooks)
      .where(
        and(
          eq(playbooks.workspaceId, workspaceId),
          ne(playbooks.status, "archived")
        )
      ),
    db
      .select({ flowDefinition: automations.flowDefinition })
      .from(automations)
      .where(
        and(
          eq(automations.workspaceId, workspaceId),
          ne(automations.status, "archived")
        )
      ),
  ]);
  const declaring: NeedDeclaringPlaybook[] = [
    ...(pbs as NeedDeclaringPlaybook[]),
    ...autos.map((a) => ({ tools: needRefsOfFlow(a.flowDefinition) })),
  ];
  return declaredNeedsOf(declaring);
}

/** A space's needs and their state. Throws when a read fails. */
export async function workspaceNeedCoverage(
  workspaceId: string
): Promise<SpaceNeedCoverageResult> {
  const declared = await readSpaceDeclaredNeeds(workspaceId);
  const installed = await readInstalledNeedProviders(workspaceId);
  const bindings = await readSpaceNeedBindings(workspaceId, { installed });
  return foldNeedCoverage({ workspaceId, declared, bindings, installed });
}

/** What the reconcile did for one empty need. */
export type NeedReconcileStep =
  | {
      need: string;
      action: "recorded";
      providerCapabilityId: string;
      providerName: string;
    }
  | { need: string; action: "choose"; candidates: string[] }
  | { need: string; action: "proposed"; proposalId: string; slug: string }
  | { need: string; action: "no_provider"; message: string }
  | { need: string; action: "unknown_need" }
  | { need: string; action: "failed"; error: string };

export interface NeedReconcileReport {
  workspaceId: string;
  /** Needs already filled by a row before the reconcile. */
  filled: string[];
  steps: NeedReconcileStep[];
}

/**
 * Fill what can be filled without a choice, propose what is missing, and say
 * what waits on the person. Called after a template install (the install
 * itself was the person's act, or an approved proposal); never throws for
 * one need: each failure is its own step.
 */
export async function reconcileSpaceNeeds(input: {
  workspaceId: string;
  userId: string;
  agentUserId?: string | null;
  sessionId?: string | null;
  /**
   * File an install proposal for a need nothing installed fills (default
   * true). The boot backfill passes false: it only records, never asks.
   */
  proposeInstalls?: boolean;
}): Promise<NeedReconcileReport> {
  const coverage = await workspaceNeedCoverage(input.workspaceId);
  const filled = coverage.needs
    .filter((n) => n.state === "filled" && !n.implicit)
    .map((n) => n.need);
  const steps: NeedReconcileStep[] = [];
  for (const n of coverage.needs) {
    // An implicit binding (the space's one filling provider) is recorded as a
    // row, so the pages show who fills it and a later second provider does
    // not silently un-fill it.
    if (n.state === "filled" && n.implicit && n.provider) {
      try {
        const r = await applySpaceNeedBinding({
          workspaceId: input.workspaceId,
          need: n.need,
          providerCapabilityId: n.provider.capabilityId,
          userId: input.userId,
          origin: "automatic",
        });
        steps.push({
          need: n.need,
          action: "recorded",
          providerCapabilityId: n.provider.capabilityId,
          providerName:
            r.status === "bound" ? r.providerName : (n.provider.name ?? ""),
        });
      } catch (err) {
        steps.push({
          need: n.need,
          action: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    if (n.state === "filled") continue;
    if (!n.known) {
      steps.push({ need: n.need, action: "unknown_need" });
      continue;
    }
    try {
      if (n.candidates.length > 1) {
        steps.push({
          need: n.need,
          action: "choose",
          candidates: n.candidates.map((c) => c.capabilityId),
        });
        continue;
      }
      if (input.proposeInstalls === false) continue;
      const { resolveNeedGap } =
        await import("../capabilities/propose-intent-gap-install.js");
      const offer = await resolveNeedGap({
        need: n.need,
        userId: input.userId,
        workspaceId: input.workspaceId,
        agentUserId: input.agentUserId ?? null,
        sessionId: input.sessionId ?? null,
      });
      if (offer.status === "proposed") {
        steps.push({
          need: n.need,
          action: "proposed",
          proposalId: offer.proposalId,
          slug: offer.slug,
        });
      } else if (offer.status === "no_provider") {
        steps.push({
          need: n.need,
          action: "no_provider",
          message: offer.message,
        });
      } else {
        steps.push({ need: n.need, action: "failed", error: offer.error });
      }
    } catch (err) {
      logger.warn(
        { err, workspaceId: input.workspaceId, need: n.need },
        "reconcileSpaceNeeds: one need could not be reconciled"
      );
      steps.push({
        need: n.need,
        action: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { workspaceId: input.workspaceId, filled, steps };
}

/**
 * BOOT BACKFILL (0426): for every live space whose processes name a need,
 * record the implicit bindings (the one installed provider that fills each
 * need) as rows, as the space's owner. Never proposes an install and never
 * picks between providers. Runs after the boot capability reconcile, which
 * stamps `metadata.fills`. Never throws: one space's failure is logged and
 * the next goes on.
 */
export async function backfillSpaceNeedBindings(): Promise<{
  spaces: number;
  recorded: number;
  failed: number;
}> {
  const { workspaces } = await import("@synap/database/schema");
  const rows = await db
    .select({ id: workspaces.id, ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(isNull(workspaces.archivedAt));
  let spaces = 0;
  let recorded = 0;
  let failed = 0;
  for (const ws of rows) {
    try {
      const declared = await readSpaceDeclaredNeeds(ws.id);
      if (declared.length === 0) continue;
      spaces += 1;
      const report = await reconcileSpaceNeeds({
        workspaceId: ws.id,
        userId: ws.ownerId,
        proposeInstalls: false,
      });
      for (const step of report.steps) {
        if (step.action === "recorded") recorded += 1;
        if (step.action === "failed") failed += 1;
      }
    } catch (err) {
      failed += 1;
      logger.warn(
        { err, workspaceId: ws.id },
        "backfillSpaceNeedBindings: a space's needs could not be backfilled"
      );
    }
  }
  return { spaces, recorded, failed };
}
