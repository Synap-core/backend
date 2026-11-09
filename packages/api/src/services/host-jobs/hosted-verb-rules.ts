/**
 * Hosted verbs, the rules (plan b647769e §3.2, plan 64072312 U8): which
 * computer runs a recipe, whether the recipe and its values hold, and what an
 * output file may be called. No reads: every rule is tested on its own
 * (`hosted-verb-rules.test.ts`); `hosted-verbs.ts` reads the rows and applies
 * them.
 *
 * WHO RUNS IT is not a second routing path: a hosted verb runs on a computer
 * where the capability is INSTALLED and checked (`installations`), named with
 * the same `matchComputer` an installation request uses. A recipe is never
 * sent to a computer the person did not choose, and never to one where the
 * tool is missing or failed its check.
 */

import {
  recipeSchema,
  renderRecipe,
  type Recipe,
} from "@synap-core/types/capability-manifest";
import {
  matchComputer,
  type ComputerMatch,
} from "../installations/request-installation.js";
import type { ComputerRef } from "../installations/installations.js";
import type { InstallationHealthVerdict } from "./host-jobs.js";

/** The built-in verb that runs a recipe on a computer. */
export const RUN_RECIPE_VERB = "computer.run_recipe";

/** A run waits this long for its computer, then an input link has expired. */
export const HOSTED_VERB_INPUT_URL_SECONDS = 6 * 60 * 60;

/**
 * The health verdicts a run may go to. `stale` (not checked lately) and
 * `drifted` (a version other than the approved one) still run: the runner
 * uses what is there. `failed` and `unknown` (never checked) do not.
 */
export const RUNNABLE_HEALTH: readonly InstallationHealthVerdict[] = [
  "ok",
  "stale",
  "drifted",
];

/** One installation of the capability, as the choice reads it. */
export interface RecipeRunCandidate {
  installationId: string;
  machineUserId: string;
  status: string;
  health: InstallationHealthVerdict | null;
  healthDetail: string | null;
  verifiedAt: Date | null;
  manifest: Record<string, unknown>;
}

export type RecipeRunChoice =
  | { ok: true; candidate: RecipeRunCandidate; computer: ComputerRef }
  | {
      ok: false;
      code:
        | "NOT_INSTALLED"
        | "NOT_RUNNABLE"
        | "COMPUTER_NOT_FOUND"
        | "COMPUTER_AMBIGUOUS";
      error: string;
    };

const runnable = (c: RecipeRunCandidate) =>
  c.status === "installed" &&
  c.health !== null &&
  RUNNABLE_HEALTH.includes(c.health);

/** Why this installation cannot run now, in the person's words. */
function whyNot(c: RecipeRunCandidate, name: string): string {
  if (c.status === "failed" || c.health === "failed")
    return `its last install or check failed on ${name}${c.healthDetail ? ` (${c.healthDetail})` : ""}: repair it first`;
  if (c.status !== "installed")
    return `it is ${c.status} on ${name}, not installed yet`;
  return `it has not been checked on ${name} yet`;
}

/**
 * Which computer runs the recipe. A named computer (`ref`) is matched among
 * the computers that HAVE the capability (`matchComputer`, the installation
 * request's own rungs); unnamed, the only runnable one, else the one checked
 * most recently. Never a guess between two named matches, and never a
 * computer whose tool cannot run.
 */
export function chooseRecipeComputer(input: {
  capabilityKey: string;
  candidates: readonly RecipeRunCandidate[];
  computers: readonly ComputerRef[];
  ref?: string | null;
}): RecipeRunChoice {
  const { capabilityKey, candidates, computers } = input;
  const nameOf = (id: string) =>
    computers.find((c) => c.id === id)?.name ?? "that computer";
  const installHint = `Ask for it with synap_request_installation({ capabilityKey: "${capabilityKey}" }), then run the recipe again.`;
  const live = candidates.filter((c) => c.status !== "removed");
  if (live.length === 0) {
    return {
      ok: false,
      code: "NOT_INSTALLED",
      error: `${capabilityKey} is not installed on any of your computers. ${installHint}`,
    };
  }
  const withIt = computers.filter((c) =>
    live.some((i) => i.machineUserId === c.id)
  );
  const ref = input.ref?.trim();
  if (ref) {
    const match: ComputerMatch = matchComputer(withIt, ref);
    if (match.status === "ambiguous") {
      return {
        ok: false,
        code: "COMPUTER_AMBIGUOUS",
        error: `"${ref}" names ${match.candidates.length} of your computers that have ${capabilityKey} (${match.candidates.map((c) => c.name).join(", ")}): name one exactly.`,
      };
    }
    if (match.status === "not_found") {
      const others = withIt.map((c) => c.name).join(", ");
      return {
        ok: false,
        code: "COMPUTER_NOT_FOUND",
        error: `None of your computers that have ${capabilityKey} is "${ref}". It is on: ${others}. To run it elsewhere, install it there first: ${installHint}`,
      };
    }
    const chosen = live.find((i) => i.machineUserId === match.computer.id)!;
    if (!runnable(chosen)) {
      return {
        ok: false,
        code: "NOT_RUNNABLE",
        error: `${capabilityKey} cannot run on ${match.computer.name}: ${whyNot(chosen, match.computer.name)}.`,
      };
    }
    return { ok: true, candidate: chosen, computer: match.computer };
  }
  const ready = live
    .filter(runnable)
    .filter((i) => computers.some((c) => c.id === i.machineUserId))
    .sort(
      (a, b) => (b.verifiedAt?.getTime() ?? 0) - (a.verifiedAt?.getTime() ?? 0)
    );
  const first = ready[0];
  if (!first) {
    const reasons = live
      .map((i) => whyNot(i, nameOf(i.machineUserId)))
      .join("; ");
    return {
      ok: false,
      code: "NOT_RUNNABLE",
      error: `${capabilityKey} cannot run on any of your computers now: ${reasons}.`,
    };
  }
  return {
    ok: true,
    candidate: first,
    computer: computers.find((c) => c.id === first.machineUserId)!,
  };
}

