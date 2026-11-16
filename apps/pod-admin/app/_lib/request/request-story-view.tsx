"use client";

/**
 * ONE REQUEST AS ONE STORY (option B, founder 16 Nov 2026, plan d717d6ac
 * §1): a vertical timeline of the session it came from, drawn from the
 * shared model (`requestStory`, `@synap-core/types/needs-you`), for an
 * agent's ask AND a proposal, in Review's detail and on `/proposal/[id]`.
 *
 *   header  an eyebrow (what kind of request · its session), the title, one
 *           sentence (what for);
 *   before  who asked and what the work is for (the head);
 *   the timeline, one item per line: [when | rail mark | what]
 *     past     a solid sage dot on a solid rail: the last steps, repeats
 *              grouped ("2 times"), older ones folded ("3 more events ·
 *              Show", a door to the whole story);
 *     NOW      the one loud mark, a filled ochre ring, "Now": the decision
 *              (the subject, what it needs from you, the verbs, what refusing
 *              does), in a tinted box for an ask;
 *     next     dashed muted rings on a dashed rail ("next", "then"): what it
 *              unblocks, the status the thing cannot reach yet, an agent or
 *              sessions that wait on it.
 *   depth   behind Show, last (Advanced, what the agent looked at).
 *
 * A part whose read FAILED is said where it belongs ("couldn't read"), never
 * drawn as "nothing happened" or "nothing waits" (ui-composition §2). The
 * marks are `globals.css` `.rq-mark-*`: colour = state, never a chip alone.
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

/** The detail's head: what kind of request, the title, what it is for. */
export interface StoryHeader {
  eyebrow: string | null;
  title: string;
  sentence: string | null;
}

const BEFORE_PARTS: ReadonlySet<RequestContextPartName> = new Set(["timeline"]);
const NOW_PARTS: ReadonlySet<RequestContextPartName> = new Set([
  "aiCanDo",
  "subject",
]);

type Mark = "done" | "now" | "next";

// ─── One item of the timeline ───────────────────────────────────────────────

function Item({
  when,
  mark,
  last,
  node,
  children,
}: {
  when: ReactNode;
  mark: Mark;
  /** No rail below the last item. */
  last?: boolean;
  /** `data-story-node`: which part of the story it is. */
  node: "past" | "now" | "after";
  children: ReactNode;
}) {
  return (
    <li data-story-node={node} className="flex gap-3">
      <span
        className={`w-16 shrink-0 pt-0.5 text-right text-[12px] tabular-nums ${
          mark === "now" ? "rq-ink font-semibold" : "text-foreground/55"
        }`}
      >
        {when}
      </span>
      <span aria-hidden className="relative flex w-5 shrink-0 justify-center">
        <span
          className={`rq-mark rq-mark-${mark} relative z-[1] ${mark === "now" ? "mt-0.5" : "mt-1"}`}
        />
        {!last && (
          <span
            className={`absolute bottom-0 left-1/2 top-4 -translate-x-1/2 ${
              mark === "next" ? "rq-rail-next" : "rq-rail-done"
            }`}
          />
        )}
      </span>
      <div
        className={`flex min-w-0 flex-1 flex-col gap-3 pb-5 ${
          mark === "next" ? "text-foreground/70" : ""
        }`}
      >
        {children}
      </div>
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
          className="text-[12.5px] text-status-stale"
        >
          {u.line}
        </li>
      ))}
    </ul>
  );
}

// ─── Before ──────────────────────────────────────────────────────────────────

