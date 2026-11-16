"use client";

/**
 * ONE REQUEST AS ONE STORY (option B, founder 16 Nov 2026, plan d717d6ac
 * §1): a vertical timeline of the session it came from, drawn from the
 * shared model (`requestStory`, `@synap-core/types/needs-you`), for an
 * agent's ask AND a proposal, in Review's detail and on `/proposal/[id]`.
 *
 *   BEFORE  solid: who asked and what the work is for (the head), then the
 *           last steps, repeats grouped, older ones folded ("4 more events ·
 *           Show", a door to the whole story);
 *   NOW     the node that holds the decision, in this order (addendum, 16
 *           Nov): the subject (what you decide, previewed, a door), what it
 *           needs from you (the hand-over), the decision, what refusing does;
 *   NEXT    dashed: what deciding unblocks, the status the thing it holds
 *           cannot reach yet, an agent or sessions that wait on it.
 *   DEPTH   behind Show, last: the raw request, the ids, Advanced.
 *
 * A part whose read FAILED is said where it belongs ("couldn't read"), never
 * drawn as "nothing happened" or "nothing waits" (ui-composition §2). The
 * host passes its own decision content as `children`; this file owns the
 * frame and the shared lines only.
 */

import { useState, type ReactNode } from "react";
import { Button } from "@heroui/react";
import { ChevronRight, RotateCw } from "lucide-react";
import { activityActorName } from "@synap-core/types/activity";
import type {
  RequestContextPartName,
  RequestStory,
  RequestStoryGroup,
  RequestStoryStep,
} from "@synap-core/types/needs-you";
import { formatRelative } from "../../../lib/format";
import { useT } from "../../../lib/i18n/locale-provider";
import { MediaView } from "../media/media-view";
import { kindIcon } from "../object/kind-icon";
import { REQUEST_CATALOGS } from "./copy";
import { DoorMark } from "./door-mark";

/** How the page's context read stands, for the parts the story reads from it. */
export type StoryRead =
  | { status: "loading" }
  | { status: "error"; retry: () => void }
  | { status: "ok" }
  /** Nothing to read: a decided proposal, a request no session holds. */
  | { status: "off" };

const BEFORE_PARTS: ReadonlySet<RequestContextPartName> = new Set(["timeline"]);
const NOW_PARTS: ReadonlySet<RequestContextPartName> = new Set([
  "aiCanDo",
  "subject",
]);

// ─── The frame ───────────────────────────────────────────────────────────────

function Node({
  label,
  tone,
  children,
}: {
  label: string;
  tone: "before" | "now" | "after";
  children: ReactNode;
}) {
  const rail =
    tone === "before"
      ? "border-foreground/20"
      : tone === "now"
        ? "border-primary/60"
        : "border-dashed border-foreground/25";
  const dot =
    tone === "before"
      ? "bg-foreground/40"
      : tone === "now"
        ? "bg-primary ring-4 ring-primary/15"
        : "border border-dashed border-foreground/40 bg-content1";
  return (
    <li
      data-story-node={tone}
      aria-label={label}
      className={`relative flex flex-col gap-3 border-l-2 pb-5 pl-5 last:pb-0 ${rail}`}
    >
      <span
        aria-hidden
        className={`absolute -left-[7px] top-0.5 h-3 w-3 rounded-full ${dot}`}
      />
      <span className="text-[11.5px] font-medium text-foreground/55">
        {label}
      </span>
      {children}
    </li>
  );
}

function Unreadable({ lines }: { lines: RequestStory["unreadable"] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {lines.map((u) => (
        <li
          key={u.part}
          data-story-unreadable={u.part}
          className="text-[12px] text-status-stale"
        >
          {u.line}
        </li>
      ))}
    </ul>
  );
}

// ─── Before ──────────────────────────────────────────────────────────────────

function PastLine({ group }: { group: RequestStoryGroup }) {
  return (
    <li
      data-story-event={group.kind}
      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]"
    >
      <DoorMark
        door={group.door}
        className="min-w-0 break-words text-foreground/85"
      >
        {group.line}
      </DoorMark>
      {group.repeat && (
        <span className="text-[12px] text-foreground/55">{group.repeat}</span>
      )}
      <span className="text-[12px] text-foreground/55">
        {activityActorName(group.actor)}
      </span>
      <span className="tabular-nums text-[12px] text-foreground/45">
        {formatRelative(group.at, { empty: "" })}
      </span>
      {group.url && (
        <a
          href={group.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[12px] text-primary underline-offset-2 hover:underline"
        >
          {group.url.replace(/^https:\/\/(www\.)?/, "").slice(0, 48)}
        </a>
      )}
    </li>
  );
}

