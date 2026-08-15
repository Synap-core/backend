import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — a `tools` row looked up BY NAME must always be scoped (workspace
 * lens, ORDER BY, or an explicit selection key), never an unscoped
 * `findFirst`/single-row `select`.
 *
 * This pod had TWO `tools` rows named `discord` (one per workspace).
 * `run-event-sync.ts` and `run-gcal-import.ts` both did:
 *   db.query.tools.findFirst({ where: eq(tools.name, "discord") })
 * — no workspace filter, no user filter, no ORDER BY. Postgres returned an
 * arbitrary row: the operator toggled event sync ON via the Discord bridge
 * (which writes/reads ITS workspace's row), and the cron read the OTHER
 * workspace's row and replied "skipped — it is disabled". Same command, two
 * different rows, contradictory answers.
 *
 * The audit that followed found the SAME shape in six more places: the
 * cal.com / fireflies / mailgun inbound webhook handlers (which would 404 a
 * legitimate webhook whenever the arbitrary row picked wasn't the one whose
 * secret matched) and the cal.com / fireflies backfill cron pollers + a
 * connector-health nudge (same "wrong workspace's config" mismatch as the
 * original bug). All were converged onto TWO resolver doors — one per
 * genuinely different selection strategy:
 *   - resolveTool(toolName, isEnabled, workspaceId?)
 *       (services/tools/resolve-tool.ts)
 *       Caller-workspace scoped when a workspaceId is given (never falls
 *       back across workspaces); unscoped (cron) prefers whichever row the
 *       CALLER's own `isEnabled` predicate marks true, else the oldest. The
 *       predicate is supplied by the caller, not hard-coded — an earlier
 *       version hard-coded a discord-eventSync-specific predicate that a
 *       DIFFERENT caller (mail-feed) also used as its tie-break while
 *       gating on a different flag, reproducing the original incident
 *       INSIDE the fix for it. Shared by discord event-sync, discord
 *       mail-feed, cal.com backfill, and fireflies backfill.
 *   - resolveToolByWebhookToken(toolName, domainKey, token)
 *       (services/webhooks/resolve-tool-by-webhook-token.ts)
 *       Selects by matching a presented secret — a different question from
 *       selecting by scope/enabled-state.
 * Do not merge these two into one "does everything" resolver — that
 * produces a function with mutually-exclusive modes, which is worse than two
 * small doors. Each does `findMany` + a DETERMINISTIC selection instead of
 * trusting arbitrary heap order.
 *
 * If this fails: route the new lookup through the matching resolver door
 * above (or add a new one following the same shape) instead of hand-rolling
 * a `tools`-by-name lookup.
 *
 * SCOPE: lookups by `tools.id` (the PK — inherently unambiguous) or by
 * `tools.credentialRef` (globally unique under the 0140 index) are NOT this
 * bug and are not matched here. A name-keyed query that also explicitly
 * folds in a workspace scope (`external-dispatch.ts`, `channel-origin.ts` —
 * `and(eq(tools.name,…), <scope>)` via `.select()`) is the documented safe
 * shape and is exempt — but ONLY when the scope condition is actually
 * present; an unscoped single-row `.select().from(tools).where(eq(tools.name,
 * …))` is the IDENTICAL bug wearing `.select()` instead of `findFirst`, and
 * is banned too (an earlier version of this tripwire's comment wrongly
 * claimed all `.select()` shapes were structurally safe — they are not; only
 * ones that AND in a real scope condition are).
 */

// The resolver doors themselves — the only files permitted to look a `tools`
// row up by name via an unscoped findFirst/findMany (they encapsulate the
// deterministic selection the rest of the codebase must call into). Neither
// currently matches BANNED (both use `findMany`, not `findFirst`/`.select()`)
// — listed anyway, defensively, in case a future edit on either file ever
// takes the `findFirst`/`.select()` shape.
const ALLOWLIST_SUFFIXES = [
  join("services", "tools", "resolve-tool.ts"),
  join("services", "webhooks", "resolve-tool-by-webhook-token.ts"),
];

/** Strip line + block comments so an illustrative anti-pattern IN A COMMENT
 * (e.g. this very file's own doc comment, or resolve-tool-by-webhook-token.ts's)
 * isn't mistaken for live code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// (1) `findFirst({ ...anything..., where: eq(tools.name, …), ...anything... })`
// — bounded lazy scan so `where` need not be the first property (a prior
// version of this regex required `where` immediately after `{`, so
// `findFirst({ columns: {...}, where: eq(tools.name, …) })` walked straight
// through undetected).
const BANNED_FIND_FIRST =
  /tools\.findFirst\(\s*\{[\s\S]{0,300}?where:\s*eq\(\s*tools\.name/;

// (2) an UNSCOPED single-row `.select().from(tools).where(eq(tools.name, …))`
// — the `.where(` clause's own first call is `eq(tools.name` directly, not
// `and(...)`. The safe pattern (external-dispatch.ts, channel-origin.ts)
// always wraps the name match in `and(nameOrId, scope)` — `.where(and(` — so
// this pattern does not match those files; it matches only the case with NO
// scope condition folded in at all.
const BANNED_UNSCOPED_SELECT =
  /\.from\(\s*tools\s*\)[\s\S]{0,200}?\.where\(\s*eq\(\s*tools\.name/;

function tsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

describe("tripwire: tools-by-name lookups are scoped", () => {
  it("no source file does an unscoped findFirst/select-by-name on `tools` outside a resolver door", () => {
    const srcRoot = join(process.cwd(), "src"); // api/src
    const offenders = tsFiles(srcRoot)
      .filter((f) => {
        const code = stripComments(readFileSync(f, "utf8"));
        return (
          BANNED_FIND_FIRST.test(code) || BANNED_UNSCOPED_SELECT.test(code)
        );
      })
      .map((f) => relative(srcRoot, f))
      .filter((rel) => !ALLOWLIST_SUFFIXES.some((s) => rel === s));
    expect(offenders).toEqual([]);
  });

  /**
   * The second half of the same bug. Reaching the resolver door is not enough
   * if the caller hands it a predicate that can never be true: `resolveTool(…,
   * () => false)` short-circuits straight to the oldest-by-`createdAt`
   * tie-break, so WHICH of this pod's two `discord` rows answers is decided by
   * creation order, not configuration. The IS-health / connector-health alert
   * worked only because the configured row happened to be the older one; set
   * `discord.feedbackChannel` on the newer row and the alarm goes silent with
   * no error, because the in-app notification still fires.
   *
   * If this fails: pass a predicate that tests the thing you are about to READ
   * off the row (`hasDiscordFeedbackChannel`, `isDiscordMailFeedEnabled`, …).
   * Oldest-row stays the fallback for when NO row qualifies.
   */
  it("no caller passes an always-false predicate to resolveTool", () => {
    const srcRoot = join(process.cwd(), "src");
    const ALWAYS_FALSE =
      /resolveTool\(\s*[^,]+,\s*\(\s*[^)]*\)\s*=>\s*(false|undefined|null|0|""|'')\s*[,)]/;
    const offenders = tsFiles(srcRoot)
      .filter((f) => ALWAYS_FALSE.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(srcRoot, f));
    expect(offenders).toEqual([]);
  });
});
