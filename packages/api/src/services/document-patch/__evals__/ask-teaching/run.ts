/**
 * Score a model's outputs against `prompts.json`. No model call here: generate
 * the outputs yourself (one document per prompt id) into a JSON file
 * `{ "<prompt id>": "<markdown the model wrote>" }`, then:
 *
 *   pnpm --filter @synap/api exec tsx \
 *     src/services/document-patch/__evals__/ask-teaching/run.ts outputs.json
 *
 * Exit 1 when any prompt fails. Not run against a live model yet (NEEDS-DOGFOOD).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAll, type EvalPrompt } from "./check.js";

const here = dirname(fileURLToPath(import.meta.url));
const prompts = JSON.parse(
  readFileSync(resolve(here, "prompts.json"), "utf8")
) as EvalPrompt[];
const file = process.argv[2];
if (!file) {
  console.error("usage: run.ts <outputs.json>");
  process.exit(2);
}
const outputs = JSON.parse(readFileSync(file, "utf8")) as Record<
  string,
  string
>;
const { verdicts, passed, total } = checkAll(prompts, outputs);
for (const v of verdicts)
  console.log(`${v.pass ? "PASS" : "FAIL"} ${v.id}: ${v.reason}`);
console.log(`${passed}/${total} passed`);
process.exit(passed === total ? 0 : 1);
