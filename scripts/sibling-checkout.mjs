/**
 * sibling-checkout.mjs — THE way a test finds a sibling repo's checkout.
 * =====================================================================
 *
 * Cross-repo guards read source from repos that live beside this one
 * (synap-app, synap-control-plane-api, …). A hard-coded `../../../../../<repo>`
 * breaks the moment the layout differs from one developer's machine: a git
 * worktree sits under `.claude/worktrees/<name>`, the directories may carry the
 * GitHub repo names (`app-bases`, `control-plane-api`) instead of the package
 * names, and CI checks out this repo alone.
 *
 * Resolution order, first existing directory wins:
 *   1. the env var named for the repo (`SIBLING_ENV`), e.g. SYNAP_APP_DIR;
 *   2. beside this checkout, under each known directory name;
 *   3. beside the MAIN checkout, when this one is a `.claude/worktrees/*` copy;
 *   4. under `synap-workspace-root/` next to either of those.
 *
 * `null` means "not here". What to do then is the CALLER's policy: a guard that
 * CI provides the sibling for asserts it (`siblingRequired()`), a local-only
 * guard skips with the reason this module formats (`siblingSkipReason`).
 *
 * Self-contained on purpose (node: imports only), like strip-comments.mjs.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The root of THIS checkout (the directory holding `scripts/`). */
export const BACKEND_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);

/** Every directory name a repo is checked out under, and its override var. */
export const SIBLINGS = {
  "synap-app": { env: "SYNAP_APP_DIR", names: ["synap-app", "app-bases"] },
  "synap-control-plane-api": {
    env: "SYNAP_CONTROL_PLANE_DIR",
    names: ["synap-control-plane-api", "control-plane-api"],
  },
};

const WORKTREES = `${sep}.claude${sep}worktrees${sep}`;

/** The checkouts whose parent may hold siblings: this one, then the main one. */
function checkoutRoots() {
  const roots = [BACKEND_ROOT];
  const at = BACKEND_ROOT.indexOf(WORKTREES);
  if (at !== -1) roots.push(BACKEND_ROOT.slice(0, at));
  return roots;
}

/** Absolute root of `repo`'s checkout, or null when none is present. */
export function siblingCheckout(repo) {
  const known = SIBLINGS[repo];
  if (!known) throw new Error(`unknown sibling repo: ${repo}`);
  const override = process.env[known.env];
  if (override) {
    if (existsSync(override)) return resolve(override);
    // An override that points nowhere would otherwise read exactly like "no
    // checkout here", hiding a typo behind the generic skip/fail message.
    console.warn(
      `[sibling-checkout] ${known.env} is set to ${override}, which does not exist; ` +
        `treating ${repo} as absent.`
    );
    return null;
  }
  for (const root of checkoutRoots()) {
    const parent = dirname(root);
    for (const name of known.names) {
      for (const candidate of [
        join(parent, name),
        join(parent, "synap-workspace-root", name),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * Whether an absent sibling is a FAILURE here. CI provides the siblings its
 * guards need, so there an absence is a broken pipeline, never a skip.
 * `SYNAP_ISOLATED_CHECKOUT=1` is the explicit acknowledgement for a
 * backend-only run.
 */
export function siblingRequired() {
  return Boolean(process.env.CI) && process.env.SYNAP_ISOLATED_CHECKOUT !== "1";
}

/** The line a skipped guard prints, naming what is missing and how to fix it. */
export function siblingSkipReason(repo, guard) {
  const known = SIBLINGS[repo];
  return (
    `[${guard}] SKIP: no ${repo} checkout found beside ${BACKEND_ROOT} ` +
    `(looked for ${known.names.join(" / ")}). Clone it there or set ${known.env}.`
  );
}
