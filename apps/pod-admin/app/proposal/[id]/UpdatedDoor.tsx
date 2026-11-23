"use client";

/**
 * The way into the object a request is ABOUT (`aboutObject`: the thing an
 * update or a delete names, a merge's survivor, a facet's entity): "Open
 * document". The review page shows a proposed change, not the thing, so the
 * reviewer gets a door to the real object before deciding. Once applied, what
 * it touched is a "Made" row instead (`MadeSection`).
 */

import {
  nounParams,
  resolveActionLabel,
  resolveNoun,
} from "@synap-core/types/vocabulary";
import { ExitLink } from "../../../lib/exit-link";
import { openIn } from "../../../lib/open-in";
import { proposalPageT } from "./copy";

/**
 * The door's words: ONE catalog message carrying the verb and the noun bundle
 * (`updated.open`), never a concatenation, so a translation agrees with the
 * noun ("Ouvrir le constat", "Ouvrir la tâche"). Named by what the object IS
 * (`kind`, a profile slug), never by its table ("Open entity").
 */
export function updatedDoorLabel(
  updated: { kind: string },
  kind?: string | null
): string {
  return proposalPageT()("updated.open", {
    verb: resolveActionLabel("open", "imperative"),
    ...nounParams(resolveNoun(kind || updated.kind)),
  });
}

export function UpdatedDoor({
  updated,
  kind,
}: {
  updated: { kind: string; id: string };
  /** The object's own kind (a profile slug: `finding`), when the pod named it. */
  kind?: string | null;
}) {
  // The change's title is the drawer's and the record card's: said once
  // there. Here only the door.
  return (
    <span
      data-updated-object={updated.id}
      className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]"
    >
      <ExitLink
        exit={openIn({
          kind: "object",
          objectKind: updated.kind,
          id: updated.id,
        })}
        label={updatedDoorLabel(updated, kind)}
      />
    </span>
  );
}
