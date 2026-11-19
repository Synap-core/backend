"use client";

/**
 * The SHORT consent (plan 647ebfd4 option C; design A "short ask"): a pod
 * app already connected asks for ONE MORE thing (`synap_ask`). Only what it
 * asks now is shown, marked New, with the developer's reason and the raw
 * permission; "In" and "It changes things in" show their current answer,
 * marked Unchanged. Allowing ADDS the asked pairs to what the app holds;
 * nothing it holds is changed here. Taking access back stays on its page.
 *
 * One exception (decision fc37f740 Q4): when the app changes nothing yet and
 * now asks to, where it may is a new choice, and the picker appears here
 * (`writePlace`, wired once the W3d contract carries it).
 *
 * Every line naming a permission and a space comes from the server's ask
 * (`getOAuthConsentContext().app.ask`) through the one summary door
 * (`summarizeAppConnectRequest`), never written here.
 */

import { useId, useMemo } from "react";
import Link from "next/link";
import { Alert, Button, Chip } from "@heroui/react";
import { summarizeAppConnectRequest } from "@synap-core/types/proposals/intent";
import {
  draftOf,
  heldAccessOf,
  inPhrase,
  needsWritePlace,
  offerOf,
  placeNames,
  writePhrase,
  type ConsentAppWire,
  type ConsentDraft,
} from "./consent-access";
import { ConsentLine, ConsentLines } from "./ConsentLine";
import { WriteChoices } from "./AccessChoices";
import { consentT } from "./copy";
import type { Step } from "./ConsentForm";

export interface ConsentAsk {
  title: string;
  pairs: Array<{
    permission: string;
    workspaceId: string;
    workspaceName: string;
  }>;
  unavailable: string[];
  connectionPublicId: string | null;
}

/** The app as the short consent reads it: its offer and what it holds. */
export type AskApp = ConsentAppWire & {
  approved: ReadonlyArray<{ permission: string; workspaceId: string | null }>;
};

/** How many distinct permissions an ask names (its title counts them). */
export function askCount(ask: ConsentAsk): number {
  return new Set(ask.pairs.map((p) => p.permission)).size;
}

