import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — every proposal-MUTATING door goes through the authority path.
 *
 * THE DEFECT CLASS (door-parity severance). Two adjacent MCP handlers:
 *
 *   `synap_reject_proposal` → `resolveProposalId(userId, …)` then
 *      `proposalsRouter.createCaller().reject()` → `assertCanReviewProposal`. ✅
 *   `synap_revise_proposal` → `args.proposalId` RAW → `reviseProposal(…)`,
 *      whose core row-locked and asserted PENDING but had NO ownership or
 *      review-authority predicate at all. ❌
 *
 * So an agent could rewrite `summary` / `reasoning` — the exact text a human
 * reads when deciding to approve — on ANY pending proposal by id, including
 * ones it did not author. That is tampering with the evidence a governance
 * decision rests on. The Hub door (`hub-protocol/proposals.ts` `updateProposal`)
 * had the same hole; only the tRPC door (`proposals.revise`) checked.
 *
 * THE RULE, in two halves:
 *
 *   1. The ONE shared revise core (`mergeProposalRevision`) runs the reviewer-
 *      authority ladder (`computeCanReviewApproval`) BEFORE it writes. Putting
 *      the gate in the core — not at each door — is what makes it impossible for
 *      a fourth door to be added without it.
 *   2. An MCP handler that accepts a caller-supplied `args.proposalId` resolves
 *      it through `resolveProposalId` (user-scoped short-id resolution), never
 *      binding a raw arg into a lookup.
 *
 * A SOURCE SCAN is the only mechanism that can see this: both spellings
 * typecheck, both call sites succeed, and no runtime assertion distinguishes a
 * gated door from an ungated one that happened to be called by its owner.
 *
 * ── WHAT THIS SCAN HARDENED AGAINST (three MEASURED escapes) ───────────────
 *  1. UNBOUNDED SLICE + PRESENCE-ONLY GATE. `src.slice(coreAt)` ran to END OF
 *     FILE, straight past `mergeProposalRevision`'s closing brace into
 *     `reviseProposal` and everything after it; and the assertion was merely
 *     `indexOf("computeCanReviewApproval") > -1`. PROVEN: leaving the call in a
 *     DEAD ternary branch —
 *       `const { allowed } = true ? { allowed: true } : await computeCan…({…})`
 *     — kept the tripwire GREEN. The slice is now the function's balanced-brace
 *     BODY, and the assertion pins the ternary's SHAPE (condition, both
 *     branches), so an unreachable call fails.
 *  2. VACUOUS HANDLER CORPUS. The key pattern `^ {2}(synap_[a-z0-9_]+): async \(`
 *     matched ZERO handlers in `handlers/capture.ts`, which declares
 *     `synap_capture: captureHandler` — a handler BY REFERENCE. Any reformat
 *     could empty the corpus and the test would pass on nothing. Handlers
 *     declared by reference are now RESOLVED to the referenced function's body,
 *     and both a scanned-keys floor and a positive floor (the two known
 *     mutating doors must be FOUND) guard against a blind scan.
 *  3. WHITESPACE-EXACT DOOR LIST. `".reject({"` / `".approve({"` missed
 *     `.reject( {` or a line break. The door list is regex-based and
 *     whitespace-tolerant, and runs on comment-stripped source so the prose
 *     mention of `.reject()` in `build.ts` cannot classify a door.
 */

const API_SRC = join(__dirname, "..");
const SERVICE = join(API_SRC, "services", "proposals", "proposals-service.ts");
const MCP_HANDLERS = join(API_SRC, "routers", "mcp", "handlers");

