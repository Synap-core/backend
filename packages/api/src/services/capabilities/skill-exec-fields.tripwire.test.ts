/**
 * "Execution-defining content" must have exactly ONE definition.
 *
 * It had two. `skillsRouter.update` demoted an approved skill on any of SIX
 * fields (code/providerSpec/parameters/executionMode/timeoutSeconds/kind); the
 * template applier in `create-from-definition.ts` demoted on THREE
 * (kind/code/providerSpec) while its own comment claimed it was the "same rule
 * skillsRouter.update enforces". The gap was the very hole the 2026-07-12
 * security review opened it for: a drifted CP template could change an approved
 * skill's `parameters`, `executionMode` or `timeoutSeconds` and the row stayed
 * approved (content-swap-under-approval).
 *
 * Two halves are pinned here, because either one alone passes vacuously:
 *   1. VALUE semantics — a byte-identical re-apply must NOT demote. The applier
 *      rewrites every definition-owned field on every reconcile pass, so a
 *      presence test (or a raw stringify over jsonb, whose key order PG does not
 *      preserve) would demote a market-installed skill on every boot.
 *   2. SOURCE parity — the applier must reach the decision THROUGH the shared
 *      helper, over a patch covering every `RE_APPROVAL_FIELDS` key, and every
 *      such key must be one the applier's `.set({...})` actually writes.
 *      Re-listing the fields inline (the original defect) fails here by name.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  RE_APPROVAL_FIELDS,
  skillExecFieldsChanged,
} from "./skill-exec-fields.js";

const here = dirname(fileURLToPath(import.meta.url));
const applierSrc = readFileSync(
  join(here, "create-from-definition.ts"),
  "utf8"
);

/** Keys of the object literal starting at `from` (balanced-brace scan, depth 1 only). */
function topLevelKeys(src: string, from: number): string[] {
  const open = src.indexOf("{", from);
  expect(open, "object literal not found").toBeGreaterThan(-1);
  let depth = 0;
  const keys: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i));
      if (
        m &&
        (src[i - 1] === "," || src[i - 1] === "{" || src[i - 1] === "\n")
      ) {
        keys.push(m[1]);
      }
    }
  }
  return keys;
}

describe("skillExecFieldsChanged — value semantics", () => {
  // The exact shape the applier replays: definition defaults resolved, jsonb
  // read back from PG with its keys in a DIFFERENT order than they were written.
  const definitionPatch = {
    kind: "code",
    code: "return 1;",
    providerSpec: null,
    parameters: { type: "object", properties: { a: { type: "string" } } },
    executionMode: "sync",
    timeoutSeconds: 30,
  };
  const liveRowSameContent = {
    kind: "code",
    code: "return 1;",
    providerSpec: null,
    // key order flipped, as jsonb hands it back
    parameters: { properties: { a: { type: "string" } }, type: "object" },
    executionMode: "sync",
    timeoutSeconds: 30,
    approved: true,
    body: null,
  };

  it("a byte-identical re-apply does NOT demote", () => {
    expect(skillExecFieldsChanged(definitionPatch, liveRowSameContent)).toBe(
      false
    );
  });

  it.each([
    ["code", "return 2;"],
    ["providerSpec", { baseUrl: "https://evil.example" }],
    ["parameters", { type: "object", properties: { b: { type: "string" } } }],
    ["executionMode", "async"],
    ["timeoutSeconds", 60],
    ["kind", "declarative"],
  ])("a changed %s DOES demote", (field, value) => {
    expect(
      skillExecFieldsChanged(
        { ...definitionPatch, [field]: value },
        liveRowSameContent
      )
    ).toBe(true);
  });

  it("an absent key is not a change", () => {
    expect(skillExecFieldsChanged({}, liveRowSameContent)).toBe(false);
  });
});

describe("create-from-definition applier uses the ONE shared rule", () => {
  const WHY =
    "The template applier must decide demotion via skillExecFieldsChanged over a " +
    "patch covering every RE_APPROVAL_FIELDS key. Re-listing the fields inline is " +
    "how kind/code/providerSpec drifted apart from the router's six-field rule and " +
    "left parameters/executionMode/timeoutSeconds swappable under an approval.";

  // WHITESPACE-INSENSITIVE on purpose. This was a single-line `indexOf` of
  // "const execContentChanged = skillExecFieldsChanged(" until 2026-09-06, when
  // the formatter wrapped the assignment across two lines and BOTH tests below
  // went red against an applier that was, and still is, correct. A guard that
  // fails on reformatting is not measuring the invariant it names — and the
  // false red is the dangerous half, because the cheap way to clear it is to
  // "fix" correct source. Match the CALL, not its line breaks.
  const callMatch =
    /const\s+execContentChanged\s*=\s*skillExecFieldsChanged\s*\(/.exec(
      applierSrc
    );
  const callIdx = callMatch ? callMatch.index : -1;

  it("computes execContentChanged through skillExecFieldsChanged", () => {
    expect(callIdx, WHY).toBeGreaterThan(-1);
  });

  it("passes a patch covering every RE_APPROVAL_FIELDS key", () => {
    const keys = topLevelKeys(applierSrc, callIdx);
    for (const f of RE_APPROVAL_FIELDS) expect(keys, WHY).toContain(f);
  });

  it("only compares fields the applier's own update actually writes", () => {
    const written = topLevelKeys(
      applierSrc,
      applierSrc.indexOf(".set(", applierSrc.indexOf(".update(skillsTable)"))
    );
    for (const f of RE_APPROVAL_FIELDS) {
      expect(
        written,
        `${f} is compared but never written — the comparator would demote on a ` +
          `difference the applier never converges. ${WHY}`
      ).toContain(f);
    }
  });
});
