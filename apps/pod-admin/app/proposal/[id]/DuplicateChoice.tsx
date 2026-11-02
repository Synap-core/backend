"use client";

/**
 * "Looks like X" on the pod-admin review. The pod filed this write
 * ANYWAY because its one duplicate door found a possible twin; the reviewer
 * decides. Every rule — which twins bind the verbs, the verbs themselves, their
 * order and words, the one primary, why a twin matched, the sample mark — is
 * the ONE derivation in `@synap-core/types/proposals` (`duplicate-review.ts`),
 * the same one the browser card and relay read. This file only draws it:
 *
 *  - each twin is a door (its kind, its name, why it matched in words);
 *  - a single create whose twin is a record: the verbs REPLACE Approve
 *    (`TwinVerbs`); with several twins a record is picked first;
 *  - a capture graph: each item whose twin is a record gets its own choice,
 *    inside that item's card (`ItemTwinChoice`); the page's Approve sends them;
 *  - a lookup that FAILED says so in one quiet mark;
 *  - a large approval that STOPPED on a record that already exists: the
 *    records it met, and one answer for every such record (`TwinStopVerbs`),
 *    so approving again goes on instead of stopping on the same refusal.
 */

import { Button, Radio, RadioGroup } from "@heroui/react";
import { Check, CopyX } from "lucide-react";
import {
  DUPLICATE_RESOLUTION_VERBS,
  DUPLICATE_UNCHECKED_LINE,
  PICK_TWIN_FIRST,
  PRIMARY_DUPLICATE_VERB,
  defaultDuplicateItemChoice,
  duplicateCandidateLabel,
  duplicateIsSample,
  duplicateObjectKind,
  duplicateResolutionFor,
  duplicateWhyLabel,
  type DuplicateCandidate,
  type DuplicateItemChoice,
  type DuplicateItemReview,
  type DuplicateResolution,
  type DuplicateResolutionVerb,
} from "@synap-core/types/proposals";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { kindIcon, kindLabel } from "../../_lib/object/kind-icon";
import { Pill } from "../../_lib/object/provenance-chips";
import { openIn } from "../../../lib/open-in";
import type { ApprovalRunTwin } from "../../_lib/approval-progress/approval-progress-model";

/** One twin as a door: its kind, its name, and why it matched. */
function TwinDoor({
  candidate,
  withFor,
}: {
  candidate: DuplicateCandidate;
  withFor: boolean;
}) {
  const objectKind = duplicateObjectKind(candidate);
  // An entity draws its own kind (the profile slug); anything else its object kind.
  const shown = objectKind === "entity" ? candidate.kind : objectKind;
  const Icon = kindIcon(shown);
  const name = duplicateCandidateLabel(
    withFor ? candidate : { ...candidate, forTitle: undefined }
  );
  return (
    <span
      data-twin={candidate.id}
      className="inline-flex max-w-full flex-wrap items-center gap-1.5"
    >
      <Pill
        exit={openIn({ kind: "object", objectKind, id: candidate.id })}
        title={kindLabel(shown)}
      >
        <Icon aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
        <span className="truncate font-medium text-foreground">{name}</span>
      </Pill>
      <span
        className={`text-[12px] ${
          duplicateIsSample(candidate) ? "text-warning" : "text-foreground/55"
        }`}
      >
        {candidate.ref === "proposal"
          ? resolveStatusLabel("pending")
          : duplicateWhyLabel(candidate)}
      </span>
    </span>
  );
}

/** "Looks like" + the twins, each a door. */
export function TwinDoors({
  candidates,
  truncated,
  withFor = true,
}: {
  candidates: readonly DuplicateCandidate[];
  truncated?: boolean;
  withFor?: boolean;
}) {
  if (candidates.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Looks like"
      data-review-twins=""
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
    >
      <span className="text-[12px] font-medium text-foreground/65">
        Looks like
      </span>
      {candidates.map((c) => (
        <TwinDoor
          key={`${c.ref}:${c.id}:${c.forRef ?? ""}`}
          candidate={c}
          withFor={withFor}
        />
      ))}
      {truncated && (
        <span className="text-[12px] text-foreground/55">and more</span>
      )}
    </div>
  );
}

