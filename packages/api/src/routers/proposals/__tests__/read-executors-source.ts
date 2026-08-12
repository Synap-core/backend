/**
 * Test-only helper: reconstruct the full approve-executors source surface for
 * the source-slice / AST assertions in this directory.
 *
 * Wave 1 router-decomposition split the former single `approve-executors.ts`
 * (~4.8k lines) into `./executors/<domain>.ts` modules, aggregated by
 * `registerApproveExecutors()`. Several tests here slice text between two
 * `key: "..."` markers to isolate one executor's body — that only reproduces
 * the ORIGINAL adjacency (and therefore the original slice contents) when the
 * domain files are concatenated in the same order `registerApproveExecutors()`
 * calls them, not alphabetical directory order. Keep this list in sync with
 * the `register*Executors()` call order in `../approve-executors.ts`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const EXECUTOR_FILES_IN_AGGREGATOR_ORDER = [
  "document.ts",
  "channel.ts",
  "entity.ts",
  "property-def.ts",
  "focus-session.ts",
  "project.ts",
  "view.ts",
  "profile.ts",
  "skill.ts",
  "tool.ts",
  "automation.ts",
  "playbook.ts",
  "cell.ts",
  "workspace.ts",
  "messaging.ts",
  "capability.ts",
  "provider.ts",
  "catch-all.ts",
];

/**
 * Concatenate the aggregator file + every domain module (in registration
 * order) into one blob, so `indexOf('key: "...')` / slice-based assertions
 * written against the old monolithic file keep working unchanged.
 */
export function readExecutorsSource(apiSrcDir: string): string {
  const proposalsDir = join(apiSrcDir, "routers/proposals");
  const aggregator = readFileSync(
    join(proposalsDir, "approve-executors.ts"),
    "utf8"
  );
  const domains = EXECUTOR_FILES_IN_AGGREGATOR_ORDER.map((f) =>
    readFileSync(join(proposalsDir, "executors", f), "utf8")
  ).join("\n");
  return aggregator + "\n" + domains;
}
