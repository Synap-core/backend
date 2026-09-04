/**
 * TRIPWIRE — a composite batch may not be governed by ONE pair alone.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * `checkPermissionOrPropose` takes exactly ONE `(subjectType, action)` pair, and
 * every governance floor is a pure function of it. A composite batch is
 * heterogeneous — `create_entity` + `create_relation` + (soon) skill/automation/
 * rule ops — so one pair cannot speak for all of them.
 *
 * `deriveGatePairFromOperations` picks the strictest member by STRUCTURAL floor
 * (admin > destructive > rest), which is sound as far as it goes. Its last tier
 * consults the SHIPPED `DEFAULT_AUTO_APPROVE`, while the live verdict consults
 * the workspace's EFFECTIVE list. No composite pair is in the shipped default,
 * so they all tie there and the winner falls through to a blast-radius
 * tiebreak — an ordering of CONSEQUENCE, not of POLICY. Measured:
 *
 *   ops [create_entity, create_relation], workspace widened to "entity.create"
 *     derived entity/create   -> execute
 *     member  relation/create -> propose      <-- written UNGOVERNED
 *
 * ── Why the fix is not "rank harder" ───────────────────────────────────────
 * Reading `autoApproveFor` at the gate to rank is a DECISION read, and
 * `autoapprovefor-decision-ssot.test.ts` forbids it — correctly, since a second
 * policy reader is how the governance store forks. The only sound instrument is
 * to ask the RESOLVER about every member and let ANY propose force the batch.
 *
 * ── The invariant ──────────────────────────────────────────────────────────
 * Every gate call that passes a composite `data.operations` batch must EITHER
 *   (a) force a proposal unconditionally (`forcePropose: true` — nothing can be
 *       under-gated when nothing auto-executes), OR
 *   (b) evaluate every member (`captureGraphEventKeys` + a per-key resolver
 *       call) and force a proposal when any member would propose.
 *
 * A door doing neither is trusting one pair to speak for a batch it does not
 * cover. If this fails, do NOT add the file to an ignore list — pick (a) or (b).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const API_SRC = join(__dirname, "..");

/** Source files, excluding tests and any stale worktree copy of the repo. */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".claude")
      continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      collectSources(abs, out);
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.includes(".tripwire.")
    ) {
      out.push(abs);
    }
  }
  return out;
}

/** Extract each `checkPermissionOrPropose(` argument list by balanced parens. */
function gateCallBodies(src: string): string[] {
  const bodies: string[] = [];
  const needle = "checkPermissionOrPropose(";
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) break;
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    bodies.push(src.slice(at, i + 1));
    from = i + 1;
  }
  return bodies;
}

describe("TRIPWIRE: a composite batch is evaluated per member, not by one pair", () => {
  const files = collectSources(API_SRC);

  it("scans a real, non-empty corpus of gate calls", () => {
    const total = files.reduce(
      (n, f) => n + gateCallBodies(readFileSync(f, "utf8")).length,
      0
    );
    // Well under the real count; a floor, not a pin. If this trips, the
    // extractor stopped matching and every assertion below is vacuous.
    expect(
      total,
      "found (almost) no checkPermissionOrPropose calls — the extractor is broken and this tripwire proves nothing"
    ).toBeGreaterThan(20);
  });

  it("every composite gate call forces a proposal or evaluates every member", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Cheap per-file precondition: a door that never evaluates members and
      // never forces must at least MENTION one of them somewhere in the file.
      const evaluatesMembers = src.includes("captureGraphEventKeys");
      for (const body of gateCallBodies(src)) {
        // Only composite batches are in scope.
        if (!/\boperations\s*:/.test(body)) continue;
        // A door may set `forcePropose` inline OR inherit it from a spread
        // base (`...gateBase`). Resolving the spread matters: reading only the
        // literal call body is exactly the blind spot that lets a payload hide
        // from a source scan — this tripwire was itself written with that bug
        // and flagged `capture-propose.ts`, which forces on EVERY call through
        // its `gateBase`.
        const spreadNames = [...body.matchAll(/\.\.\.(\w+)/g)].map((m) => m[1]);
        const spreadForces = spreadNames.some((name) => {
          const declAt = src.search(
            new RegExp(`(?:const|let|var)\\s+${name}\\b`)
          );
          if (declAt === -1) return false;
          // Read the declaration's own object literal by balanced braces.
          const open = src.indexOf("{", declAt);
          if (open === -1) return false;
          let depth = 0;
          let i = open;
          for (; i < src.length; i++) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") {
              depth--;
              if (depth === 0) break;
            }
          }
          return /forcePropose\s*:\s*true\b/.test(src.slice(open, i + 1));
        });
        const forcesUnconditionally =
          /forcePropose\s*:\s*true\b/.test(body) || spreadForces;
        const forcesConditionally = /forcePropose/.test(body);
        if (forcesUnconditionally) continue;
        if (forcesConditionally && evaluatesMembers) continue;
        offenders.push(file.slice(API_SRC.length + 1));
      }
    }
    expect(
      [...new Set(offenders)],
      "This gate call hands ONE (subjectType, action) pair a heterogeneous composite batch, without forcing a proposal and without evaluating every member through the resolver. One pair cannot speak for a batch it does not cover — that is how a relation materialized ungoverned under an entity.create auto-approval. Either pass forcePropose: true, or evaluate captureGraphEventKeys(ops) per member and force when any would propose."
    ).toEqual([]);
  });
});
