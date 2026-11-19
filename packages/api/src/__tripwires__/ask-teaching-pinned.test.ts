/**
 * TRIPWIRE — what the document tools teach about asks cannot drift from the
 * skill that holds the syntax. The `synap_create_document` and
 * `synap_update_document` descriptions carry ONE line pointing at
 * `system/synap/document-embeds`; that skill must hold the section it points
 * to, and its two worked examples must be real, valid question definitions
 * (the same parser the write door runs). The write-time nudge names the pod
 * skill `reports/rich-documents`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planAskDefinitions } from "../services/document-patch/materialize-asks.js";
import { ASK_NUDGE } from "../services/document-patch/ask-nudge.js";

const here = dirname(fileURLToPath(import.meta.url));
const LINE =
  'Needs the person\'s decision? Embed a `:::synap-ask` block, not a prose question (synap_load_skill("system/synap/document-embeds")).';

const manifest = JSON.parse(
  readFileSync(
    resolve(here, "../routers/mcp/tools/mcp-tools.manifest.json"),
    "utf8"
  )
) as { tools: Array<{ name: string; description: string }> };
const skill = readFileSync(
  resolve(here, "../../../../skills/synap/document-embeds.md"),
  "utf8"
);

describe("tripwire: document tools teach asks, pinned to the skill", () => {
  for (const name of ["synap_create_document", "synap_update_document"]) {
    it(`${name} carries the one-line ask teaching`, () => {
      const t = manifest.tools.find((x) => x.name === name)!;
      expect(t.description).toContain(LINE);
    });
  }
  it("the skill holds the section the line points to", () => {
    expect(skill).toContain("### Asking the person: a `synap-ask` block");
  });
  it("the skill's examples are valid question definitions", () => {
    const section = skill
      .split("### Asking the person")[1]!
      .split("### Charts")[0]!;
    const fence = /````\n([\s\S]*?)\n````/.exec(section)![1]!;
    const plan = planAskDefinitions([fence]);
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.plans.map((p) => p.ask.mode)).toEqual([
      "confirm",
      "choose",
    ]);
  });
  it("the nudge names the pod skill", () => {
    expect(ASK_NUDGE).toContain("reports/rich-documents");
  });
});
