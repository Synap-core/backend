"use client";

/**
 * A `:::synap-ask` embed: the session's real question, drawn as the shared
 * `AskAnswer` card (the one door `focusSessions.answerOutput`; no second answer
 * path lives here). Each read state has its own line; the author's prose
 * fallback shows in every state but the open card, which is the question.
 */

import {
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  HelpCircle,
  Info,
  Lock,
  type LucideIcon,
} from "lucide-react";
import type { Embed } from "@synap-core/markdown-core";
import { askEmbedRef } from "@synap-core/types/ask";
import {
  nounInSentence,
  resolveObjectNoun,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import { AskAnswer } from "../../../(admin)/review/_lib/ask-answer";
import { askView } from "../../../(admin)/review/_lib/ask-detail";
import {
  askCardHandlers,
  askCardReceipt,
  receiptStands,
  type AskCardEvent,
  type AskReceipt,
  type EmbedAskRead,
} from "./ask-embed-model";
import { askEmbedT } from "./ask-embed-copy";
import { EmbedHostContext } from "./embed-context";
import { objectPage } from "./markdown-model";

const DOOR =
  "underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";
const CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-md bg-foreground/[0.05] px-2 py-1 text-[12.5px] text-foreground/80 ring-1 ring-inset ring-foreground/10";
const BOX =
  "rounded-lg bg-foreground/[0.02] px-4 pt-4 ring-1 ring-inset ring-foreground/10";

type T = ReturnType<typeof askEmbedT>;

function Line({
  icon: Icon,
  tone,
  children,
}: {
  icon: LucideIcon;
  tone?: "danger";
  children: ReactNode;
}) {
  return (
    <p className="flex flex-wrap items-start gap-x-1.5 gap-y-1 text-[12.5px] text-foreground/65">
      <Icon
        aria-hidden="true"
        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone === "danger" ? "text-danger" : ""}`}
      />
      <span>{children}</span>
    </p>
  );
}

function SessionDoor({
  sessionId,
  t,
  noun,
}: {
  sessionId: string;
  t: T;
  noun: string;
}) {
  const href = objectPage("session", sessionId);
  return href ? (
    <Link href={href} className={`text-[12.5px] ${DOOR}`}>
      {t("door.session", { noun })}
    </Link>
  ) : null;
}

/** The receipt: a mark (and the recorded answer), no controls. */
function Answered({
  mark,
  answer,
  focusOnMount,
  door,
}: {
  mark: string;
  answer: string | null;
  focusOnMount?: boolean;
  door: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-ask-state="answered"
      className="flex flex-col gap-1 rounded-lg px-3 py-2 ring-1 ring-inset ring-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <p className="flex items-start gap-1.5 text-[13px] font-medium text-foreground">
        <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {mark}
      </p>
      {answer && (
        <p className="line-clamp-4 break-words pl-5 text-[13px] text-foreground/85">
          {answer}
        </p>
      )}
      <span className="pl-5">{door}</span>
    </div>
  );
}

function OpenAsk({
  read,
  dispatch,
  t,
  noun,
}: {
  read: Extract<EmbedAskRead, { state: "open" }>;
  dispatch: (event: AskCardEvent) => void;
  t: T;
  noun: string;
}) {
  const door = <SessionDoor sessionId={read.session.id} t={t} noun={noun} />;
  if (!read.canAnswer) {
    return (
      <div data-ask-state="member" className="flex flex-col gap-1">
        <p className="text-[13.5px] font-medium text-foreground">
          {askView(read.slot).heading}
        </p>
        <Line icon={Lock}>{t("member.line", { noun })}</Line>
        {door}
      </div>
    );
  }
  const { title, status, id } = read.session;
  const href = objectPage("session", id);
  const from = title ? t("from.named", { title }) : t("from.unnamed", { noun });
  return (
    <div data-ask-state="open" className={BOX}>
      <p className="mb-3 flex flex-wrap items-baseline gap-x-2 text-[12px] text-foreground/65">
        {href ? (
          <Link href={href} className={DOOR}>
            {from}
          </Link>
        ) : (
          from
        )}
        {status && <span>· {resolveStatusLabel(status)}</span>}
      </p>
      <AskAnswer
        // A new question is a new card: nothing half-made carries over.
        key={`${read.slot.sessionId}:${read.slot.label}`}
        slot={read.slot}
        live={read.slot}
        quietReceipt
        showTalk={false}
        {...askCardHandlers(dispatch)}
      />
    </div>
  );
}

/** What each way of settling says it did. */
function receiptMark(kind: AskReceipt["kind"], t: T): string {
  switch (kind) {
    case "answered":
      return t("answered.sent");
    case "attested":
      return t("answered.attested");
    case "handed-back":
      return t("receipt.handedBack");
    case "refused":
      return t("receipt.refused");
  }
}

function AskBody({
  read,
  receipt,
  dispatch,
  sessionId,
  t,
  noun,
}: {
  read: EmbedAskRead;
  receipt: AskReceipt | null;
  dispatch: (event: AskCardEvent) => void;
  sessionId: string;
  t: T;
  noun: string;
}) {
  const door = <SessionDoor sessionId={sessionId} t={t} noun={noun} />;
  // What the person just did stands over whatever the refresh then reads, in
  // the SAME element (so focus survives): the recorded answer joins it.
  if (receipt && receiptStands(read, receipt)) {
    return (
      <Answered
        mark={receiptMark(receipt.kind, t)}
        answer={read.state === "answered" ? read.answer : null}
        focusOnMount
        door={door}
      />
    );
  }
  switch (read.state) {
    case "loading":
      return (
        <div
          role="status"
          aria-busy="true"
          aria-label={t("loading.aria")}
          data-ask-state="loading"
          className="flex min-h-[240px] flex-col gap-3 rounded-lg px-4 py-4 ring-1 ring-inset ring-foreground/10"
        >
          <span className="h-4 w-2/3 rounded bg-foreground/[0.07] shimmer-pulse" />
          <span className="h-3 w-full rounded bg-foreground/[0.07] shimmer-pulse" />
          <span className="h-10 w-1/2 rounded bg-foreground/[0.07] shimmer-pulse" />
        </div>
      );
    case "failed":
      return (
        <div role="status" data-ask-state="failed">
          <Line icon={AlertTriangle} tone="danger">
            {t("failed.line")}{" "}
            {read.retrying
              ? t("failed.retrying")
              : read.retry && (
                  <button
                    type="button"
                    onClick={read.retry}
                    className={`font-medium text-foreground ${DOOR}`}
                  >
                    {t("failed.retry")}
                  </button>
                )}
          </Line>
        </div>
      );
    case "hidden":
      return (
        <div data-ask-state="hidden">
          <Line icon={Info}>{t("hidden.line")}</Line>
        </div>
      );
    case "closed":
      return (
        <div data-ask-state="closed" className="flex flex-col gap-1">
          <Line icon={HelpCircle}>{t("closed.line")}</Line>
          {door}
        </div>
      );
    case "elsewhere":
      return (
        <div data-ask-state="elsewhere" className="flex flex-col gap-1">
          <Line icon={HelpCircle}>{t("elsewhere.line", { noun })}</Line>
          {door}
        </div>
      );
    case "answered":
      return (
        <Answered
          mark={read.attested ? t("answered.attested") : t("answered.mark")}
          answer={read.answer}
          door={door}
        />
      );
    case "open":
      return <OpenAsk read={read} dispatch={dispatch} t={t} noun={noun} />;
    case "unresolved":
      // This surface reads no sessions: the question is a door to its session.
      return <div data-ask-state="unresolved">{door}</div>;
  }
}

/** One frame for every state: a labelled region, the prose under it. */
export function AskFrame({
  read,
  sessionId,
  prose,
  receipt: seed = null,
}: {
  read: EmbedAskRead;
  sessionId: string;
  prose: ReactNode;
  /** The receipt the card starts with (a test seam; a settle sets it). */
  receipt?: AskReceipt | null;
}) {
  const t = askEmbedT();
  const noun = nounInSentence(resolveObjectNoun("session"));
  const [receipt, dispatch] = useReducer(askCardReceipt, seed);
  const standing = receipt && receiptStands(read, receipt) ? receipt : null;
  return (
    <section
      aria-label={t("section.label")}
      data-embed="ask"
      className="flex min-w-0 flex-col gap-2"
    >
      {/* Announces the receipt only, never the card's inputs. */}
      <p aria-live="polite" className="sr-only">
        {standing ? receiptMark(standing.kind, t) : ""}
      </p>
      <AskBody
        read={read}
        receipt={receipt}
        dispatch={dispatch}
        sessionId={sessionId}
        t={t}
        noun={noun}
      />
      {read.state !== "open" && prose}
    </section>
  );
}

function AskRead({
  useAsk,
  sessionId,
  slot,
  prose,
}: {
  useAsk: (sessionId: string, slot: string) => EmbedAskRead;
  sessionId: string;
  slot: string;
  prose: ReactNode;
}) {
  return (
    <AskFrame
      read={useAsk(sessionId, slot)}
      sessionId={sessionId}
      prose={prose}
    />
  );
}

// Known limit: "Not mine" and relay-reject address the slot by LABEL server-side,
// so with duplicate slot labels they can touch both; the session page does the same.
/** The block form. `fallback` is the author's prose, drawn by the caller's walker. */
export function AskEmbed({
  embed,
  fallback,
}: {
  embed: Embed;
  fallback: ReactNode;
}) {
  const host = useContext(EmbedHostContext);
  const ref = askEmbedRef(embed.ref);
  const t = askEmbedT();
  const prose =
    embed.fallback.length > 0 ? (
      <div className="flex flex-col gap-2 text-foreground/80">{fallback}</div>
    ) : null;
  if (!ref) {
    // Diagnosed on write (`missing-ref`); a reader never drops it silently.
    return (
      <div data-ask-state="broken" className="flex flex-col gap-2">
        <Line icon={AlertTriangle}>{t("broken.line")}</Line>
        {prose}
      </div>
    );
  }
  return host?.useAsk ? (
    <AskRead
      useAsk={host.useAsk}
      sessionId={ref.sessionId}
      slot={ref.slot}
      prose={prose}
    />
  ) : (
    <AskFrame
      read={{ state: "unresolved" }}
      sessionId={ref.sessionId}
      prose={prose}
    />
  );
}

/** Inline in a sentence: only ever the door to the session. */
export function AskChip({ embed }: { embed: Embed }) {
  const t = askEmbedT();
  const ref = askEmbedRef(embed.ref);
  const href = ref ? objectPage("session", ref.sessionId) : null;
  const body = (
    <>
      <HelpCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      {t("inline.mark")}
    </>
  );
  return href ? (
    <Link href={href} className={`${CHIP} ${DOOR}`}>
      {body}
    </Link>
  ) : (
    <span className={CHIP}>{body}</span>
  );
}
