/**
 * The curate RULES both curate engines share — the per-import one
 * (`imports/curate.ts`) and the Library one (`library/curate.ts`) — so they
 * cannot drift again (they did: a Library merge dropped the merged group's
 * note, and a Library create had no group cap).
 */

import {
  IMPORT_LIMITS,
  type ImportGroupOutput,
} from "@synap-core/types/imports";

/** A bad op: names the edit by its 1-based position. Nothing is written. */
export class CurateOpError extends Error {
  constructor(
    readonly opIndex: number,
    message: string
  ) {
    super(`Edit #${opIndex + 1}: ${message}`);
    this.name = "CurateOpError";
  }
}

export type Fail = (message: string) => never;

const L = IMPORT_LIMITS;

/** A group name: one line, trimmed, 1..groupNameMax characters. */
export function groupName(raw: string, fail: Fail): string {
  const n = raw.replace(/\s+/g, " ").trim();
  if (!n) fail("a group needs a name");
  if (n.length > L.groupNameMax)
    fail(`a group name is at most ${L.groupNameMax} characters`);
  return n;
}

/** A group note: ≤ groupNoteMax; blank clears it (undefined). */
export function groupNote(raw: string, fail: Fail): string | undefined {
  if (raw.length > L.groupNoteMax)
    fail(`a group note is at most ${L.groupNoteMax} characters`);
  return raw.trim() || undefined;
}

/** An item note: ≤ itemNoteMax; blank clears it (undefined). */
export function itemNote(raw: string, fail: Fail): string | undefined {
  if (raw.length > L.itemNoteMax)
    fail(`an item note is at most ${L.itemNoteMax} characters`);
  return raw.trim() || undefined;
}

/** Room for one more group, or fail. */
export function assertRoomForGroup(groups: number, fail: Fail): void {
  if (groups >= L.groupsMax) fail(`at most ${L.groupsMax} groups`);
}

/**
 * A merge keeps BOTH notes (they steer Build): the target's, then the merged
 * group's, capped at groupNoteMax. Outputs are the union.
 */
export function mergeGroupSettings(
  into: { note?: string | null; outputs: readonly ImportGroupOutput[] },
  from: { note?: string | null; outputs: readonly ImportGroupOutput[] }
): { note: string | undefined; outputs: ImportGroupOutput[] } {
  const notes = [into.note?.trim(), from.note?.trim()].filter(
    (n): n is string => Boolean(n)
  );
  const unique = [...new Set(notes)];
  const note = unique.join("\n\n").slice(0, L.groupNoteMax).trim();
  return {
    note: note || undefined,
    outputs: [...new Set([...into.outputs, ...from.outputs])],
  };
}
