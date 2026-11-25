/**
 * THE REQUEST ROW — one needs-you row as three lines of typed parts (plan
 * d717d6ac §1, canvas board "The list"):
 *
 *   what        the state mark, the kind tile, what is asked, its age
 *   holds       what it holds: the thing and the status it cannot reach yet,
 *               else what the answer unblocks, else the reason
 *   who/where   who asked (or what raised it) and where it came from, as doors
 *
 * Marks and doors, never a joined string: each app draws a part with its own
 * kit (a mark is colour and icon, a door opens its object). Replaces the
 * " · " sentence rows (pod admin `secondaryLine`, relay `BoardRow`).
 *
 * The input is THE shared lens row (`lensRowOfNeedsYou`), so state, title,
 * asker and source keep their one derivation. Pure.
 */

import type { Locale } from "../i18n/index.js";
import type { LensDoor, LensRow, LensVerb } from "../lens/rows.js";
import { visibleSource, type LensScope } from "../lens/scope.js";
import type { UnitStateInput } from "../units/state.js";
import { resolveObjectNoun } from "../vocabulary/index.js";
import { needsYouT } from "./copy.js";

export type RequestRowPart =
  /** The row's state, drawn as the shared state mark (`resolveUnitState`). */
  | { kind: "state"; state: UnitStateInput }
  /** The kind tile: an icon key and its noun (the tile's accessible name). */
  | { kind: "tile"; objectKind: string; noun: string }
  /** Words someone wrote or the pod resolved (a title, a reason, an `unblocks`). */
  | { kind: "text"; role: "title" | "reason" | "unblocks"; text: string }
  /** A chrome word that heads a line ("Holds"). */
  | { kind: "label"; text: string }
  /** A named object, opening its page. */
  | {
      kind: "door";
      role: "thing" | "by" | "cause" | "source";
      label: string;
      door: LensDoor | null;
    }
  /** A status pair: where the thing stands, and where it cannot go yet. */
  | {
      kind: "status";
      now: { key: string; label: string } | null;
      next: { key: string; label: string } | null;
    }
  /** When it was asked (ISO), drawn as an age through the value formatter. */
  | { kind: "age"; at: string }
  /** When it stops being answerable (ISO), drawn as a countdown. */
  | { kind: "expiry"; at: string };

export interface RequestRowView {
  key: string;
  /** Where the row opens. */
  door: LensDoor | null;
  /** At most one inline verb. */
  verb: LensVerb | null;
  what: RequestRowPart[];
  holds: RequestRowPart[];
  who: RequestRowPart[];
}

export function requestRow(
  row: LensRow,
  opts: { scope?: LensScope; locale?: Locale } = {}
): RequestRowView {
  const t = needsYouT(opts.locale);
  const kind = row.subjectKind ?? row.objectKind;
  const what: RequestRowPart[] = [
    { kind: "state", state: row.state },
    { kind: "tile", objectKind: kind, noun: resolveObjectNoun(kind) },
    { kind: "text", role: "title", text: row.title },
  ];
  if (row.occurredAt) what.push({ kind: "age", at: row.occurredAt });
  if (row.expiresAt) what.push({ kind: "expiry", at: row.expiresAt });

  const holds: RequestRowPart[] = [];
  if (row.blocks) {
    holds.push({ kind: "label", text: t("needsYou.row.holds") });
    const name = row.blocks.thing.name?.trim();
    if (name) {
      holds.push({
        kind: "door",
        role: "thing",
        label: name,
        door: { kind: "entity", id: row.blocks.thing.id },
      });
    }
    if (row.blocks.statusNow || row.blocks.statusNext) {
      holds.push({
        kind: "status",
        now: row.blocks.statusNow,
        next: row.blocks.statusNext,
      });
    }
  } else if (row.unblocks?.trim()) {
    holds.push(
      { kind: "label", text: t("needsYou.row.holds") },
      { kind: "text", role: "unblocks", text: row.unblocks.trim() }
    );
  } else if (row.reason?.trim()) {
    holds.push({ kind: "text", role: "reason", text: row.reason.trim() });
  }

  const who: RequestRowPart[] = [];
  if (row.by) {
    who.push({
      kind: "door",
      role: "by",
      label: row.by.label,
      door: row.by.door ?? { kind: "agent", id: row.by.id },
    });
  } else if (row.cause) {
    who.push({
      kind: "door",
      role: "cause",
      label: row.cause.label,
      door: row.cause.door,
    });
  }
  const source = opts.scope ? visibleSource(row, opts.scope) : row.source;
  if (source?.label) {
    who.push({
      kind: "door",
      role: "source",
      label: source.label,
      door: { kind: source.kind, id: source.id },
    });
  }

  return { key: row.key, door: row.door, verb: row.verb, what, holds, who };
}