function StoryHead({ story }: { story: RequestStory }) {
  const t = useT(REQUEST_CATALOGS);
  const { by, cause, session } = story.head;
  if (!by && !cause && !session) return null;
  return (
    <dl className="flex flex-col gap-1 text-[12.5px]">
      {(by || cause) && (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-foreground/55">{t("story.askedBy")}</dt>
          <dd>
            {by ? (
              <DoorMark
                door={by.door ?? { kind: "agent", id: by.id }}
                className="font-medium text-foreground/85"
              >
                {by.label}
              </DoorMark>
            ) : cause ? (
              <DoorMark door={cause.door} className="text-foreground/85">
                {cause.label}
              </DoorMark>
            ) : null}
          </dd>
        </div>
      )}
      {session && (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-foreground/55">{t("story.forSession")}</dt>
          <dd>
            <DoorMark door={session.door} className="text-foreground/85">
              {session.title}
            </DoorMark>
          </dd>
        </div>
      )}
    </dl>
  );
}

function Before({
  story,
  read,
  head,
}: {
  story: RequestStory | null;
  read: StoryRead;
  head?: ReactNode;
}) {
  const t = useT(REQUEST_CATALOGS);
  const unreadable = (story?.unreadable ?? []).filter((u) =>
    BEFORE_PARTS.has(u.part)
  );
  return (
    <Node label={t("story.before")} tone="before">
      {head ?? (story && <StoryHead story={story} />)}
      {read.status === "loading" && (
        <p className="text-[12px] text-foreground/55">{t("story.loading")}</p>
      )}
      {read.status === "error" && (
        <p
          data-story-unreadable="all"
          className="flex flex-wrap items-center gap-2 text-[12px] text-status-stale"
        >
          {t("story.failed")}
          <Button
            size="sm"
            variant="light"
            startContent={<RotateCw className="h-3 w-3" aria-hidden />}
            onPress={read.retry}
          >
            {t("story.retry")}
          </Button>
        </p>
      )}
      {story && (story.folded || story.olderExist) && story.timelineDoor && (
        <p className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-foreground/55">
          {story.folded && <span>{story.folded.label}</span>}
          <DoorMark
            door={story.timelineDoor}
            className="font-medium text-primary"
          >
            {story.folded ? t("story.foldShow") : t("story.fullTimeline")}
          </DoorMark>
        </p>
      )}
      {story && story.before.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {story.before.map((g) => (
            <PastLine key={g.key} group={g} />
          ))}
        </ol>
      )}
      <Unreadable lines={unreadable} />
    </Node>
  );
}

// ─── Now ─────────────────────────────────────────────────────────────────────

/** What the request is about: a preview when it has media, and its door. */
export function StorySubject({
  subject,
}: {
  subject: NonNullable<RequestStory["now"]["subject"]>;
}) {
  const t = useT(REQUEST_CATALOGS);
  if (subject.kind === "url") {
    return (
      <section data-story-subject="url" className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-foreground/65">
          {t("story.subject")}
        </span>
        <a
          href={subject.url}
          target="_blank"
          rel="noreferrer noopener"
          className="break-all text-[13px] text-primary underline-offset-2 hover:underline"
        >
          {subject.url}
        </a>
      </section>
    );
  }
  const Icon = kindIcon(subject.profileSlug ?? subject.kind);
  const title = subject.title?.trim() || null;
  return (
    <section
      data-story-subject={subject.kind}
      className="flex flex-col gap-2 rounded-lg bg-foreground/[0.02] p-3 ring-1 ring-inset ring-foreground/10"
    >
      <span className="text-[12px] font-medium text-foreground/65">
        {t("story.subject")}
      </span>
      {subject.media && (
        <MediaView
          media={subject.media}
          alt={title ?? ""}
          size="full"
          viaEntityId={subject.kind === "entity" ? subject.id : null}
        />
      )}
      <DoorMark
        door={subject.door}
        className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-foreground"
      >
        <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{title ?? t("story.subjectOpen")}</span>
      </DoorMark>
    </section>
  );
}

function Now({
  story,
  showSubject,
  children,
}: {
  story: RequestStory | null;
  showSubject: boolean;
  children: ReactNode;
}) {
  const t = useT(REQUEST_CATALOGS);
  const unreadable = (story?.unreadable ?? []).filter((u) =>
    NOW_PARTS.has(u.part)
  );
  const subject = story?.now.subject ?? null;
  return (
    <Node label={t("story.now")} tone="now">
      {showSubject && subject && <StorySubject subject={subject} />}
      {children}
      {story?.now.meanwhile && (
        <p className="text-[12.5px] text-foreground/70">
          <span className="font-medium text-foreground/60">
            {story.now.meanwhile.label}
          </span>{" "}
          {story.now.meanwhile.text}
        </p>
      )}
      <Unreadable lines={unreadable} />
    </Node>
  );
}

