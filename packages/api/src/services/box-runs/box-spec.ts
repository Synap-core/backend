/**
 * The box declaration of a box skill (`skills.execution_mode = 'box'`,
 * `skills.metadata.box`). The RULE (language, exact package pins, hosts,
 * limits, and the one parser every door uses) lives in
 * `@synap-core/types/skill-box`, shared with the catalog validator; this file
 * keeps what needs the pod: the run snapshot a queue stores
 * (`boxRunSpecFor`) and the review line the person approves
 * (`describeBoxDeclaration`: the packages and the hosts the script may reach).
 */

import type { BoxRunSpec } from "@synap/database/schema";
import {
  BOX_LIMITS as BOX_LIMITS_RULE,
  parseBoxDeclaration,
  type BoxDeclaration,
} from "@synap-core/types/skill-box";

export {
  BOX_LANGUAGES,
  BoxDeclarationSchema,
  parseBoxDeclaration,
  type BoxDeclaration,
  type BoxLanguage,
} from "@synap-core/types/skill-box";

/** The limits a declaration may carry are exactly the limits a run snapshot stores. */
export const BOX_LIMITS = BOX_LIMITS_RULE satisfies Record<
  keyof BoxRunSpec["limits"],
  readonly number[]
>;

/** The run snapshot `box_runs.spec` stores, from a skill row. */
export function boxRunSpecFor(skill: {
  name: string;
  code: string | null;
  metadata: unknown;
}): { ok: true; spec: BoxRunSpec } | { ok: false; error: string } {
  if (!skill.code?.trim()) {
    return {
      ok: false,
      error: `Box skill "${skill.name}" has no code to run.`,
    };
  }
  const meta =
    skill.metadata && typeof skill.metadata === "object"
      ? (skill.metadata as Record<string, unknown>)
      : {};
  const parsed = parseBoxDeclaration(meta.box);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `Box skill "${skill.name}" has no valid box declaration (${parsed.error}).`,
    };
  }
  return {
    ok: true,
    spec: { name: skill.name, code: skill.code, ...parsed.box },
  };
}

/**
 * The review line: what the person approves besides the code. Read by the
 * proposal summary (`permission-check.ts`) and the review card.
 */
export function describeBoxDeclaration(box: BoxDeclaration): string {
  const pkgs = box.packages.length
    ? box.packages.map((p) => `${p.name}==${p.version}`).join(", ")
    : "no packages";
  const hosts = box.hosts.length
    ? `may reach ${box.hosts.join(", ")}`
    : "reaches no host";
  return `runs on your computer in a box (${box.language}, ${pkgs}; ${hosts}; up to ${Math.round(box.limits.wallSeconds / 60)} min)`;
}
