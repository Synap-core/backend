import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { ProposalStatus } from "@synap/database";
import { computeRevisedEnvelope } from "../services/proposals/proposals-service.js";

/**
 * TRIPWIRE — a staged source blob's `documentId` is UNTRUSTED, and every
 * terminal proposal state discards it.
 *
 * ── THE HOLE (three legs, all real, all verified) ──────────────────────────
 * A staged blob's reference (`{documentId, storageKey, …}`) travels inside
 * `proposals.data.sourceFile` — JSONB that a revise door can patch. Three
 * layers each trusted it:
 *
 *  1. `proposals.revise` merged an arbitrary `data` record into the envelope
 *     (`computeRevisedEnvelope`), with the authority its OWN AUTHOR always has.
 *  2. `attachSourceBlob` set `entities.document_id = staged.documentId` under a
 *     predicate of `id = ? AND document_id IS NULL` — it never loaded the
 *     document, so zero ownership was checked, and the entity leg had no owner
 *     floor either.
 *  3. `GET /api/files/entities/:id/url` authorizes on the ENTITY and then
 *     resolves `documents` by id with no user predicate — correct only while
 *     nobody could write `entities.document_id` from user input.
 *
 * Chained: point your own entity at a victim's `documentId`, approve, ask for
 * the presigned URL, receive their bytes. The destructive twin was
 * `discardSourceBlob`, which called `storage.delete()` on a CALLER-SUPPLIED
 * storage key and swallowed the outcome into a warn.
 *
 * ── THE SECOND DEFECT: terminal states that leak ───────────────────────────
 * Only `reject` and `batchReject` discarded. `withdraw` (pending-only, so no
 * reject can follow) and BOTH expiry scanners (which reach terminal with NO
 * human action at all — the dominant path) left the bytes and their `documents`
 * row orphaned permanently. The test that "covered" this asserted a literal
 * COUNT of two discard call sites, so adding a third door turned it red: it
 * pinned the miss. The assertion below is DERIVED from `ProposalStatus` itself
 * — a new terminal state, or a new door writing one, requires a discard.
 *
 * A source scan is the only thing that can see legs 2 and 3 and the door
 * parity: every spelling typechecks, and a call that authorizes nobody is
 * indistinguishable at runtime from one that authorizes correctly when the
 * caller happens to be the owner. The revise leg is asserted BEHAVIOURALLY
 * (the function is pure) — stronger than any keyword scan.
 */

const API_SRC = join(__dirname, "..");
const BLOB = join(API_SRC, "utils", "store-entity-source-blob.ts");

/** Blank out comments, preserving offsets — prose must not satisfy a scan. */
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
 * An unbounded `slice(declAt)` would let evidence from EVERY function below
 * satisfy an assertion about this one — the escape a sibling tripwire measured.
 */
