"use client";

/**
 * The way into the object a proposal UPDATES: "Open document". The review page is not the object's page (it shows a proposed
 * change, not the thing), so a reviewer who wants the whole picture needs a
 * door to the real object, at every status: the question comes before the
 * decision, and an approved change is read against the object it changed.
 *
 * The twin of `CreatedDoor`, which names what an approval MADE once it exists.
 * The verb takes its mood from the status (what approving WILL do while it is
 * open, what it DID once approved), from the vocabulary door.
 */

import {
  nounParams,
  resolveActionLabel,
  resolveNoun,
} from "@synap-core/types/vocabulary";
import { ExitLink } from "../../../lib/exit-link";
import { openIn } from "../../../lib/open-in";
import { proposalPageT } from "./copy";
import type { UpdatedObject } from "./proposal-review-model";

/**
 * The door's words: ONE catalog message carrying the verb and the noun bundle
 * (`updated.open`), never a concatenation, so a translation agrees with the
 * noun ("Ouvrir le constat", "Ouvrir la tâche"). Named by what the object IS
 * (`kind`, a profile slug), never by its table ("Open entity").
 */
export function updatedDoorLabel(
  updated: Pick<UpdatedObject, "kind">,
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
  updated: UpdatedObject;
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
