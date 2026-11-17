"use client";

/**
 * A SECRET ASKED FOR, as the decision (UX review M3): at most three things
 * before the verb, then the verb beside Refuse.
 *
 *   1. one sentence: "Give **GITHUB_TOKEN** to Claude Code so it can merge on
 *      Synap-core/backend." The secret's name is the current choice, with one
 *      door to change it (the person's vault secrets; ui-composition §12);
 *      no purpose → "The agent did not say what it is for" and Ask what for;
 *   2. how long: This session (up to 60 min) · One read (a new grant);
 *   3. [Give for this session] [Refuse…], then one quiet line: who can read
 *      it for how long, and that it stays on the pod.
 *
 * What the agent declared (For · Used by · On) and where a new secret is
 * added sit behind "More about this request" (`SecretFacts`, drawn by the
 * story's depth). One of the person's EXISTING secrets only: a new one is
 * added in the app (founder default B2 covers proposal cards only).
 */

import { useState, type ReactNode } from "react";
import { Button, Select, SelectItem } from "@heroui/react";
import { Check } from "lucide-react";
import { ASK_COPY } from "@synap-core/types/ask";
import { useT } from "../../../../lib/i18n/locale-provider";
import { REQUEST_CATALOGS } from "../../../_lib/request/copy";
import { InDecisionBar } from "../../../_lib/request/decision-footer";
import { SegmentedChoice } from "../../components/segmented-choice";
import {
  OpenInAppLink,
  SECTION_LABEL,
  type ProvideControlProps,
} from "./ask-kit";
import {
  secretCard,
  type SecretCardView,
  type SecretSheet,
} from "./provide-options";

/** A sentence with one bold part, from a catalog line holding `{name}`. */
function withName(sentence: string, mark: string, name: ReactNode): ReactNode {
  const [before, after] = sentence.split(mark);
  return (
    <>
      {before}
      {name}
      {after}
    </>
  );
}

/** Who can read it, for how long — one line, in this surface's one noun ("session"). */
function secretNote(
  card: SecretCardView,
  t: (
    key: "secret.noteOnce" | "secret.noteSession",
    params: { agent: string; minutes: number }
  ) => string
): string {
  const agent = card.usedBy ?? "";
  switch (card.until) {
    case "standing":
      return ASK_COPY.provideStandingGrantNote(agent);
    case "once":
      return t("secret.noteOnce", { agent, minutes: card.minutes });
    case "session":
      return t("secret.noteSession", { agent, minutes: card.minutes });
    default:
      return ASK_COPY.provideNoGrantNote;
  }
}

