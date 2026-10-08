/**
 * TRIPWIRE — the two composite-op mirrors stay in lock-step (Rule Loop ops).
 *
 * `CompositeProposalOperation` is declared TWICE:
 *   - `synap-backend/packages/types/src/proposals/index.ts` (server, owns the
 *     ref-resolution helpers and is what the materializer consumes),
 *   - `synap-app/packages/core/proposal-types/src/types.ts` (browser-safe, so
 *     frontend packages can narrow without a runtime dep on the server entry).
 *
 * A vocabulary declared in two places where only one gets updated is this
 * repo's most repeated defect, and it has already bitten on op payloads: the
 * DeclarativeBlock seam-fork shipped a backend `type`/`string[]`/`action`
 * against a browser `kind`/`{label,value}`/`actionId` — same outer name,
 * different INTERNAL shape, blank render, `as any` hiding it from tsc. So this
 * test compares FIELD SIGNATURES, not just op names.
 *
 * SCOPE — DERIVED, not hand-listed: every op the BROWSER mirror declares must
 * be declared by the server with identical fields, except the classified
 * {@link DELIBERATELY_ASYMMETRIC} ops. A new mirrored op (as `create_playbook`
 * was) joins the check by existing; an op mirrored on one side only fails.
 * `create_entity` / `create_relation` were already DELIBERATELY asymmetric
 * before this test existed (the server op carries `facets`,
 * `existingEntityId`, `targetWorkspaceId`, … that the browser mirror has no use
 * for). Pinning those would fail on day one and be silenced, which is worse
 * than not pinning them.
 *
 * NOT covered: a server op the browser does not mirror at all (today the plan
 * ops `create_session` / `create_document` / `create_project` / `create_link`)
 * — the browser cannot narrow to a payload it never declared, so there is no
 * seam to fork.
 *
 * Cross-repo, guarded like `cp-pod-package-schema-parity`: when `synap-app` is
 * not checked out beside `synap-backend`, the parity assertions are skipped
 * rather than reading an empty string and reporting green.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** `src/__tripwires__` → src → api → packages → synap-backend → multi-repo root. */
const REPO_ROOT = join(import.meta.dirname, "../../../../..");

const SERVER_TYPES = join(
  REPO_ROOT,
  "synap-backend/packages/types/src/proposals/index.ts"
);
const BROWSER_TYPES = join(
  REPO_ROOT,
  "synap-app/packages/core/proposal-types/src/types.ts"
);

/** Mirrored on both sides on purpose with DIFFERENT shapes (see the header). */
const DELIBERATELY_ASYMMETRIC: ReadonlySet<string> = new Set([
  "create_entity",
  "create_relation",
]);

/** Strip comments so prose can never be read as a field signature. */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Map `op` discriminant → normalised field signatures of the interface that
 * declares it. Field text is whitespace-collapsed so formatting differences
 * (prettier wrapping a long union) are not reported as drift.
 */
function opFieldSignatures(file: string): Map<string, string[]> {
  const src = strip(readFileSync(file, "utf8"));
  const out = new Map<string, string[]>();
  for (const m of src.matchAll(/export interface (\w+) \{([\s\S]*?)\n\}/g)) {
    const body = m[2]!;
    const discriminant = body.match(/\bop:\s*"([\w_]+)"/);
    if (!discriminant) continue;
    const fields = body
      .split(";")
      .map((f) => f.replace(/\s+/g, " ").trim())
      .filter((f) => f.length > 0 && !f.startsWith("op:"))
      .sort();
    out.set(discriminant[1]!, fields);
  }
  return out;
}

const bothCheckedOut = existsSync(SERVER_TYPES) && existsSync(BROWSER_TYPES);

describe("tripwire: mirrored composite ops mirror each other exactly", () => {
  it("the server declaration exists at the path this test parses", () => {
    expect(
      existsSync(SERVER_TYPES),
      `${SERVER_TYPES} does not exist — it moved. Update the constant; do NOT ` +
        "let this tripwire parse nothing and report green."
    ).toBe(true);
  });

  it("SELF-GUARD: the parser reads a non-trivial corpus from the server file", () => {
    const server = opFieldSignatures(SERVER_TYPES);
    expect(server.size).toBeGreaterThanOrEqual(5);
    expect(server.get("create_relation")).toContain("sourceRef: string");
  });

  it.runIf(bothCheckedOut)(
    "SELF-GUARD: the derived set covers the mirrored ops, and every exemption is still mirrored",
    () => {
      const browser = opFieldSignatures(BROWSER_TYPES);
      const checked = [...browser.keys()].filter(
        (op) => !DELIBERATELY_ASYMMETRIC.has(op)
      );
      for (const op of [
        "create_skill",
        "create_automation",
        "create_rule",
        "create_playbook",
      ]) {
        expect(checked, `${op} is no longer in the checked set`).toContain(op);
      }
      // A stale exemption silently widens what this test lets through.
      for (const op of DELIBERATELY_ASYMMETRIC)
        expect(browser.has(op)).toBe(true);
    }
  );

  it.runIf(bothCheckedOut)(
    "every op the browser mirrors is declared by the server with identical fields",
    () => {
      const server = opFieldSignatures(SERVER_TYPES);
      const browser = opFieldSignatures(BROWSER_TYPES);
      for (const op of browser.keys()) {
        if (DELIBERATELY_ASYMMETRIC.has(op)) continue;
        expect(
          server.get(op),
          `${op} missing from the server union`
        ).toBeDefined();
        expect(
          browser.get(op),
          `${op} missing from the browser mirror`
        ).toBeDefined();
        expect(
          { op, fields: browser.get(op) },
          `The two \`CompositeProposalOperation\` mirrors disagree on the ` +
            `INTERNAL shape of \`${op}\`. Same op name, different payload = a ` +
            `seam fork: the browser narrows to a field the server never sends ` +
            `(or vice versa) and tsc stays green on both sides.`
        ).toEqual({ op, fields: server.get(op) });
      }
    }
  );
});