// ─── Next ────────────────────────────────────────────────────────────────────

function Step({ step }: { step: RequestStoryStep }) {
  const t = useT(REQUEST_CATALOGS);
  switch (step.kind) {
    case "unblocks":
      return (
        <li data-story-after="unblocks" className="text-[12.5px]">
          <span className="font-medium text-foreground/60">{step.label}</span>{" "}
          <DoorMark door={step.door} className="text-foreground/85">
            {step.text}
          </DoorMark>
        </li>
      );
    case "thing":
      return (
        <li
          data-story-after="thing"
          className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]"
        >
          <DoorMark door={step.door} className="text-foreground/85">
            {step.line ?? step.thing.name ?? ""}
          </DoorMark>
          {step.statusNow && step.statusNext && (
            <span className="text-[12px] text-foreground/60">
              {t("story.statusMove", {
                now: step.statusNow.label,
                next: step.statusNext.label,
              })}
            </span>
          )}
        </li>
      );
    case "agent_waits":
      return (
        <li data-story-after="agent_waits" className="text-[12.5px]">
          <DoorMark door={step.door} className="text-foreground/85">
            {step.line}
          </DoorMark>
        </li>
      );
    case "sessions_wait":
      return (
        <li
          data-story-after="sessions_wait"
          className="flex flex-col gap-1 text-[12.5px]"
        >
          <span className="text-foreground/85">{step.line}</span>
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {step.sessions.map((s) => (
              <DoorMark
                key={s.id}
                door={s.door}
                className="text-[12px] text-foreground/70"
              >
                {s.title}
              </DoorMark>
            ))}
          </span>
        </li>
      );
  }
}

function After({
  story,
  read,
  extra,
}: {
  story: RequestStory | null;
  read: StoryRead;
  extra?: ReactNode;
}) {
  const t = useT(REQUEST_CATALOGS);
  const unreadable = (story?.unreadable ?? []).filter(
    (u) => !BEFORE_PARTS.has(u.part) && !NOW_PARTS.has(u.part)
  );
  const steps = story?.after ?? [];
  // "Nothing else waits" only when the read answered and named nothing:
  // never over a failed or missing read.
  const reassure =
    read.status === "ok" &&
    steps.length === 0 &&
    unreadable.length === 0 &&
    !extra;
  return (
    <Node label={t("story.after")} tone="after">
      {extra}
      {steps.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {steps.map((s) => (
            <Step key={s.key} step={s} />
          ))}
        </ul>
      )}
      {reassure && (
        <p className="text-[12px] text-foreground/55">
          {t("story.nothingAfter")}
        </p>
      )}
      <Unreadable lines={unreadable} />
    </Node>
  );
}

// ─── Depth ───────────────────────────────────────────────────────────────────

/** What a careful reader may open, behind one Show, last. */
export function StoryDepth({ children }: { children: ReactNode }) {
  const t = useT(REQUEST_CATALOGS);
  const [open, setOpen] = useState(false);
  return (
    <div data-story-depth="" className="flex flex-col gap-2">
      <Button
        size="sm"
        variant="light"
        radius="md"
        className="-ml-2 self-start text-foreground/70"
        aria-expanded={open}
        startContent={
          <ChevronRight
            aria-hidden
            className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
        }
        onPress={() => setOpen((o) => !o)}
      >
        {t("story.depth")}
      </Button>
      {open && <div className="flex flex-col gap-3">{children}</div>}
    </div>
  );
}

// ─── The story ───────────────────────────────────────────────────────────────

export function RequestStoryView({
  story,
  read,
  head,
  showSubject = true,
  afterExtra,
  depth,
  children,
}: {
  /** The shared model; null while nothing is known (loading, failed, off). */
  story: RequestStory | null;
  read: StoryRead;
  /** Replaces the default head (who asked, what the work is for). */
  head?: ReactNode;
  /** Draw the context's subject at the top of Now (asks); a proposal's change is its subject. */
  showSubject?: boolean;
  /** Said first under Next, before the shared steps (what approving does). */
  afterExtra?: ReactNode;
  /**
   * Depth, last and collapsed: the host's own disclosures (a proposal's ONE
   * Advanced; an ask's `StoryDepth`).
   */
  depth?: ReactNode;
  /** The decision, in the Now order the host owns. */
  children: ReactNode;
}) {
  const t = useT(REQUEST_CATALOGS);
  return (
    <div className="flex flex-col gap-4">
      <ol
        aria-label={t("story.label")}
        data-request-story=""
        className="ml-1.5 flex flex-col"
      >
        <Before story={story} read={read} head={head} />
        <Now story={story} showSubject={showSubject}>
          {children}
        </Now>
        <After story={story} read={read} extra={afterExtra} />
      </ol>
      {depth}
    </div>
  );
}
