/**
 * The capability manifest's computer blocks: ONE leaf for where a capability
 * runs and how a computer installs, checks and removes it (installer
 * reconciliation f75fbb48 §3.5, founder 2026-11-07). The catalog
 * (`synap-app/packages/workspace-templates/schema/computer.ts` +
 * `recipe.ts`) authors these fields; `computer.ts` and `recipe.ts` here are
 * the same rule, ported as they stand there, so a manifest the catalog
 * accepts the pod accepts too.
 *
 *   placement    where: runsOn (pod | computer), prefer, platforms, labels,
 *                requires; the ONE `runsOn` enum
 *   install      per OS steps (a `tool`)          services   containers by
 *   verify       per OS check, reverifyEvery                 digest (a
 *   uninstall    per OS steps                                `service`)
 *   permissions  folders, hosts, devices          licence    SPDX expression
 *   recipes      stored media operations a tool runs
 *
 * The installation's kind is DERIVED ({@link installKind}): `services` makes
 * a `service`, `install.<os>` a `tool`, both is refused.
 *
 * Pure (zod only): no database, no Node API.
 */

import { z } from "zod";
import {
  COMPUTER_CAPABILITY_FIELDS,
  computerOses,
  computerPlacementProblems,
  installSchema,
  licenceSchema,
  permissionsSchema,
  placementSchema,
  servicesSchema,
  uninstallSchema,
  verifySchema,
  type ComputerOs,
} from "./computer.js";
import { recipeSchema } from "./recipe.js";

export * from "./computer.js";
export * from "./recipe.js";

/** Every key this leaf adds to a capability definition. */
export const CAPABILITY_COMPUTER_KEYS = [
  ...COMPUTER_CAPABILITY_FIELDS,
  "recipes",
] as const;
export type CapabilityComputerKey = (typeof CAPABILITY_COMPUTER_KEYS)[number];

/**
 * The computer blocks of one capability, checked as the catalog checks them
 * (`computerPlacementProblems`), plus: an installable capability is a `tool`
 * or a `service`, never both; recipes run on a computer.
 */
export const CapabilityComputerSpecSchema = z
  .object({
    placement: placementSchema.optional(),
    install: installSchema.optional(),
    verify: verifySchema.optional(),
    uninstall: uninstallSchema.optional(),
    permissions: permissionsSchema.optional(),
    licence: licenceSchema.optional(),
    services: servicesSchema.optional(),
    recipes: z.array(recipeSchema).optional(),
  } satisfies { [K in CapabilityComputerKey]-?: z.ZodTypeAny })
  .strict()
  .superRefine((spec, ctx) => {
    for (const [path, message] of computerPlacementProblems(spec))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (spec.recipes && !spec.placement?.runsOn.includes("computer"))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipes"],
        message: 'recipes run on a computer: add placement.runsOn ["computer"]',
      });
  });
export type CapabilityComputerSpec = z.infer<
  typeof CapabilityComputerSpecSchema
>;

/**
 * The computer blocks a definition declares, or null when it declares none.
 * The applier stores them on the installed capability as
 * `metadata.computer`, verbatim (recipes included).
 */
export function pickComputerSpec(
  def: Record<string, unknown>
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const key of CAPABILITY_COMPUTER_KEYS)
    if (def[key] !== undefined) out[key] = def[key];
  return Object.keys(out).length > 0 ? out : null;
}

/** What a computer says about itself, for the placement check. */
export interface ComputerFacts {
  /** Node's `process.platform` as the computer reported it at enrolment. */
  os: string | null;
  /** Node's `process.arch`, when known. */
  arch: string | null;
}

/**
 * Can this capability be installed on this computer? A reason in plain words
 * when it cannot, null when it can. The capability must run on a computer,
 * be valid by the one rule (which makes it a `tool` or a `service`), and its
 * `placement` must list the computer's OS (and arch, when the platform names
 * arches). A computer whose OS is not
 * known is not refused here: its runner checks again before any step runs.
 */
export function placementRefusal(
  spec: Record<string, unknown>,
  computer: ComputerFacts
): string | null {
  const runsOn = (spec.placement as { runsOn?: unknown } | undefined)?.runsOn;
  if (!Array.isArray(runsOn) || !runsOn.includes("computer"))
    return "It runs on the pod, not on a computer.";
  const parsed = CapabilityComputerSpecSchema.safeParse(spec);
  if (!parsed.success) return "Its install steps are not valid.";
  const s = parsed.data;
  if (!computer.os) return null;
  const oses: ComputerOs[] = computerOses(s);
  if (!(oses as string[]).includes(computer.os))
    return `It does not run on this computer's system (${computer.os}).`;
  const platform = s.placement?.platforms?.find((p) => p.os === computer.os);
  const arches: readonly string[] | undefined = platform?.arch;
  if (computer.arch && arches?.length && !arches.includes(computer.arch))
    return `It does not run on this computer's processor (${computer.arch}).`;
  return null;
}