/** Calls that act on an EXISTING proposal (as opposed to creating one). */
const MUTATION_DOORS: [string, RegExp][] = [
  ["reviseProposal(", /\breviseProposal\s*\(/],
  ["mergeProposalRevision(", /\bmergeProposalRevision\s*\(/],
  [".reject({", /\.\s*reject\s*\(\s*\{/],
  [".approve({", /\.\s*approve\s*\(\s*\{/],
];

/**
 * Blank out COMMENTS, preserving offsets. String bodies are kept (the scans
 * below read no string contents, but a `//` inside one must not be mistaken for
 * a comment). Without this the PROSE in `build.ts` — which explains why the
 * revise door cannot go through `proposalsRouter…reject()` — classifies
 * `synap_revise_proposal` as a reject door.
 */
function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        j++;
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/**
 * The balanced-brace BODY that follows `declAt`, skipping the parameter list.
 * THE fix for escape 1: `src.slice(declAt)` runs to end of file, so an
 * assertion "about" one function silently accepts evidence from every function
 * below it.
 */
function bodyAfter(src: string, declAt: number): string {
  let i = declAt;
  let paren = 0;
  let seenParams = false;
  for (; i < src.length; i++) {
    if (src[i] === "(") {
      paren++;
      seenParams = true;
    } else if (src[i] === ")") {
      paren--;
    } else if (src[i] === "{" && seenParams && paren === 0) break;
  }
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return src.slice(i);
}

/** Whitespace-collapsed view, for structural regexes that span line breaks. */
const flat = (s: string): string => s.replace(/\s+/g, " ");

describe("TRIPWIRE: proposal revise goes through the authority path", () => {
  const serviceSrc = stripComments(readFileSync(SERVICE, "utf8"));
  const coreAt = serviceSrc.indexOf(
    "export async function mergeProposalRevision"
  );
  // Bound the evidence to THIS function. An unbounded slice let the assertions
  // below be satisfied by `reviseProposal` and everything after it.
  const coreBody = coreAt === -1 ? "" : bodyAfter(serviceSrc, coreAt);

  it("the shared revise core gates on computeCanReviewApproval BEFORE it writes", () => {
    expect(coreAt, "mergeProposalRevision not found").toBeGreaterThan(-1);
    // Sanity: the slice really is bounded — the NEXT top-level function must
    // fall outside it, or every assertion here is scoped to the whole file.
    expect(
      coreBody.includes("export async function reviseProposal"),
      "the core slice leaked past mergeProposalRevision's closing brace"
    ).toBe(false);

    const gateAt = coreBody.indexOf("computeCanReviewApproval");
    const writeAt = coreBody.indexOf(".update(proposals)");
    expect(
      gateAt,
      "mergeProposalRevision must consult computeCanReviewApproval — without it every " +
        "door that reaches this core (MCP synap_revise_proposal, Hub updateProposal) " +
        "can rewrite any pending proposal's summary/reasoning by id."
    ).toBeGreaterThan(-1);
    expect(
      writeAt,
      "the core no longer writes — scan is blind"
    ).toBeGreaterThan(-1);
    expect(
      gateAt,
      "the authority check must run BEFORE the update, not after it"
    ).toBeLessThan(writeAt);

    // REACHABILITY, not presence. The sabotage that motivated this — the gate
    // parked in a dead ternary branch (`true ? { allowed: true } : await
    // computeCanReviewApproval({…})`) — passed every presence check while
    // authorizing everyone. Pin the whole shape: the condition is the actor,
    // the TRUE branch is the awaited ladder, the FALSE branch denies.
    expect(
      flat(coreBody),
      "the authority result must come from `params.actorId ? await " +
        "computeCanReviewApproval({…}) : { allowed: false }`. Any other shape — a " +
        "constant condition, a literal true branch, an unawaited call — is a gate " +
        "that does not run."
    ).toMatch(
      /const \{ allowed \} = params\.actorId \? await computeCanReviewApproval\(\{[\s\S]{0,600}?\}\) : \{ allowed: false \};/
    );
    // …and the ladder is asked about THIS actor, not some other id.
    expect(flat(coreBody)).toMatch(/userId: params\.actorId,?\s*\}\)/);
  });

  it("the core fails CLOSED when the gate says no", () => {
    // The deny branch must actually stop the write, inside this function.
    expect(
      flat(coreBody),
      "`!allowed` must throw before the update — a logged-and-continue here is an " +
        "ungated revise door"
    ).toMatch(/if \(!allowed\) \{ throw new TRPCError\(/);
    const denyAt = coreBody.indexOf("if (!allowed)");
    expect(denyAt).toBeGreaterThan(-1);
    expect(denyAt, "the deny must precede the update").toBeLessThan(
      coreBody.indexOf(".update(proposals)")
    );
  });

  it("every MCP handler that MUTATES an existing proposal resolves its id via resolveProposalId", () => {
    const files = readdirSync(MCP_HANDLERS)
      .filter((n) => n.endsWith(".ts") && !n.includes(".test."))
      .map((n) => join(MCP_HANDLERS, n))
      .filter((f) => statSync(f).isFile());

    const offenders: string[] = [];
    const scanned: string[] = [];
    const mutating: string[] = [];

    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"));
      // Handler entries are `  synap_x: <value>` in one object literal. The
      // value is EITHER an inline `async (…) => {…}` OR a bare identifier
      // referencing a function declared elsewhere in the file
      // (`synap_capture: captureHandler`) — the by-reference form the old
      // `: async \(` pattern could not see at all.
      const keys = [...src.matchAll(/^ {2}(synap_[a-z0-9_]+)\s*:\s*(.*)$/gm)];
      for (let i = 0; i < keys.length; i++) {
        const name = keys[i][1];
        const rhs = keys[i][2].trim();
        scanned.push(name);

        let body: string;
        // `async (`, `(`, `function` → an inline arrow/function expression.
        // A bare trailing identifier → a reference to a handler declared
        // elsewhere in the file.
        if (
          /^[A-Za-z_$][A-Za-z0-9_$]*\s*,?$/.test(rhs) &&
          !/^async\b/.test(rhs)
        ) {
          // By reference: resolve to the referenced function's own body.
          const ref = rhs.replace(/,$/, "");
          const declAt = src.search(
            new RegExp(
              `\\b(?:const|function)\\s+${ref}\\b|\\b${ref}\\s*:\\s*McpToolHandler`
            )
          );
          if (declAt === -1) {
            offenders.push(
              `${file.split("/").pop()} → ${name} (handler declared by reference ` +
                `to \`${ref}\`, which this scan could not resolve — it cannot be ` +
                `audited, so it cannot be assumed safe)`
            );
            continue;
          }
          body = bodyAfter(src, declAt);
        } else {
          // Inline: slice up to the next handler key (or end of the literal).
          const start = keys[i].index!;
          const end = i + 1 < keys.length ? keys[i + 1].index! : src.length;
          body = src.slice(start, end);
        }

        // Only doors that act on an EXISTING proposal. `synap_create_workspace`
        // also reads `args.proposalId`, but as an idempotency key for a NEW
        // proposal — it mutates nothing, so it is out of scope by construction
        // rather than by allowlist.
        const hit = MUTATION_DOORS.find(([, re]) => re.test(body));
        if (!hit) continue;
        mutating.push(name);
        if (!/\bresolveProposalId\s*\(/.test(body)) {
          offenders.push(`${file.split("/").pop()} → ${name} (via ${hit[0]})`);
        }
      }
    }

    // FLOOR 1 — the corpus is real. A reformat that stops matching handler keys
    // must fail loudly, not pass on an empty set.
    expect(
      scanned.length,
      "the handler-key scan found (almost) nothing — a reformat has blinded it, " +
        "so the assertion below would pass vacuously"
    ).toBeGreaterThan(40);
    expect(
      scanned,
      "the by-reference handler declarations in handlers/capture.ts must be seen " +
        "by the scan (they were invisible to the original `: async (` pattern)"
    ).toEqual(expect.arrayContaining(["synap_capture", "synap_capture_graph"]));

    // FLOOR 2 — the CLASSIFIER is real. If no door is recognised as mutating,
    // "no offenders" means nothing. These two are the doors this tripwire was
    // written for.
    expect(
      mutating,
      "the mutation-door classifier recognised no proposal-mutating handler — " +
        "with an empty in-scope set the offender assertion is vacuous"
    ).toEqual(
      expect.arrayContaining(["synap_revise_proposal", "synap_reject_proposal"])
    );

    expect(
      offenders,
      "these MCP handlers bind a RAW caller-supplied proposal id: " +
        offenders.join(", ")
    ).toEqual([]);
  });
});
