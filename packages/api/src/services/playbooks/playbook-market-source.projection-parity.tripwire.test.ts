/**
 * The playbook reconcile must manage EVERY definition field the applier writes.
 *
 * Invariant 2 (backend-rules.md): the managed field set is DERIVED from the
 * applier's projection, never hand-maintained apart from it. The applier writes
 * a package playbook as
 *   caller.create({ ...projected, <unmanaged + caller keys> })
 * where `projected = projectPlaybookDefinition(...)` iterates
 * `PLAYBOOK_MANAGED_FIELDS` — so the baseline stamped from `projected` is exactly
 * what was written. The hole this closes: someone adds `foo: p.foo` straight
 * into that literal. It would be WRITTEN on install but never baselined, never
 * compared, so a template change to `foo` could never reach an installed pod —
 * silently, the same class of defect that sent capability `intent` to zero pods.
 *
 * Parsed out of the applier's own source (the capability-drift parity idiom).
 * The compile-time floor in playbook-market-source.ts covers the other half
 * (a new SCHEMA field must be classified before the build passes).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLAYBOOK_MANAGED_FIELDS,
  PLAYBOOK_UNMANAGED_FIELDS,
} from "./playbook-market-source.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Keys of the create call that are not definition fields at all. */
const CALLER_KEYS = ["agentUserId", "source"];

function applierCreateLiteral(): string {
  const src = readFileSync(
    join(here, "../package-apply-post-workspace.ts"),
    "utf8"
  );
  const pbStep = src.indexOf("// ── Playbooks ──");
  expect(pbStep, "applier playbooks step not found").toBeGreaterThan(-1);
  const start = src.indexOf("await caller.create({", pbStep);
  expect(start, "playbook create call not found").toBeGreaterThan(-1);
  const end = src.indexOf("\n        });", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function topLevelKeys(literal: string): string[] {
  const keys: string[] = [];
  for (const line of literal.split("\n")) {
    // `key: value` or shorthand `key,` — both write a field.
    const m = /^ {10}(\w+)\s*(?::|,$)/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

describe("playbook reconcile — projection parity with the applier", () => {
  const literal = applierCreateLiteral();
  const keys = topLevelKeys(literal);

  it("can still read the applier's create literal (non-vacuity)", () => {
    expect(keys).toContain("name");
    expect(keys).toContain("agentUserId");
    expect(keys.length).toBeGreaterThanOrEqual(4);
  });

  it("the managed fields reach create ONLY through the projection spread", () => {
    expect(literal).toMatch(/^\s+\.\.\.projected,$/m);
    const src = readFileSync(
      join(here, "../package-apply-post-workspace.ts"),
      "utf8"
    );
    expect(src).toMatch(/const projected = projectPlaybookDefinition\(/);
    // …and the baseline is stamped from that same object.
    expect(src).toMatch(/stampPlaybookMarketSource\(p\.metadata, projected,/);
  });

  it("every other key the applier writes is classified UNMANAGED (with a reason)", () => {
    const allowed = new Set<string>([
      ...PLAYBOOK_UNMANAGED_FIELDS,
      ...CALLER_KEYS,
    ]);
    const unclassified = keys.filter((k) => !allowed.has(k));
    expect(
      unclassified,
      "A definition field written outside `...projected` is never baselined, " +
        "so a template change to it can never reach an installed playbook. " +
        "Add it to PLAYBOOK_MANAGED_FIELDS (playbook-market-source.ts) and let " +
        "the projection write it — or classify it UNMANAGED with a reason."
    ).toEqual([]);
    // No managed field may ALSO be written explicitly (it would bypass the
    // projection's undefined-omission and could disagree with the baseline).
    expect(
      keys.filter((k) =>
        (PLAYBOOK_MANAGED_FIELDS as readonly string[]).includes(k)
      )
    ).toEqual([]);
  });
});