/** The quiet mark for a duplicate lookup that failed: never read as "no twin". */
export function DuplicateUnchecked() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-foreground/60">
      <CopyX aria-hidden className="h-3.5 w-3.5" />
      {DUPLICATE_UNCHECKED_LINE}
    </span>
  );
}

/** "Which record is it?" — one single-select group, each option named. */
function PickTwin({
  twins,
  value,
  onChange,
  disabled,
}: {
  twins: readonly DuplicateCandidate[];
  value: string | null;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <RadioGroup
      label="Which record is it?"
      size="sm"
      value={value ?? ""}
      onValueChange={onChange}
      isDisabled={disabled}
      classNames={{ label: "text-[12px] text-foreground/65" }}
    >
      {twins.map((twin) => (
        <Radio
          key={twin.id}
          value={twin.id}
          description={duplicateWhyLabel(twin)}
        >
          {duplicateCandidateLabel({ ...twin, forTitle: undefined })}
        </Radio>
      ))}
    </RadioGroup>
  );
}

/**
 * A single create whose twin is a record: the verbs ARE the approve. Each is
 * one button carrying its label and what it does; the primary is solid, the
 * rest bordered. A record-bound verb appears once it has a record.
 */
export function TwinVerbs({
  twins,
  pickedId,
  onPick,
  onResolve,
  busy,
}: {
  twins: readonly DuplicateCandidate[];
  pickedId: string | null;
  onPick: (id: string) => void;
  onResolve: (resolution: DuplicateResolution) => void;
  busy: boolean;
}) {
  const several = twins.length > 1;
  const verbs = DUPLICATE_RESOLUTION_VERBS.flatMap((verb) => {
    const resolution = duplicateResolutionFor(verb.verb, twins, pickedId);
    return resolution ? [{ ...verb, resolution }] : [];
  });
  return (
    <div data-review-verbs="" className="flex flex-col gap-2">
      {several && (
        <PickTwin
          twins={twins}
          value={pickedId}
          onChange={onPick}
          disabled={busy}
        />
      )}
      {several && pickedId === null && (
        <span className="text-[12px] text-foreground/60">
          {PICK_TWIN_FIRST}
        </span>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] gap-2">
        {verbs.map((verb) => {
          const primary = verb.verb === PRIMARY_DUPLICATE_VERB;
          return (
            <Button
              key={verb.verb}
              data-verb={verb.verb}
              color={primary ? "success" : "default"}
              variant={primary ? "solid" : "bordered"}
              className="h-auto min-h-12 flex-col items-start gap-0.5 whitespace-normal px-3 py-2 text-left"
              isDisabled={busy}
              onPress={() => onResolve(verb.resolution)}
            >
              <span className="inline-flex items-center gap-1.5 text-[13.5px] font-medium">
                {primary && <Check aria-hidden size={15} />}
                {verb.label}
              </span>
              <span
                className={`text-[11.5px] font-normal leading-snug ${
                  primary ? "opacity-85" : "text-foreground/60"
                }`}
              >
                {verb.hint}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/** The answers for every record that already exists, in the verbs' words. */
const TWIN_STOP_VERBS = (["keep_existing", "separate"] as const).map((verb) => {
  const shared = DUPLICATE_RESOLUTION_VERBS.find((v) => v.verb === verb)!;
  return {
    verb,
    label: `${shared.label} and continue`,
    hint:
      verb === "keep_existing"
        ? "Links each record to the one already there. A name several records share is left out."
        : shared.hint,
  };
});

/**
 * A large approval stopped because a record already exists. Resuming alone
 * would stop on it again, so the reviewer answers once for EVERY such record:
 * use the existing one, or keep both. The records it met are doors.
 */
export function TwinStopVerbs({
  twins,
  onAnswer,
  busy,
}: {
  twins: readonly ApprovalRunTwin[];
  onAnswer: (verb: "keep_existing" | "separate") => void;
  busy: boolean;
}) {
  return (
    <div data-review-twin-stop="" className="flex flex-col gap-2">
      <div
        role="group"
        aria-label="Already in your pod"
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
      >
        <span className="text-[12px] font-medium text-foreground/65">
          Already in your pod
        </span>
        {twins.map((twin) => {
          const Icon = kindIcon(twin.kind);
          return (
            <Pill
              key={twin.id}
              exit={openIn({
                kind: "object",
                objectKind: "entity",
                id: twin.id,
              })}
              title={kindLabel(twin.kind)}
            >
              <Icon aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
              <span className="truncate font-medium text-foreground">
                {twin.title ?? kindLabel(twin.kind)}
              </span>
            </Pill>
          );
        })}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-2">
        {TWIN_STOP_VERBS.map((verb) => {
          const primary = verb.verb === "keep_existing";
          return (
            <Button
              key={verb.verb}
              data-verb={verb.verb}
              color={primary ? "success" : "default"}
              variant={primary ? "solid" : "bordered"}
              className="h-auto min-h-12 flex-col items-start gap-0.5 whitespace-normal px-3 py-2 text-left"
              isDisabled={busy}
              onPress={() => onAnswer(verb.verb)}
            >
              <span className="inline-flex items-center gap-1.5 text-[13.5px] font-medium">
                {primary && <Check aria-hidden size={15} />}
                {verb.label}
              </span>
              <span
                className={`text-[11.5px] font-normal leading-snug ${
                  primary ? "opacity-85" : "text-foreground/60"
                }`}
              >
                {verb.hint}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One capture-graph item whose twin is a record: its twins, its pick, its
 * verb — drawn inside that item's card. The page's Approve sends the choice
 * as `identityResolutionByRef[item.forRef]`.
 */
export function ItemTwinChoice({
  item,
  choice,
  onChoice,
  busy,
}: {
  item: DuplicateItemReview;
  choice: DuplicateItemChoice | undefined;
  onChoice: (choice: DuplicateItemChoice) => void;
  busy: boolean;
}) {
  const current = choice ?? defaultDuplicateItemChoice();
  const several = item.resolvable.length > 1;
  const verb =
    DUPLICATE_RESOLUTION_VERBS.find((v) => v.verb === current.verb) ??
    DUPLICATE_RESOLUTION_VERBS[0]!;
  const waitingForPick =
    duplicateResolutionFor(current.verb, item.resolvable, current.pickedId) ===
    null;
  return (
    <div
      data-item-choice={item.forRef}
      className="flex flex-col gap-2 border-t border-foreground/[0.06] pt-3"
    >
      <TwinDoors candidates={item.resolvable} withFor={false} />
      {several && (
        <PickTwin
          twins={item.resolvable}
          value={current.pickedId}
          onChange={(id) => onChoice({ ...current, pickedId: id })}
          disabled={busy}
        />
      )}
      <RadioGroup
        aria-label={`What to do with ${item.forTitle?.trim() || "this item"}`}
        orientation="horizontal"
        size="sm"
        value={current.verb}
        onValueChange={(next) =>
          onChoice({ ...current, verb: next as DuplicateResolutionVerb })
        }
        isDisabled={busy}
      >
        {DUPLICATE_RESOLUTION_VERBS.map((v) => (
          <Radio key={v.verb} value={v.verb}>
            {v.label}
          </Radio>
        ))}
      </RadioGroup>
      <span className="text-[12px] text-foreground/60">
        {waitingForPick ? PICK_TWIN_FIRST : verb.hint}
      </span>
    </div>
  );
}
