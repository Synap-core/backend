"use client";

/**
 * REFUSE, one trigger and one sheet for every request (founder D2, 16 Nov
 * 2026; UX review M2 / S8): an agent's ask of any mode and a proposal. The
 * request closes, the reason goes to whoever asked, the agent picks its next
 * step. THE VERB FOLLOWS THE OBJECT (one UX across surfaces, D3): an ask is
 * refused, a proposal rejected ({@link refuseVerb}), as desktop and phone
 * say it and as the proposal status vocabulary says "Rejected". The verb
 * comes from the vocabulary door at render (in the reader's language, never
 * a module-load English copy), the rest from the request catalog; the
 * reasons fit the kind of request.
 *
 * The reason sent keeps what the person saw: a picked reason travels as
 * "<reason>: <its hint>", then their own words.
 */

import { useId, useState } from "react";
import { Button, Radio, RadioGroup, Textarea } from "@heroui/react";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { useT } from "../../../lib/i18n/locale-provider";
import { REQUEST_CATALOGS } from "./copy";

/** Which reasons fit: a secret ask, any other ask, a proposal. */
export type RefuseKind = "secret" | "ask" | "proposal";

const REASONS = {
  secret: [
    "refuse.reason.notThisSecret",
    "refuse.reason.otherWay",
    "refuse.reason.notThisWork",
  ],
  ask: [
    "refuse.reason.notNow",
    "refuse.reason.otherWay",
    "refuse.reason.notThisWork",
  ],
  proposal: [
    "refuse.reason.notThisChange",
    "refuse.reason.otherWay",
    "refuse.reason.notThisWork",
  ],
} as const;

type ReasonKey = (typeof REASONS)[RefuseKind][number];

/** The verb a request of this kind is turned down with: an ask is refused, a proposal rejected. */
export function refuseVerb(kind: RefuseKind): "refuse" | "reject" {
  return kind === "proposal" ? "reject" : "refuse";
}

/** The reason as the agent reads it: the picked reason with its hint, then the person's words. */
export function refuseReason(
  picked: { label: string; hint: string } | null,
  words: string
): string | undefined {
  const parts = [
    picked ? `${picked.label}: ${picked.hint}` : "",
    words.trim(),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(". ") : undefined;
}

export const RADIO_CARD = {
  base: "m-0 w-full max-w-full items-start rounded-lg px-3 py-2.5 ring-1 ring-inset ring-foreground/10 data-[selected=true]:bg-primary/[0.06] data-[selected=true]:ring-primary/50",
  labelWrapper: "ml-2 min-w-0",
  description: "text-[12.5px] text-foreground/75",
};

/** "Refuse…" (an ask) or "Reject…" (a proposal): the same size and tone beside every primary verb. */
export function RefuseTrigger({
  kind,
  isDisabled,
  onPress,
}: {
  kind: RefuseKind;
  isDisabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant="bordered"
      className="rq-refuse min-h-11"
      isDisabled={isDisabled}
      onPress={onPress}
      data-refuse-trigger=""
    >
      {`${resolveActionLabel(refuseVerb(kind), "imperative")}…`}
    </Button>
  );
}

export function RefuseSheet({
  kind,
  busy,
  pending,
  onRefuse,
  onCancel,
}: {
  kind: RefuseKind;
  busy: boolean;
  pending: boolean;
  onRefuse: (reason: string | undefined) => void;
  onCancel: () => void;
}) {
  const t = useT(REQUEST_CATALOGS);
  const legendId = useId();
  const [picked, setPicked] = useState<ReasonKey | "">("");
  const [words_, setWords] = useState("");
  const pickedReason = picked
    ? { label: t(picked), hint: t(`${picked}.hint`) }
    : null;
  return (
    <fieldset data-refuse-sheet={kind} className="flex flex-col gap-3">
      <legend id={legendId} className="mb-1 text-[13.5px] font-medium">
        {t("refuse.reasons")}
      </legend>
      <RadioGroup
        aria-labelledby={legendId}
        value={picked}
        onValueChange={(v) => setPicked(v as ReasonKey)}
        isDisabled={busy}
        classNames={{ wrapper: "gap-2" }}
      >
        {REASONS[kind].map((key) => (
          <Radio
            key={key}
            value={key}
            description={t(`${key}.hint`)}
            classNames={RADIO_CARD}
          >
            <span className="text-[13.5px] text-foreground">{t(key)}</span>
          </Radio>
        ))}
      </RadioGroup>
      <Textarea
        minRows={2}
        label={t("refuse.reasonLabel")}
        value={words_}
        onValueChange={setWords}
        isDisabled={busy}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="bordered"
          className="rq-refuse min-h-11"
          isLoading={pending}
          isDisabled={busy}
          onPress={() => onRefuse(refuseReason(pickedReason, words_))}
        >
          {t("refuse.confirm", { verb: refuseVerb(kind) })}
        </Button>
        <Button
          variant="light"
          className="min-h-11"
          isDisabled={pending}
          onPress={onCancel}
        >
          {t("refuse.cancel")}
        </Button>
      </div>
      <p className="text-[12.5px] text-foreground/80">
        {t("refuse.reassure", { verb: refuseVerb(kind) })}
      </p>
    </fieldset>
  );
}
