/**
 * TRIPWIRE — `synap_needs_you` says where a proposed decision shows up.
 *
 * `synap_create_entity` promises that a `decision` created `proposed` asks the
 * person (the decision-ask reactor files ONE owed slot with
 * `blockedReason: 'decision'`). The needs-you read shows that ask as an
 * owed-slot row in `count.blocked`, while `count.decisions` counts pending
 * PROPOSAL clusters (`countNeedsYou`). On 21 Nov 2026 an agent read
 * `"decisions":0` after creating 5 proposed decisions and reported that none
 * had asked, though all 5 were open asks (pod document 3b31c596, item 4).
 *
 * So the needs_you description names both, and the wait kind it names is the
 * one the slot's reason really maps to (`WAIT_KIND_FROM.blockedReason`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WAIT_KIND_FROM } from "@synap-core/types/units";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(
    resolve(here, "../routers/mcp/tools/mcp-tools.manifest.json"),
    "utf8"
  )
) as { tools: Array<{ name: string; description: string }> };

const description = (name: string): string => {
  const tool = manifest.tools.find((t) => t.name === name);
  expect(tool, `${name} is in the manifest`).toBeDefined();
  return tool!.description;
};

describe("tripwire: needs_you teaches where a proposed decision asks", () => {
  it("create_entity still promises that a proposed decision asks", () => {
    expect(description("synap_create_entity")).toContain(
      "`decisionStatus:'proposed'` ASKS the person automatically"
    );
  });

  it("needs_you says count.decisions is proposals, and where the ask is", () => {
    const text = description("synap_needs_you");
    expect(text).toContain("`count.decisions` is pending proposals only");
    expect(text).toContain(
      `owed-slot row (\`waitKind: '${WAIT_KIND_FROM.blockedReason.decision}'\`, in \`count.blocked\`)`
    );
  });
});