function PastLine({
  group,
  fold,
}: {
  group: RequestStoryGroup;
  /** On the oldest shown line: "3 more events · Show". */
  fold: ReactNode;
}) {
  return (
    <div data-story-event={group.kind} className="flex flex-col gap-0.5">
      <DoorMark
        door={group.door}
        className="min-w-0 break-words text-[13.5px] text-foreground/90"
      >
        {group.line}
      </DoorMark>
      <span className="flex flex-wrap items-baseline gap-x-1.5 text-[12px] text-foreground/55">
        <span>{activityActorName(group.actor)}</span>
        {group.repeat && (
          <>
            <span aria-hidden>·</span>
            <span>{group.repeat}</span>
          </>
        )}
        {group.url && (
          <>
            <span aria-hidden>·</span>
            <a
              href={group.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline-offset-2 hover:underline"
            >
              {group.url.replace(/^https:\/\/(www\.)?/, "").slice(0, 48)}
            </a>
          </>
        )}
        {fold}
      </span>
    </div>
  );
}

function StoryHead({ story }: { story: RequestStory }) {
  const t = useT(REQUEST_CATALOGS);
  const { by, cause, session } = story.head;
  if (!by && !cause && !session) return null;
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]">
      {(by || cause) && (
        <div className="flex items-baseline gap-2">
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
        <div className="flex items-baseline gap-2">
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
    <section data-story-subject={subject.kind} className="flex flex-col gap-2">
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
        className="inline-flex min-w-0 items-center gap-1.5 text-[13.5px] font-medium text-foreground"
      >
        <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{title ?? t("story.subjectOpen")}</span>
      </DoorMark>
    </section>
  );
}

// ─── Next ────────────────────────────────────────────────────────────────────

function Step({ step }: { step: RequestStoryStep }) {
  const t = useT(REQUEST_CATALOGS);
  switch (step.kind) {
    case "unblocks":
      return (
        <div data-story-after="unblocks" className="text-[13.5px]">
          <span className="text-foreground/55">{step.label}</span>{" "}
          <DoorMark door={step.door}>{step.text}</DoorMark>
        </div>
      );
    case "thing":
      return (
        <div
          data-story-after="thing"
          className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]"
        >
          <DoorMark door={step.door}>
            {step.line ?? step.thing.name ?? ""}
          </DoorMark>
          {step.statusNow && step.statusNext && (
            <span className="text-[12px] text-foreground/55">
              {t("story.statusMove", {
                now: step.statusNow.label,
                next: step.statusNext.label,
              })}
            </span>
          )}
        </div>
      );
    case "agent_waits":
      return (
        <div data-story-after="agent_waits" className="text-[13.5px]">
          <DoorMark door={step.door}>{step.line}</DoorMark>
        </div>
      );
    case "sessions_wait":
      return (
        <div
          data-story-after="sessions_wait"
          className="flex flex-col gap-0.5 text-[13.5px]"
        >
          <span>{step.line}</span>
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {step.sessions.map((s) => (
              <DoorMark
                key={s.id}
                door={s.door}
                className="text-[12px] text-foreground/60"
              >
                {s.title}
              </DoorMark>
            ))}
          </span>
        </div>
      );
  }
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
  header,
  head,
  showSubject = true,
  boxed = false,
  afterExtra,
  depth,
  children,
}: {
  /** The shared model; null while nothing is known (loading, failed, off). */
  story: RequestStory | null;
  read: StoryRead;
  /** The eyebrow, title and sentence above the story (a host with no frame title). */
  header?: StoryHeader;
  /** Replaces the default head (who asked, what the work is for). */
  head?: ReactNode;
  /** Draw the context's subject at the top of Now (asks); a proposal's change is its subject. */
  showSubject?: boolean;
  /** The decision in a tinted box (an ask's Now). */
  boxed?: boolean;
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
  const unreadable = story?.unreadable ?? [];
  const pastUnreadable = unreadable.filter((u) => BEFORE_PARTS.has(u.part));
  const nowUnreadable = unreadable.filter((u) => NOW_PARTS.has(u.part));
  const afterUnreadable = unreadable.filter(
    (u) => !BEFORE_PARTS.has(u.part) && !NOW_PARTS.has(u.part)
  );
  const subject = story?.now.subject ?? null;
  const steps = story?.after ?? [];
  // "Nothing else waits" only when the read answered and named nothing:
  // never over a failed or missing read.
  const reassure =
    read.status === "ok" &&
    steps.length === 0 &&
    afterUnreadable.length === 0 &&
    !afterExtra;
  const hasAfter =
    steps.length > 0 || afterUnreadable.length > 0 || !!afterExtra || reassure;
  const fold =
    story && (story.folded || story.olderExist) && story.timelineDoor ? (
      <>
        <span aria-hidden>·</span>
        {story.folded && <span>{story.folded.label}</span>}
        <DoorMark
          door={story.timelineDoor}
          className="relative font-medium text-primary"
        >
          {story.folded ? t("story.foldShow") : t("story.fullTimeline")}
        </DoorMark>
      </>
    ) : null;
  const past = story?.before ?? [];

  return (
    <div className="flex flex-col gap-5">
      {header && (
        <header className="flex flex-col gap-1.5">
          {header.eyebrow && (
            <span data-story-eyebrow="" className="rq-eyebrow rq-ink">
              {header.eyebrow}
            </span>
          )}
          <h2 className="font-heading text-[24px] font-medium leading-tight text-foreground">
            {header.title}
          </h2>
          {header.sentence && (
            <p className="text-[15px] leading-relaxed text-foreground/75">
              {header.sentence}
            </p>
          )}
        </header>
      )}
      <div data-story-node="before" className="flex flex-col gap-3">
        {head ?? (story && <StoryHead story={story} />)}
      </div>
      <ol
        aria-label={t("story.label")}
        data-request-story=""
        className="flex flex-col"
      >
        {read.status === "loading" && (
          <Item when="" mark="done" node="past">
            <p className="text-[12.5px] text-foreground/55">
              {t("story.loading")}
            </p>
          </Item>
        )}
        {read.status === "error" && (
          <Item when="" mark="done" node="past">
            <p
              data-story-unreadable="all"
              className="flex flex-wrap items-center gap-2 text-[12.5px] text-status-stale"
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
          </Item>
        )}
        {past.map((g, i) => (
          <Item
            key={g.key}
            when={formatRelative(g.at, { empty: "" })}
            mark="done"
            node="past"
          >
            <PastLine group={g} fold={i === 0 ? fold : null} />
          </Item>
        ))}
        {past.length === 0 && fold && (
          <Item when="" mark="done" node="past">
            <span className="flex flex-wrap gap-x-1.5 text-[12px] text-foreground/55">
              {fold}
            </span>
          </Item>
        )}
        {pastUnreadable.length > 0 && (
          <Item when="" mark="done" node="past">
            <Unreadable lines={pastUnreadable} />
          </Item>
        )}
        <Item when={t("story.now")} mark="now" node="now" last={!hasAfter}>
          <div
            className={
              boxed ? "rq-now-box flex flex-col gap-4" : "flex flex-col gap-5"
            }
          >
            {showSubject && subject && <StorySubject subject={subject} />}
            {children}
          </div>
          {story?.now.meanwhile && (
            <p className="text-[12.5px] text-foreground/65">
              <span className="font-medium text-foreground/55">
                {story.now.meanwhile.label}
              </span>{" "}
              {story.now.meanwhile.text}
            </p>
          )}
          <Unreadable lines={nowUnreadable} />
        </Item>
        {afterExtra && (
          <Item
            when={t("story.whenNext")}
            mark="next"
            node="after"
            last={steps.length === 0 && afterUnreadable.length === 0}
          >
            {afterExtra}
          </Item>
        )}
        {steps.map((s, i) => (
          <Item
            key={s.key}
            when={
              i === 0 && !afterExtra ? t("story.whenNext") : t("story.whenThen")
            }
            mark="next"
            node="after"
            last={i === steps.length - 1 && afterUnreadable.length === 0}
          >
            <Step step={s} />
          </Item>
        ))}
        {afterUnreadable.length > 0 && (
          <Item when={t("story.whenNext")} mark="next" node="after" last>
            <Unreadable lines={afterUnreadable} />
          </Item>
        )}
        {reassure && (
          <Item when={t("story.whenNext")} mark="next" node="after" last>
            <p className="text-[12.5px] text-foreground/55">
              {t("story.nothingAfter")}
            </p>
          </Item>
        )}
      </ol>
      {depth}
    </div>
  );
}
