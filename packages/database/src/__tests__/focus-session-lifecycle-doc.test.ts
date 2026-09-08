import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FocusSessionStatus } from "../schema/focus-sessions.js";

/**
 * GUARD — the `focus_sessions` lifecycle doc-block must account for EVERY member
 * of `FocusSessionStatus`.
 *
 * The defect this closes, found 2026-09-08: the header above the enum documented
 *
 *     active → paused ↔ active → closed   (or → stale)
 *
 * while the enum ALSO carried `forming` and `scheduled` — two pre-start states
 * the prose had never heard of, and which nothing in any repo produced. A
 * lifecycle note that describes a SMALLER lifecycle than the type allows is the
 * exact defect class this project keeps paying for: it passes every gate while
 * quietly ceasing to be true.
 *
 * Correcting the prose alone would decay the same way. So this DERIVES both
 * sets — the enum members from the enum object itself (not a hand-written list),
 * the documented states from the doc-block's own text — and fails when they
 * diverge. A new status therefore cannot be added without this paragraph being
 * updated in the same commit.
 *
 * WHAT IT DOES NOT COVER, measured by trying it: it checks that each status
 * VALUE is NAMED somewhere in the block. It cannot check that what the block
 * says about a status is CORRECT, and it does not verify transitions. It also
 * scans only the doc-block that ends at the enum declaration, so prose moved
 * below the enum stops counting — which is intentional (that is no longer the
 * lifecycle header) but is a real boundary.
 */

const SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schema",
  "focus-sessions.ts"
);

/**
 * The file's leading doc-block: everything before the enum declaration. Pinned
 * at BOTH ends — the file start and the `export enum FocusSessionStatus` line —
 * so it cannot silently widen to swallow the whole file (which would make every
 * assertion below trivially true, the enum members being spelled in the enum).
 */
function lifecycleDocBlock(): string {
  const src = readFileSync(SCHEMA_PATH, "utf8");
  const enumAt = src.indexOf("export enum FocusSessionStatus");
  expect(enumAt).toBeGreaterThan(-1);
  return src.slice(0, enumAt);
}

/** DERIVED from the enum object — never hand-listed. */
const statusValues = Object.values(FocusSessionStatus) as string[];

describe("focus_sessions lifecycle doc-block covers every status", () => {
  it("the scan is not vacuous", () => {
    // A shrinking enum or a broken slice would make the real assertion pass on
    // nothing at all.
    expect(statusValues.length).toBeGreaterThanOrEqual(8);
    expect(statusValues).toContain("scheduled");
    expect(statusValues).toContain("forming");

    const block = lifecycleDocBlock();
    // The block is the HEADER, not the file: it must be substantial, and it must
    // stop before the enum (so it cannot be reading the enum's own members).
    expect(block.length).toBeGreaterThan(200);
    expect(block).not.toContain("export enum FocusSessionStatus");
    // Self-check that the matcher can still see a literal sample of what it
    // hunts, in the exact form it hunts it.
    expect(new RegExp(`\\bactive\\b`).test(block)).toBe(true);
  });

  it("every FocusSessionStatus member is named in the lifecycle doc-block", () => {
    const block = lifecycleDocBlock();
    const undocumented = statusValues.filter(
      (value) => !new RegExp(`\\b${value}\\b`).test(block)
    );
    expect(undocumented).toEqual([]);
  });
});

/*
 * THE MIRROR FAILURE IS DELIBERATELY NOT GUARDED, and here is the measurement.
 *
 * Prose naming a status that was renamed or removed misleads just as badly as
 * prose missing one, so the obvious second assertion is "no retired state name
 * appears in the block". I wrote it, against a curated candidate list, and it
 * went RED on this very file for two words that are not status names at all:
 * "pending" (inside `triage-pending`) and "completed" (inside
 * `completed/reopened`). The block is ENGLISH; a word-boundary regex cannot
 * distinguish a state name from ordinary usage, and every fix — narrowing the
 * candidate list, demanding backticks — makes the guard weaker than the prose it
 * watches while looking stronger.
 *
 * A brittle guard is a deleted guard, so it is deleted, and the gap is written
 * down instead: NOTHING here catches a doc-block that still describes a status
 * the enum no longer has. Removing a status is a manual review of this comment
 * block. The forward direction — a status the doc does not know about, which is
 * the failure that actually happened — IS covered above.
 */