/** The recipes an approved manifest declares, each checked by the one schema. */
export function manifestRecipes(manifest: Record<string, unknown>): Recipe[] {
  // An installation stores the computer blocks flat; a catalog manifest nests
  // them under `spec`. Both are read, as the runner reads them.
  const spec =
    manifest.spec && typeof manifest.spec === "object"
      ? (manifest.spec as Record<string, unknown>)
      : manifest;
  const raw = Array.isArray(spec.recipes) ? spec.recipes : [];
  const out: Recipe[] = [];
  for (const r of raw) {
    const parsed = recipeSchema.safeParse(r);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * An output file's name: a bare file name with an extension (the tool picks
 * its format from it), never a path. The runner writes it in the job's own
 * folder.
 */
const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.[A-Za-z0-9]{1,8}$/;

export function outputNameProblem(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !OUTPUT_NAME.test(value) ||
    value.includes("..")
  )
    return 'a bare file name with an extension, such as "clip-loud.mp4" (letters, digits, . _ -; no folder)';
  return null;
}

/** The param names of a recipe that are pod files, and whether each is a list. */
export function fileParams(
  recipe: Recipe
): Array<{ name: string; many: boolean; required: boolean }> {
  return Object.entries(recipe.params)
    .filter(([, p]) => p.type === "file" || p.type === "files")
    .map(([name, p]) => ({
      name,
      many: p.type === "files",
      required: p.required === true,
    }));
}

/** The pod file ids a run's values name, per file param. */
export function fileIdsOf(
  recipe: Recipe,
  values: Record<string, unknown>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of fileParams(recipe)) {
    const v = values[f.name];
    if (v === undefined) continue;
    out[f.name] = (Array.isArray(v) ? v : [v]).map(String);
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Do these values fill this recipe? The SAME `renderRecipe` the runner calls,
 * with stand-in paths for files and outputs, so a run refused here would have
 * failed on the computer, and one accepted here renders there. Null when it
 * holds; otherwise the problem, naming the param.
 */
export function recipeValuesProblem(
  recipe: Recipe,
  values: Record<string, unknown>
): string | null {
  const stand: Record<string, unknown> = { ...values };
  for (const [name, p] of Object.entries(recipe.params)) {
    const v = values[name];
    if (v === undefined) continue;
    if (p.type === "file" || p.type === "files") {
      const ids = Array.isArray(v) ? v : [v];
      if (p.type === "file" && Array.isArray(v))
        return `${name} is one pod file id, not a list`;
      if (ids.length === 0) return `${name} names no file`;
      for (const id of ids)
        if (typeof id !== "string" || !UUID.test(id))
          return `${name} must be a pod file id (a file entity's uuid), got ${JSON.stringify(id)}`;
      stand[name] =
        p.type === "files"
          ? ids.map((_, i) => `/run/in/${name}-${i}`)
          : `/run/in/${name}`;
    } else if (p.type === "output") {
      const bad = outputNameProblem(v);
      if (bad) return `${name} must be ${bad}`;
      stand[name] = `/run/out/${v as string}`;
    }
  }
  try {
    renderRecipe(recipe, stand, {
      workdir: "/run",
      scripts: Object.fromEntries(
        (recipe.scripts ?? []).map((s) => [s.name, `/run/scripts/${s.name}`])
      ),
    });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** A file name safe to write a downloaded input under (its title, cleaned). */
export function inputFileName(
  title: string | null,
  fallback: string,
  index: number
): string {
  const base = (title ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(-100);
  const name = base && /\.[A-Za-z0-9]{1,8}$/.test(base) ? base : `${fallback}`;
  return `${index}-${name}`;
}
