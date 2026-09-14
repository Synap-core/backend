/**
 * RULE SCOPE → TRIGGER, at the governed rule door (founder decision R2,
 * 2026-09-14: a rule carrying `scope.projectId` fires only for things
 * happening on that project).
 *
 * The door's `RuleScope` holds `projectId` (never an entity or channel), and
 * until now it reached only `metadata` — a LIST label. The trigger matcher
 * narrows on `triggerConfig.projectId`, so this is where the lens has to land.
 *
 * ── Refuse, not "context only" ─────────────────────────────────────────────
 * When the compiled WHEN is a family whose events cannot be tied to a project
 * (a schedule, a capture, a relation, the `message.received` alias), the create
 * or edit is REFUSED by clause. Recording the project as context would store
 * exactly the rule this decision exists to stop: one that reads as scoped and
 * runs on every matching event. The browser dialog makes the same call (it will
 * not create a project-limited rule the runtime cannot limit; it offers to
 * remove the limit instead), so the two doors agree.
 *
 * A prose-only rule (no sentence) and a DRAFT compile nothing, so they carry the
 * project as the skill row's lens only; the refusal happens at activation,
 * which recompiles through `update.ts`.
 *
 * ── Mirror ─────────────────────────────────────────────────────────────────
 * `PROJECT_SCOPE_EVENT_PREFIXES` MIRRORS `RULE_SCOPE_EVENT_PREFIXES.projectId`
 * in `@synap/jobs` `automation-trigger-matcher.ts`. It is not imported because
 * this package consumes `@synap/jobs` through its built `dist`, so a new export
 * would typecheck only after a rebuild — and a silent stale-dist green is worse
 * than a pinned copy. `scope.tripwire.test.ts` parses the matcher source and
 * fails on any drift.
 */

import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import type { RuleCompileFailure } from "./compile.js";

export const PROJECT_SCOPE_EVENT_PREFIXES = [
  "entity.",
  "entity_facet.",
  "external_message.",
  "channel_message.",
  "focus_session.",
  "proposal.",
] as const;

export interface CompiledTrigger {
  triggerType: string;
  triggerConfig: Record<string, unknown>;
}

export type RuleProjectScopeBinding =
  | {
      ok: true;
      triggerConfig: Record<string, unknown>;
      /** Present only when the rule is now project-limited. Safe to show verbatim. */
      scopeNote?: string;
    }
  | { ok: false; failure: RuleCompileFailure };

/** Whether the matcher can limit a trigger of this shape to a project. */
export function isProjectScopeEnforceable(trigger: CompiledTrigger): boolean {
  const pattern = trigger.triggerConfig.eventPattern;
  return (
    trigger.triggerType === "event" &&
    typeof pattern === "string" &&
    PROJECT_SCOPE_EVENT_PREFIXES.some((p) => pattern.startsWith(p))
  );
}

/**
 * The ONE step both rule doors run after compiling: rebind the compiled trigger
 * with the project lens, or refuse by clause. Pure; never mutates `compiled`.
 */
export function applyRuleProjectScope<T extends { trigger: CompiledTrigger }>(
  compiled: T,
  projectId: string | undefined
):
  | { ok: true; compiled: T; scopeNote?: string }
  | { ok: false; failure: RuleCompileFailure } {
  const bound = bindRuleProjectScope(compiled.trigger, projectId);
  if (!bound.ok) return bound;
  return {
    ok: true,
    compiled: {
      ...compiled,
      trigger: { ...compiled.trigger, triggerConfig: bound.triggerConfig },
    },
    ...(bound.scopeNote ? { scopeNote: bound.scopeNote } : {}),
  };
}

/**
 * Stamp `scope.projectId` into the compiled trigger, or refuse by clause. Pure;
 * returns a NEW config and never mutates the compiler's output.
 */
export function bindRuleProjectScope(
  trigger: CompiledTrigger,
  projectId: string | undefined
): RuleProjectScopeBinding {
  if (!projectId) return { ok: true, triggerConfig: trigger.triggerConfig };
  const noun = resolveObjectNoun("project").toLowerCase();
  if (!isProjectScopeEnforceable(trigger)) {
    const what =
      typeof trigger.triggerConfig.eventPattern === "string"
        ? `"${trigger.triggerConfig.eventPattern}"`
        : `a ${trigger.triggerType} trigger`;
    return {
      ok: false,
      failure: {
        clause: "WHEN",
        reason: `This rule is limited to a ${noun}, but its WHEN (${what}) is not about anything that belongs to a ${noun}, so it could not be limited and would run on every matching event. Nothing was saved. Remove the ${noun}, or choose a WHEN about an entity, a message, a session or a proposal.`,
      },
    };
  }
  return {
    ok: true,
    triggerConfig: { ...trigger.triggerConfig, projectId },
    scopeNote: `This rule runs only for events on ${noun} ${projectId}.`,
  };
}
