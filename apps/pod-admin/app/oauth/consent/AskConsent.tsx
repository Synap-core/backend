"use client";

/**
 * The SHORT consent (plan 647ebfd4 option C; design A "short ask"): a pod
 * app already connected asks for ONE MORE thing. Only what it asks now is
 * shown, marked New, in the words "It can" uses ("Edit tasks in Builder"),
 * with the developer's reason; the raw permission sits in the developer fold.
 * "In" and "It changes things in" show their current answer, Unchanged.
 * Allowing ADDS what it asks; nothing it holds changes here.
 *
 * Two sources (W3d contract v1.1): the contract's `app.access.ask` when the
 * pod sends it (only for a connection that names a project), else today's
 * `app.ask` (pairs, each at the place the app asked). On the contract's ask,
 * a place the connection does not hold is unavailable and Allow refuses it,
 * so the screen blocks Allow and says why. Q4: when it changes nothing yet
 * and now asks to, where it may is a new choice: the picker appears, starts
 * on the ask's own space (tagged Asked), and lists only places it can
 * already look in.
 */

import { useId } from "react";
import Link from "next/link";
import { Alert, Button, Chip } from "@heroui/react";
import { permissionLabel } from "./consent-model";
import {
  andList,
  draftOf,
  heldAccessOf,
  inPhrase,
  isWriteTier,
  needsWritePlace,
  readParts,
  writePhrase,
  accessOfNamed,
  type ConsentContract,
  type ConsentDraft,
  type ConsentOffer,
} from "./consent-access";
import { ConsentLine, ConsentLines } from "./ConsentLine";
import { Disclosure, WriteChoices } from "./AccessChoices";
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

/** One short ask, from either source, as the screen draws it. */
export interface AskView {
  /** One line per permission it asks: its words, reason and raw permission. */
  lines: Array<{
    permission: string;
    /** "Edit tasks", in the vocabulary's words. */
    what: string;
    /** Where it would hold, from the ask's pairs; null: where it works now. */
    where: string[] | null;
    reason: string | null;
  }>;
  /** What it asked that cannot be given. */
  unavailable: string[];
  /** The contract's ask: Allow refuses an unavailable item (v1.1). */
  unavailableBlocks: boolean;
  connectionPublicId: string | null;
  /** Q4: it changes nothing yet and asks to. */
  needsWritePlace: boolean;
  /** The spaces the ask itself names: pre-ticked and tagged Asked. */
  askedSpaceIds: string[];
}

/** The short ask from the contract when present, else from today's pairs. */
export function askViewOf(input: {
  ask: ConsentAsk | null;
  contract: ConsentContract | null;
  offer: ConsentOffer;
}): AskView | null {
  const { ask, contract, offer } = input;
  const reasonOf = (permission: string) =>
    offer.items.find((i) => i.permission === permission)?.reason ?? null;
  if (contract?.ask) {
    const a = contract.ask;
    return {
      lines: a.adds.map((x) => ({
        permission: x.permission,
        what: permissionLabel(x.permission),
        where: null,
        reason: x.reason?.trim() || reasonOf(x.permission),
      })),
      unavailable: [...a.unavailable],
      unavailableBlocks: true,
      connectionPublicId: a.connectionPublicId,
      needsWritePlace: a.needsWritePlace,
      askedSpaceIds: [],
    };
  }
  if (!ask) return null;
  const lines: AskView["lines"] = [];
  for (const p of ask.pairs) {
    const known = lines.find((l) => l.permission === p.permission);
    if (known) {
      if (!known.where!.includes(p.workspaceName))
        known.where!.push(p.workspaceName);
    } else
      lines.push({
        permission: p.permission,
        what: permissionLabel(p.permission),
        where: [p.workspaceName],
        reason: reasonOf(p.permission),
      });
  }
  return {
    lines,
    unavailable: [...ask.unavailable],
    unavailableBlocks: false,
    connectionPublicId: ask.connectionPublicId,
    needsWritePlace: false,
    askedSpaceIds: [...new Set(ask.pairs.map((p) => p.workspaceId))],
  };
}

/**
 * Where the connection works now, for the Unchanged lines: the contract's
 * `current` (projects included) when present, else the lift of its pairs.
 */
export function askCurrentOf(
  app: {
    approved: ReadonlyArray<{ permission: string; workspaceId: string | null }>;
  },
  contract: ConsentContract | null
): ConsentDraft | null {
  if (contract?.current) return draftOf(accessOfNamed(contract.current));
  const held = heldAccessOf(app.approved);
  return held.kind === "access" ? draftOf(held.access) : null;
}

