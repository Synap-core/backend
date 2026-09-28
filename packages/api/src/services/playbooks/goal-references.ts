/**
 * Playbook goal ⇄ declared params — the author-time reference check, at the
 * BACKEND door.
 *
 * `findUnresolvedReferences` (utils/template-references.ts) already knows which
 * references `substitute()` will not resolve; until now it ran only in the
 * browser authoring surfaces, so every non-browser door (MCP, CLI, Hub, the AI
 * tool's merged-row case) could persist a goal whose `{placeholders}` no
 * declared param backs. This adapter is the ONE thing that was missing: pull
 * the declared names off the loosely-typed `params` JSONB and hand them to the
 * SAME validator. No second grammar, no second rule.
 *
 * ── `{{name}}` (founder decision 2026-09-28, space-brief plan item 9) ───────
 * `findUnresolvedReferences` masks every `{{…}}` as automation-DAG grammar and
 * says nothing about it. But a BARE `{{name}}` in a playbook goal is filled by
 * NOBODY, verified 2026-09-28:
 *   - the run door (`resolveGoal` → `parseCommandTemplate`) substitutes
 *     `{name}` / `@{arg:name}` and deliberately leaves `{{…}}` untouched, so
 *     `Run the dev task "{{task}}"` reaches the agent verbatim even when
 *     `task` is declared AND supplied;
 *   - the automation resolver (`resolveTemplate`) reads only rooted paths
 *     (`trigger.` / `steps.` / `automation.` / `loop.` / `item.`), so a bare
 *     name there renders "".
 * Ten live playbooks carry one (AI Dev Session's `{{task}}`, …). So a bare
 * `{{name}}` is always a defect, declared or not; a DOTTED `{{trigger.x}}`
 * is real automation grammar and is left alone.
 *
 * `findGoalPlaceholderProblems` is what the create/update doors REFUSE on
 * (`playbooks.ts`); `findUnresolvedGoalReferences` stays the wider warn-only
 * report (it also names braced prose such as `{see below}`, which is not a
 * placeholder and must never block a save).
 */

import { readPlaybookParams } from "@synap/playbooks";
import {
  findUnresolvedReferences,
  REF_ARG,
  REF_BARE_ARG,
  REF_LEGACY_ARG,
  type UnresolvedReference,
} from "../../utils/template-references.js";

/**
 * Declared param names — through `readPlaybookParams`, the ONE reader the run
 * door validates with, so "declared" here means exactly what it means there.
 */
function declaredParamNames(params: unknown): string[] {
  return readPlaybookParams(params).map((p) => p.name);
}

/**
 * Every reference in `goalTemplate` that substitution would NOT resolve given
 * the playbook's declared `params`. Empty when the goal is fully backed (or
 * when there is no goal to check).
 */
export function findUnresolvedGoalReferences(
  goalTemplate: unknown,
  params: unknown
): UnresolvedReference[] {
  if (typeof goalTemplate !== "string" || goalTemplate === "") return [];
  return findUnresolvedReferences(goalTemplate, declaredParamNames(params));
}

/** A goal placeholder no run will ever fill. */
export interface GoalPlaceholderProblem {
  /** Exactly as written, braces included — the identity of the problem. */
  text: string;
  /** The param name it reaches for. */
  name: string;
  /**
   * `undeclared`   — `{name}` / `@{arg:name}` naming no declared param.
   * `double-brace` — a bare `{{name}}`, which no resolver fills (header).
   */
  kind: "undeclared" | "double-brace";
  /** Whether `name` IS declared (then only the spelling is wrong). */
  declared: boolean;
}

/** A bare identifier in double braces — never a rooted automation path. */
const BARE_DOUBLE_BRACE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function argName(text: string): string | null {
  for (const pat of [REF_ARG, REF_LEGACY_ARG, REF_BARE_ARG]) {
    const m = new RegExp(`^${pat.source}$`, pat.flags).exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * The placeholders in `goalTemplate` that a run would leave unfilled: bare
 * `{{name}}` (always) and `{name}` / `@{arg:name}` whose name is not declared.
 * Braced prose (`{see below}`) and rooted `{{trigger.x}}` paths are NOT
 * placeholders here. Ordered as first written; each text once.
 */
export function findGoalPlaceholderProblems(
  goalTemplate: unknown,
  params: unknown
): GoalPlaceholderProblem[] {
  if (typeof goalTemplate !== "string" || goalTemplate === "") return [];
  const declared = new Set(declaredParamNames(params));
  const found: Array<GoalPlaceholderProblem & { at: number }> = [];
  const seen = new Set<string>();

  for (const m of goalTemplate.matchAll(BARE_DOUBLE_BRACE)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    const name = m[1]!;
    found.push({
      text: m[0],
      name,
      kind: "double-brace",
      declared: declared.has(name),
      at: m.index ?? 0,
    });
  }
  for (const ref of findUnresolvedReferences(goalTemplate, [...declared])) {
    if (ref.kind !== "unknown-arg" || seen.has(ref.text)) continue;
    const name = argName(ref.text);
    if (!name) continue;
    seen.add(ref.text);
    found.push({
      text: ref.text,
      name,
      kind: "undeclared",
      declared: false,
      at: goalTemplate.indexOf(ref.text),
    });
  }
  return found.sort((a, b) => a.at - b.at).map(({ at: _at, ...p }) => p);
}

/**
 * The refusal sentence: what is wrong, and the exact fix. One wording for
 * every door (tRPC, MCP, Hub and the package installer all reach
 * `playbooks.create` / `playbooks.update`).
 */
export function describeGoalPlaceholderProblems(
  problems: readonly GoalPlaceholderProblem[]
): string {
  const toDeclare = [
    ...new Set(problems.filter((p) => !p.declared).map((p) => p.name)),
  ];
  const toRespell = problems.filter((p) => p.kind === "double-brace");
  const parts = [
    `goalTemplate has placeholders no run will fill: ${problems.map((p) => p.text).join(", ")}.`,
  ];
  if (toDeclare.length > 0) {
    parts.push(
      `Declare ${toDeclare.map((n) => `"${n}"`).join(", ")} in params, e.g. params: [${toDeclare
        .map((n) => `{ "name": "${n}", "type": "text", "required": true }`)
        .join(", ")}].`
    );
  }
  if (toRespell.length > 0) {
    parts.push(
      `Write a param as {name}, not {{name}}: ${toRespell
        .map((p) => `${p.text} → {${p.name}}`)
        .join(
          ", "
        )} ({{…}} is automation context only, e.g. {{trigger.payload.title}}).`
    );
  }
  return parts.join(" ");
}