export function AskConsent({
  app,
  appName,
  ask,
  busy,
  step,
  onDecide,
  writePlace = null,
}: {
  app: AskApp;
  appName: string;
  ask: ConsentAsk;
  busy: boolean;
  step: Step;
  onDecide: (approve: boolean) => void;
  /**
   * The app changes nothing yet and now asks to (Q4): the place it may, a
   * new choice. null while the contract does not carry it.
   */
  writePlace?: {
    draft: ConsentDraft;
    onChange: (next: ConsentDraft) => void;
  } | null;
}) {
  const t = consentT();
  const id = useId();
  const offer = useMemo(() => offerOf(app), [app]);
  const names = placeNames(offer);
  const held = useMemo(() => heldAccessOf(app.approved), [app.approved]);
  const current = held.kind === "access" ? draftOf(held.access) : null;
  const lines = summarizeAppConnectRequest({
    appName,
    requests: ask.pairs,
    mode: "add",
  }).lines;
  const failed = step.kind === "error" ? step.message : null;
  const writes = writePlace
    ? writePlace.draft.write.spaces.length +
      writePlace.draft.write.projects.length
    : 1;
  const blocked = writePlace && writes === 0 ? t("ask.blocked") : null;
  const unchanged = { text: t("mark.unchanged"), tone: "default" as const };
  return (
    <div className="flex flex-col gap-5">
      <ul className="flex flex-col divide-y divide-foreground/10 rounded-lg bg-foreground/[0.03] px-4 py-1 ring-1 ring-inset ring-foreground/10">
        {lines.map((line) => {
          const pairs = ask.pairs.filter(
            (p) => p.workspaceId === line.workspaceId
          );
          const reasons = [
            ...new Set(
              pairs
                .map(
                  (p) =>
                    offer.items.find((i) => i.permission === p.permission)
                      ?.reason ?? null
                )
                .filter((r): r is string => !!r)
            ),
          ];
          return (
            <li
              key={line.workspaceId ?? line.where}
              className="flex flex-col gap-0.5 py-2.5"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground/90">
                  {line.text}
                </span>
                <Chip size="sm" variant="flat" color="primary">
                  {t("mark.new")}
                </Chip>
              </span>
              {reasons.map((r) => (
                <span
                  key={r}
                  className="text-pretty text-xs leading-relaxed text-foreground/75"
                >
                  {/* The developer's words, as text: why it asks. */}
                  <span className="text-foreground/65">
                    {t("reason.prefix")}{" "}
                  </span>
                  {r}
                </span>
              ))}
              <span className="font-mono text-[11px] text-foreground/65">
                {[...new Set(pairs.map((p) => p.permission))].join(" · ")}
              </span>
            </li>
          );
        })}
      </ul>

      {current || writePlace ? (
        <ConsentLines>
          {current ? (
            <ConsentLine line="in" label={t("line.in")} mark={unchanged}>
              {inPhrase(current, names)}
            </ConsentLine>
          ) : null}
          {writePlace ? (
            <ConsentLine
              line="write"
              label={t("line.write")}
              needsYou={writes === 0}
            >
              <strong className="font-medium">{t("ask.pickFor")}</strong>
              <span className="text-xs text-foreground/65">
                {t("ask.newChoice")}
              </span>
              <div className="pt-2">
                <WriteChoices
                  draft={writePlace.draft}
                  offer={offer}
                  isDisabled={busy}
                  onChange={writePlace.onChange}
                />
              </div>
            </ConsentLine>
          ) : current && needsWritePlace(current) ? (
            <ConsentLine line="write" label={t("line.write")} mark={unchanged}>
              {writePhrase(current, names) ?? t("in.nowhere")}
            </ConsentLine>
          ) : null}
        </ConsentLines>
      ) : null}

      <div className="flex flex-col gap-1">
        {ask.unavailable.length > 0 ? (
          <p className="text-xs leading-relaxed text-foreground/65">
            {t("ask.unavailable")}
          </p>
        ) : null}
        <p className="text-pretty text-xs leading-relaxed text-foreground/65">
          {t("ask.keeps")}
          {ask.connectionPublicId ? (
            <>
              {" "}
              {t("ask.stays")}{" "}
              <Link
                href={`/apps/${encodeURIComponent(ask.connectionPublicId)}`}
                className="text-foreground/75 underline underline-offset-2"
              >
                {t("ask.page")}
              </Link>
              .
            </>
          ) : null}
        </p>
      </div>

      {failed !== null ? (
        <Alert
          color="danger"
          role="alert"
          title={t("allowFailed.title", { name: appName })}
          description={
            <span className="flex flex-col gap-0.5">
              <span>{t("allowFailed.hint")}</span>
              {failed ? (
                <span className="break-words text-xs">{failed}</span>
              ) : null}
            </span>
          }
        />
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex gap-2.5">
          <Button
            color="primary"
            radius="md"
            size="md"
            className="flex-1 font-medium"
            isDisabled={busy || blocked !== null}
            isLoading={busy && step.kind === "working" && step.approve}
            aria-describedby={blocked ? `${id}-blocked` : undefined}
            onPress={() => onDecide(true)}
          >
            {failed !== null ? t("act.tryAgain") : t("act.allow")}
          </Button>
          <Button
            variant="flat"
            radius="md"
            size="md"
            className="flex-1"
            isDisabled={busy}
            isLoading={busy && step.kind === "working" && !step.approve}
            onPress={() => onDecide(false)}
          >
            {t("act.notNow")}
          </Button>
        </div>
        {blocked ? (
          <p
            id={`${id}-blocked`}
            className="text-center text-xs text-foreground/75"
          >
            {blocked}
          </p>
        ) : null}
      </div>
    </div>
  );
}