export function AskConsent({
  appName,
  view,
  offer,
  current,
  names,
  busy,
  step,
  onDecide,
  writePlace = null,
}: {
  appName: string;
  view: AskView;
  offer: ConsentOffer;
  current: ConsentDraft | null;
  names: Readonly<Record<string, string>>;
  busy: boolean;
  step: Step;
  onDecide: (approve: boolean) => void;
  /** Q4's picker, when the ask needs a first write place. */
  writePlace?: {
    draft: ConsentDraft;
    onChange: (next: ConsentDraft) => void;
  } | null;
}) {
  const t = consentT();
  const id = useId();
  const failed = step.kind === "error" ? step.message : null;
  const writes = writePlace
    ? writePlace.draft.write.spaces.length +
      writePlace.draft.write.projects.length
    : 1;
  const blocked =
    view.unavailableBlocks && view.unavailable.length > 0
      ? t("ask.unavailableBlocked")
      : writePlace && writes === 0
        ? t("ask.blocked")
        : null;
  const unchanged = { text: t("mark.unchanged"), tone: "default" as const };
  // A line's place: the ask's own spaces, else where it works now.
  const whereOf = (line: AskView["lines"][number]) => {
    if (line.where) return t("place.in", { name: andList(line.where) });
    if (!current) return "";
    if (isWriteTier(line.permission)) {
      const w = writePhrase(current, names);
      return w ? t("place.in", { name: w }) : "";
    }
    return readParts(current, names) === "all"
      ? t("place.everywhere")
      : t("place.in", { name: inPhrase(current, names) });
  };
  // Q4: only places it can already look in.
  const within = current
    ? current.read.spaces === "all"
      ? { spaces: "all" as const, projects: "all" as const }
      : { spaces: current.read.spaces, projects: current.read.projects }
    : undefined;
  return (
    <div className="flex flex-col gap-5">
      <ul className="flex flex-col divide-y divide-foreground/10 rounded-lg bg-foreground/[0.03] px-4 py-1 ring-1 ring-inset ring-foreground/10">
        {view.lines.map((line) => (
          <li key={line.permission} className="flex flex-col gap-0.5 py-2.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground/90">
                {t("ask.line", { what: line.what, where: whereOf(line) })}
              </span>
              <Chip size="sm" variant="flat" color="primary">
                {t("mark.new")}
              </Chip>
            </span>
            {line.reason ? (
              <span className="text-pretty text-xs leading-relaxed text-foreground/75">
                {/* The developer's words, as text: why it asks. */}
                <span className="text-foreground/65">
                  {t("reason.prefix")}{" "}
                </span>
                {line.reason}
              </span>
            ) : null}
            <Disclosure label={t("dev.toggle")}>
              <span className="font-mono text-[11px] text-foreground/65">
                {line.permission}
              </span>
            </Disclosure>
          </li>
        ))}
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
                {within && within.spaces !== "all"
                  ? ` ${t("ask.withinIn")}`
                  : ""}
              </span>
              <div className="pt-2">
                <WriteChoices
                  draft={writePlace.draft}
                  offer={offer}
                  isDisabled={busy}
                  onChange={writePlace.onChange}
                  asked={view.askedSpaceIds}
                  within={within}
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
        {view.unavailable.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs leading-relaxed text-foreground/75">
              {view.unavailableBlocks
                ? t("ask.unavailableBlocked")
                : t("ask.unavailable")}
            </p>
            {view.unavailableBlocks ? (
              <ul className="flex flex-col gap-1">
                {view.unavailable.map((u) => (
                  <li
                    key={u}
                    className="flex items-center justify-between gap-3 text-xs text-foreground/80"
                  >
                    {permissionLabel(u.split("@")[0] ?? u)}
                    <Chip size="sm" variant="flat">
                      {t("cant.notGiven")}
                    </Chip>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <p className="text-pretty text-xs leading-relaxed text-foreground/65">
          {t("ask.keeps")}
          {/* Q4 changes where it works: the "never changes" sentence would
              contradict the picker above (U4). */}
          {view.connectionPublicId && !writePlace ? (
            <>
              {" "}
              {t("ask.stays")}{" "}
              <Link
                href={`/apps/${encodeURIComponent(view.connectionPublicId)}`}
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