export function SecretProvide({
  sheet,
  busy,
  pending,
  onProvide,
  onAskWhatFor,
  askedWhatFor,
  refuse,
}: ProvideControlProps & { sheet: SecretSheet }) {
  const t = useT(REQUEST_CATALOGS);
  const [ref, setRef] = useState(sheet.initialRef ?? "");
  const [changing, setChanging] = useState(!sheet.initialRef);
  const [uses, setUses] = useState(sheet.uses);
  const card = secretCard(sheet, ref || null, uses);
  const picked = sheet.choices.find((c) => c.ref === ref) ?? null;
  const has = sheet.choices.length > 0;
  const MARK = "\u0001";
  const name = (
    <>
      <strong className="font-semibold">{picked?.name ?? sheet.name}</strong>
      {has && (
        <>
          {" · "}
          <button
            type="button"
            data-secret-change=""
            onClick={() => setChanging((c) => !c)}
            aria-expanded={changing}
            className="rq-ink font-medium underline underline-offset-2"
          >
            {t("secret.change")}
          </button>
        </>
      )}
    </>
  );
  const agent = card.usedBy;
  const purpose = card.purpose;
  const sentence = !agent
    ? t("secret.giveNoAgent", { name: MARK })
    : purpose?.action && purpose.on
      ? t("secret.giveToForOn", {
          name: MARK,
          agent,
          action: purpose.action,
          on: purpose.on,
        })
      : purpose?.action
        ? t("secret.giveToFor", { name: MARK, agent, action: purpose.action })
        : t("secret.giveTo", { name: MARK, agent });
  const verb =
    card.until === "once"
      ? t("secret.giveOnce")
      : card.until === "session"
        ? t("secret.giveSession")
        : t("secret.give");

  return (
    <div data-secret-give="" className="flex flex-col gap-4">
      <p className="text-[15px] leading-relaxed text-foreground">
        {withName(sentence, MARK, name)}
      </p>
      {has && changing && (
        <Select
          aria-label={ASK_COPY.providePickSecret}
          placeholder={ASK_COPY.providePickSecret}
          selectedKeys={ref ? [ref] : []}
          onSelectionChange={(keys) => {
            const next = [...(keys as Set<string>)][0] ?? "";
            setRef(next);
            if (next) setChanging(false);
          }}
          isDisabled={busy}
          classNames={{ trigger: "min-h-11" }}
        >
          {sheet.choices.map((c) => (
            <SelectItem key={c.ref} textValue={c.name} description={c.type}>
              {c.name}
            </SelectItem>
          ))}
        </Select>
      )}
      {!purpose && (
        <p
          data-secret-no-purpose=""
          className="flex flex-wrap items-center gap-2 text-[13.5px] text-status-stale"
        >
          {ASK_COPY.provideNoPurpose}
          {onAskWhatFor && (
            <Button
              size="sm"
              variant="flat"
              className="min-h-11"
              isDisabled={busy || askedWhatFor}
              onPress={onAskWhatFor}
            >
              {t("secret.askWhatFor")}
            </Button>
          )}
        </p>
      )}
      {!has && (
        <p data-secret-none="" className="text-[13.5px] text-foreground/85">
          {t("secret.none")}
        </p>
      )}
      {card.canPickUses && (
        <div className="flex flex-col gap-1.5">
          <span className={SECTION_LABEL}>{t("secret.howLong")}</span>
          <SegmentedChoice
            ariaLabel={t("secret.howLong")}
            active={uses}
            options={[
              {
                key: "session" as const,
                label: t("secret.usesSession", {
                  minutes: secretCard(sheet, ref || null, "session").minutes,
                }),
              },
              { key: "once" as const, label: t("secret.usesOnce") },
            ]}
            onSelect={(k) => setUses(k)}
          />
        </div>
      )}
      <InDecisionBar>
        {has && (
          <Button
            color="primary"
            className="min-h-11 font-semibold"
            startContent={<Check className="h-4 w-4" />}
            isLoading={pending}
            isDisabled={busy || !ref}
            onPress={() =>
              onProvide(
                { kind: "secret", vaultRef: ref },
                {
                  ...(sheet.expectedGranteeId
                    ? { expectedGranteeId: sheet.expectedGranteeId }
                    : {}),
                  ...(card.canPickUses ? { secretUses: uses } : {}),
                }
              )
            }
          >
            {verb}
          </Button>
        )}
        {refuse}
      </InDecisionBar>
      <p
        data-secret-grant-note=""
        className="text-[12.5px] leading-relaxed text-foreground/80"
      >
        {secretNote(card, t)} {t("secret.stays")}
      </p>
    </div>
  );
}

/**
 * What the agent declared (For · Used by · On) and where a new secret is
 * added: the depth of a secret ask, behind "More about this request".
 */
export function SecretFacts({
  sheet,
  sessionId,
}: {
  sheet: SecretSheet;
  sessionId: string;
}) {
  const t = useT(REQUEST_CATALOGS);
  const p = sheet.purpose;
  const facts: Array<[string, string]> = p
    ? [
        [t("secret.for"), p.for],
        [t("secret.usedBy"), p.action ? `${p.tool} (${p.action})` : p.tool],
        ...(p.on ? ([[t("secret.on"), p.on]] as Array<[string, string]>) : []),
      ]
    : [];
  return (
    <div data-secret-facts="" className="flex flex-col gap-3">
      {facts.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
          {facts.map(([label, value]) => (
            <div key={label} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-[12.5px] text-foreground/75">{label}</dt>
              <dd className="break-words text-[14px] text-foreground">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-foreground/80">
        {ASK_COPY.provideAddSecretInApp}
        <OpenInAppLink sessionId={sessionId} />
      </p>
    </div>
  );
}