function bodyAfter(src: string, declAt: number): string {
  let i = declAt;
  let paren = 0;
  let angle = 0;
  let seenParams = false;
  for (; i < src.length; i++) {
    if (src[i] === "(") {
      paren++;
      seenParams = true;
    } else if (src[i] === ")") {
      paren--;
    } else if (src[i] === "<" && seenParams && paren === 0) {
      // A RETURN-TYPE annotation. `Promise<{ id: string; … }>` contains a `{`
      // at paren depth 0, and taking it as the body made an assertion "about"
      // the function actually read its type signature — passing or failing on
      // text that is not code.
      angle++;
    } else if (src[i] === ">" && src[i - 1] !== "=" && angle > 0) {
      angle--;
    } else if (src[i] === "{" && seenParams && paren === 0 && angle === 0)
      break;
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

/** The balanced object literal starting at `openBrace`. */
function objectAt(src: string, openBrace: number): string {
  let depth = 0;
  for (let j = openBrace; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(openBrace, j + 1);
    }
  }
  return src.slice(openBrace);
}

/**
 * The innermost enclosing FUNCTION body containing `idx`.
 *
 * Walks outward brace-by-brace and stops at the first block whose head reads as
 * a function (`function`, `=>`, or a method/procedure signature). This is what
 * makes the door-parity assertion per-OCCURRENCE rather than per-file: a fifth
 * terminal door added to `proposals.ts` cannot be excused by the discard call
 * that some other door in the same file makes.
 */
function enclosingFunctionBody(src: string, idx: number): string {
  let from = idx;
  for (let round = 0; round < 12; round++) {
    let depth = 0;
    let open = -1;
    for (let j = from; j >= 0; j--) {
      if (src[j] === "}") depth++;
      else if (src[j] === "{") {
        if (depth === 0) {
          open = j;
          break;
        }
        depth--;
      }
    }
    if (open === -1) return src;
    const head = src.slice(Math.max(0, open - 200), open);
    if (/function\b|=>\s*$|=>\s*\r?\n?\s*$/.test(head)) {
      return objectAt(src, open);
    }
    from = open - 1;
  }
  return src;
}

/** Every non-test `.ts` file under `src`. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "__tests__")
        continue;
      sourceFiles(full, acc);
    } else if (
      name.endsWith(".ts") &&
      !name.includes(".test.") &&
      !name.endsWith(".d.ts")
    ) {
      acc.push(full);
    }
  }
  return acc;
}

describe("TRIPWIRE: a staged blob's documentId is never trusted", () => {
  const src = stripComments(readFileSync(BLOB, "utf8"));

  it("attachSourceBlob loads and authorizes the document BEFORE it writes", () => {
    const at = src.indexOf("export async function attachSourceBlob");
    expect(at, "attachSourceBlob not found").toBeGreaterThan(-1);
    const body = bodyAfter(src, at);
    expect(
      body.includes("export async function stagedSourceBlobFrom"),
      "the slice leaked past attachSourceBlob's closing brace"
    ).toBe(false);

    const gateAt = body.indexOf("assertOwnedDocument(");
    const propsWriteAt = body.indexOf("entityRepo.update(");
    const linkWriteAt = body.indexOf(".update(entitiesTable)");
    expect(
      gateAt,
      "attachSourceBlob must load the `documents` row and prove ownership — " +
        "without it `entities.document_id` is an attacker-writable pointer at " +
        "ANY document, and the presigned-URL door trusts that column."
    ).toBeGreaterThan(-1);
    expect(
      propsWriteAt,
      "the properties write vanished — scan is blind"
    ).toBeGreaterThan(-1);
    expect(
      linkWriteAt,
      "the documentId link vanished — scan is blind"
    ).toBeGreaterThan(-1);
    expect(gateAt, "the gate must precede the properties write").toBeLessThan(
      propsWriteAt
    );
    expect(gateAt, "the gate must precede the documentId link").toBeLessThan(
      linkWriteAt
    );
  });

  it("the documentId link carries an OWNER floor as well as the no-clobber guard", () => {
    const at = src.indexOf("export async function attachSourceBlob");
    const body = bodyAfter(src, at).replace(/\s+/g, " ");
    expect(
      body,
      "the raw `.update(entitiesTable)` leg must be floored on `entities.userId`, " +
        "not just on the entity id — `EntityRepository.update` scopes by user, " +
        "this statement did not."
    ).toMatch(/eq\(\s*entitiesTable\.userId,\s*userId\s*\)/);
    expect(body, "the no-clobber guard must survive").toMatch(
      /isNull\(\s*entitiesTable\.documentId\s*\)/
    );
  });

  it("assertOwnedDocument fails CLOSED — a missing or foreign row throws", () => {
    const at = src.indexOf("async function assertOwnedDocument");
    expect(at, "assertOwnedDocument not found").toBeGreaterThan(-1);
    const body = bodyAfter(src, at).replace(/\s+/g, " ");
    expect(
      body,
      "the predicate must be `!doc || doc.userId !== input.userId` → throw. A " +
        "check that only rejects a MISSING row (or only a mismatched one) is half " +
        "a gate."
    ).toMatch(
      /if \(!doc \|\| doc\.userId !== input\.userId\) \{ throw new SourceBlobOwnershipError\(/
    );
  });

  it("discardSourceBlob deletes the LOADED row's key, never the caller's", () => {
    const at = src.indexOf("export async function discardSourceBlob");
    expect(at, "discardSourceBlob not found").toBeGreaterThan(-1);
    const body = bodyAfter(src, at);
    const flat = body.replace(/\s+/g, " ");

    expect(
      flat,
      "the document row must be LOADED — the storage key and the deleting " +
        "principal both come from it"
    ).toMatch(/database\.query\.documents\.findFirst\(/);
    expect(
      flat,
      "`storage.delete` must be called with the LOADED row's key. Passing " +
        "`staged.storageKey` is the delete-anything primitive this tripwire exists " +
        "for: it was never validated against anything."
    ).toMatch(/storage\.delete\(\s*doc\.storageKey\s*\)/);
    expect(
      flat.includes("storage.delete(staged.storageKey)"),
      "the caller-supplied storage key must never reach storage.delete"
    ).toBe(false);
    expect(
      flat,
      "an ownership mismatch must THROW, not warn — a refusal folded into the " +
        "generic cleanup warn is indistinguishable from a successful cleanup"
    ).toMatch(
      /if \(userId !== null && doc\.userId !== userId\) \{ throw new SourceBlobOwnershipError\(/
    );
  });

  it("there is no governance bypass parameter on the door", () => {
    expect(
      src.includes("skipGovernance"),
      "`skipGovernance` had ZERO production callers while the file header " +
        "claimed two specific ones. A speculative bypass on a permission gate, " +
        "justified by a false comment, must not come back."
    ).toBe(false);
  });
});

describe("TRIPWIRE: a revise cannot author file provenance", () => {
  const base = {
    envelope: {
      targetType: "entity",
      changeType: "update",
      requestId: "r-1",
      id: "e-1",
      sourceFile: { documentId: "doc-mine", storageKey: "users/me/a.pdf" },
    },
    actorId: "u1",
  };

  it("rejects a patch that sets sourceFile at the envelope level", () => {
    expect(() =>
      computeRevisedEnvelope({
        ...base,
        patch: {
          kind: "envelope",
          fields: {
            sourceFile: { documentId: "doc-victim", storageKey: "k" },
          },
        },
      })
    ).toThrow(/sourceFile/);
  });

  it("rejects a patch that sets sourceFile INSIDE data (the nested reader)", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: { targetType: "entity", changeType: "update", data: {} },
        actorId: "u1",
        patch: {
          kind: "envelope",
          fields: {
            data: {
              id: "e-1",
              sourceFile: { documentId: "doc-victim", storageKey: "k" },
            },
          },
        },
      })
    ).toThrow(/sourceFile/);
  });

  it("rejects an INNER patch that sets sourceFile", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: { targetType: "entity", changeType: "update", data: {} },
        actorId: "u1",
        patch: {
          kind: "inner",
          fields: { sourceFile: { documentId: "doc-victim", storageKey: "k" } },
        },
      })
    ).toThrow(/sourceFile/);
  });

  it("still merges every OTHER field, and re-pins the stored provenance", () => {
    const { merged } = computeRevisedEnvelope({
      ...base,
      patch: { kind: "envelope", fields: { title: "Corrected" } },
    });
    expect(merged.title).toBe("Corrected");
    expect(merged.sourceFile).toEqual(base.envelope.sourceFile);
  });

  it("a wholesale `data` replacement cannot DROP a nested reference", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: {
        targetType: "entity",
        changeType: "update",
        data: {
          id: "e-1",
          sourceFile: { documentId: "doc-mine", storageKey: "k" },
        },
      },
      actorId: "u1",
      // The Studio's "Save & Approve" sends the whole edited inner.
      patch: { kind: "envelope", fields: { data: { id: "e-1", title: "x" } } },
    });
    expect(
      (merged.data as Record<string, unknown>).sourceFile,
      "dropping the reference orphans the staged bytes: no terminal door would " +
        "ever see one to discard"
    ).toEqual({ documentId: "doc-mine", storageKey: "k" });
  });
});

describe("TRIPWIRE: every terminal proposal state discards the staged blob", () => {
  /**
   * States a proposal can reach where the blob must be reclaimed — DERIVED,
   * not listed. The exclusions are the only states in which a blob is NOT
   * abandoned: PENDING is not terminal, APPROVED / AUTO_APPROVED are exactly
   * the paths that ATTACH it, and REVERTED can only follow one of those (the
   * attach already happened; undoing it is `revert`'s own job, not a discard).
   *
   * Anything else — including a status added to the enum tomorrow — is a door
   * where an un-discarded blob orphans permanently, and lands here
   * automatically. This is what replaces the literal `toBe(2)` that turned red
   * the moment a third door started doing the right thing.
   */
  const BLOB_MUST_SURVIVE = new Set<string>([
    ProposalStatus.PENDING,
    ProposalStatus.APPROVED,
    ProposalStatus.AUTO_APPROVED,
    ProposalStatus.REVERTED,
    // APPROVAL_FAILED is NOT a decision — the executor threw and the row is
    // explicitly RETRYABLE ("re-approving an APPROVAL_FAILED proposal re-runs
    // the executor and flips to APPROVED on success", apply-approval.ts).
    // Discarding here would delete the bytes the retry is supposed to attach.
    ProposalStatus.APPROVAL_FAILED,
  ]);
  const TERMINAL_KEYS = Object.entries(ProposalStatus)
    .filter(([, v]) => !BLOB_MUST_SURVIVE.has(v as string))
    .map(([k]) => k);

  const DISCARD_DOOR = /\bdiscard(?:Proposal)?SourceBlob\s*\(/;

  /**
   * Names of functions declared IN a file that themselves reach the discard
   * door. A door may delegate (the expiry scanners share one local helper);
   * resolving one level of indirection is what keeps the assertion about the
   * INVARIANT rather than about a spelling. A helper that does not actually
   * reach the door is not in this set, so delegation cannot launder a miss.
   */
  function localDiscardHelpers(s: string): string[] {
    const names: string[] = [];
    for (const m of s.matchAll(
      /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g
    )) {
      if (DISCARD_DOOR.test(bodyAfter(s, m.index!))) names.push(m[1]!);
    }
    return names;
  }

  it("names a real, non-empty set of terminal states", () => {
    // FLOOR: if the enum is refactored so this derivation yields nothing, the
    // scan below would pass on an empty population.
    expect(TERMINAL_KEYS).toEqual(
      expect.arrayContaining(["REJECTED", "WITHDRAWN", "EXPIRED"])
    );
  });

  it("every writer of a terminal status discards in the same function", () => {
    const files = sourceFiles(API_SRC);
    const offenders: string[] = [];
    const found: string[] = [];

    for (const file of files) {
      const s = stripComments(readFileSync(file, "utf8"));
      const helpers = localDiscardHelpers(s);
      // WRITE sites only: a `.set({ … status: ProposalStatus.X … })`. A status
      // named in a filter array or a switch is a READ and out of scope by
      // construction rather than by allowlist.
      for (const m of s.matchAll(/\.set\s*\(\s*\{/g)) {
        const braceAt = s.indexOf("{", m.index!);
        const obj = objectAt(s, braceAt);
        const status = obj.match(/status:\s*ProposalStatus\.([A-Z_]+)/);
        if (!status || !TERMINAL_KEYS.includes(status[1]!)) continue;
        const label = `${file.slice(API_SRC.length + 1)} → ${status[1]}`;
        found.push(label);
        const body = enclosingFunctionBody(s, m.index!);
        const reaches =
          DISCARD_DOOR.test(body) ||
          helpers.some((h) => new RegExp(`\\b${h}\\s*\\(`).test(body));
        if (!reaches) offenders.push(label);
      }
    }

    // FLOOR: the classifier is real. With an empty set of write sites the
    // offender assertion would be vacuous.
    expect(
      found.length,
      "no terminal-status WRITE site was recognised — the scan is blind, so " +
        "'no offenders' means nothing"
    ).toBeGreaterThanOrEqual(5);
    expect(
      found.some((f) => f.includes("WITHDRAWN")),
      "the withdraw door must be in the scanned population"
    ).toBe(true);
    expect(
      found.some((f) => f.includes("EXPIRED")),
      "the expiry scanners must be in the scanned population — they are the " +
        "dominant leak path, reached with no human action at all"
    ).toBe(true);

    expect(
      offenders,
      "these doors move a proposal to a terminal state without discarding its " +
        "staged source blob, orphaning the bytes AND the documents row " +
        "permanently (nothing else will ever decide their fate): " +
        offenders.join(", ")
    ).toEqual([]);
  });
});
