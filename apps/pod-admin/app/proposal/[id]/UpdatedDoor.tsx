"use client";

/**
 * The way into the object a proposal UPDATES: "Update · Q3 plan → Open
 * document". The review page is not the object's page (it shows a proposed
 * change, not the thing), so a reviewer who wants the whole picture needs a
 * door to the real object, at every status: the question comes before the
 * decision, and an approved change is read against the object it changed.
 *
 * The twin of `CreatedDoor`, which names what an approval MADE once it exists.
 * The verb takes its mood from the status (what approving WILL do while it is
 * open, what it DID once approved), from the vocabulary door.
 */

import {
  resolveActionLabel,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import { ExitLink } from "../../../lib/exit-link";
import { openIn } from "../../../lib/open-in";
import type { UpdatedObject } from "./proposal-review-model";

export function UpdatedDoor({
  updated,
  applied,
}: {
  updated: UpdatedObject;
  /** Approved: the change is on the object now. */
  applied: boolean;
}) {
  const noun = resolveObjectNoun(updated.kind);
  const verb = resolveActionLabel("update", applied ? "past" : "imperative");
  const open = resolveActionLabel("open", "imperative");
  return (
    <span
      data-updated-object={updated.id}
      className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-foreground/80"
    >
      <span className="min-w-0 break-words">
        {verb}
        {updated.title ? ` · ${updated.title}` : ""}
      </span>
      <ExitLink
        exit={openIn({
          kind: "object",
          objectKind: updated.kind,
          id: updated.id,
        })}
        label={`${open} ${noun.toLowerCase()}`}
      />
    </span>
  );
}
