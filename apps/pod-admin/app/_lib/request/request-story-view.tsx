"use client";

/**
 * ONE REQUEST AS ONE STORY (option B, founder 16 Nov 2026, plan d717d6ac
 * §1), ONE frame for an agent's ask AND a proposal, in Review's detail and on
 * `/proposal/[id]`, drawn from the shared model (`requestStory`,
 * `@synap-core/types/needs-you`):
 *
 *   head     "Asked by <requester> · For <session>" (`StoryHead`), both kinds;
 *   timeline one item per line: [when | rail mark | what]
 *     past   a solid sage dot on a solid rail: the last steps, repeats
 *            grouped; older ones folded into their own first row, a door to
 *            the whole story;
 *     NOW    the one loud mark, a filled ochre ring: what you decide (the
 *            subject, the change or question, what it needs from you), and
 *            what the agent does meanwhile; below it the rail turns dashed;
 *     next   dashed rings ("Next", "Then"): what deciding does, what it
 *            unblocks, the status the thing cannot reach yet, sessions that
 *            wait on it;
 *   footer   the decision bar, the story's own footer: pinned to the bottom
 *            of the scroll box on the card's own surface (never inside Now,
 *            where it cut the rail);
 *   depth    behind Show, last.
 *
 * In a story narrower than 480 px (a phone, the docked panel: a container
 * query, not the viewport) the "when" column folds into the line ("11h ago ·
 * Checks passed") and the rail narrows. A part whose read FAILED is said where it
 * belongs, never drawn as "nothing happened" or "nothing waits"
 * (ui-composition §2). The marks are `globals.css` `.rq-mark-*`.
 */

import { useState, type ReactNode } from "react";
import { Button } from "@heroui/react";
import { ArrowUpRight, ChevronRight, RotateCw } from "lucide-react";
import {
  activityActorName,
  type ActivityActor,
} from "@synap-core/types/activity";
import type { LensDoor } from "@synap-core/types/lens";
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

type Mark = "done" | "now" | "next" | "wait" | "unread";

// ─── One item of the timeline ───────────────────────────────────────────────

function Item({
  when,
  mark,
  rail,
  node,
  children,
}: {
  when: string;
  mark: Mark;
  /** The rail BELOW this item, toward the next one; none on the last. */
  rail: "done" | "next" | null;
  /** `data-story-node`: which part of the story it is. */
  node: "past" | "now" | "after";
  children: ReactNode;
}) {
  const now = mark === "now";
  return (
    <li data-story-node={node} className="rq-item flex">
      <span
        className={`rq-when-col w-16 shrink-0 pt-0.5 text-right text-[12px] tabular-nums ${
          now ? "rq-ink font-semibold" : "text-foreground/70"
        }`}
      >
        {when}
      </span>
      <span
        aria-hidden
        className="rq-rail-col relative flex shrink-0 justify-center"
      >
        <span
          className={`rq-mark rq-mark-${mark} relative z-[1] ${now ? "mt-0.5" : "mt-1"}`}
        />
        {rail && (
          <span
            className={`absolute bottom-0 left-1/2 top-4 -translate-x-1/2 rq-rail-${rail}`}
          />
        )}
      </span>
      <div
        className={`flex min-w-0 flex-1 flex-col gap-2 pb-5 ${
          mark === "next" ? "text-foreground/80" : ""
        }`}
      >
        {when && (
          <span
            className={`rq-when-inline text-[12px] ${now ? "rq-ink font-semibold" : "text-foreground/70"}`}
          >
            {when}
          </span>
        )}
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

// ─── The head ────────────────────────────────────────────────────────────────

/** Who asked, named once, as a door. */
export interface StoryRequester {
  label: string;
  door: LensDoor | null;
}

/**
 * "Asked by <requester> · For <session>": the ONE head of every request. A
 * proposal names its requester with the shared sentence (`proposalRequester`);
 * an ask with the agent the pod named.
 */
export function StoryHead({
  requester,
  session,
  extra,
}: {
  requester: StoryRequester | null;
  session: { title: string; door: LensDoor } | null;
  /** Said after them (an ask's age and what silence does). */
  extra?: ReactNode;
}) {
  const t = useT(REQUEST_CATALOGS);
  if (!requester && !session && !extra) return null;
  return (
    <dl
      data-story-head=""
      className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[13px]"
    >
      {requester && (
        <div className="flex items-baseline gap-2">
          <dt className="text-foreground/70">{t("story.askedBy")}</dt>
          <dd>
            <DoorMark
              door={requester.door}
              className="font-medium text-foreground"
            >
              {requester.label}
            </DoorMark>
          </dd>
        </div>
      )}
      {session && (
        <div className="flex items-baseline gap-2">
          <dt className="text-foreground/70">{t("story.forSession")}</dt>
          <dd>
            <DoorMark door={session.door} className="text-foreground">
              {session.title}
            </DoorMark>
          </dd>
        </div>
      )}
      {extra}
    </dl>
  );
}

/** The head the shared model gives: its `by` (or cause) and its session. */
export function storyRequester(
  story: RequestStory | null
): StoryRequester | null {
  if (!story) return null;
  const { by, cause } = story.head;
  if (by)
    return { label: by.label, door: by.door ?? { kind: "agent", id: by.id } };
  if (cause) return { label: cause.label, door: cause.door };
  return null;
}

// ─── Before ──────────────────────────────────────────────────────────────────

function PastLine({
  group,
  actorName,
}: {
  group: RequestStoryGroup;
  actorName: (actor: ActivityActor) => string;
}) {
  return (
    <div data-story-event={group.kind} className="flex flex-col gap-0.5">
      <DoorMark
        door={group.door}
        className="min-w-0 break-words text-[13.5px] text-foreground"
      >
        {group.line}
      </DoorMark>
      <span className="flex flex-wrap items-baseline gap-x-1.5 text-[12px] text-foreground/70">
        <span data-story-actor="">{actorName(group.actor)}</span>
        {group.repeat && (
          <>
            <span aria-hidden>·</span>
            <span data-story-repeat="">{group.repeat}</span>
          </>
        )}
        {group.url && (
          <>
            <span aria-hidden>·</span>
            <a
              href={group.url}
              target="_blank"
              rel="noreferrer noopener"
              className="rq-ink inline-flex items-center gap-0.5 underline underline-offset-2"
            >
              {group.url.replace(/^https:\/\/(www\.)?/, "")}
              <ArrowUpRight aria-hidden className="h-3 w-3" />
            </a>
          </>
        )}
      </span>
    </div>
  );
}

// ─── Now ─────────────────────────────────────────────────────────────────────

/** What the request is about: a preview when it has media, and its door. */
function StorySubject({
  subject,
}: {
  subject: NonNullable<RequestStory["now"]["subject"]>;
}) {
  const t = useT(REQUEST_CATALOGS);
  if (subject.kind === "url") {
    return (
      <section data-story-subject="url" className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium text-foreground/70">
          {t("story.subject")}
        </span>
        <a
          href={subject.url}
          target="_blank"
          rel="noreferrer noopener"
          className="rq-ink break-all text-[13px] underline underline-offset-2"
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
      <span className="text-[12.5px] font-medium text-foreground/70">
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
          <span className="text-foreground/70">{step.label}</span>{" "}
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
            <span className="text-[12px] text-foreground/70">
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
                className="text-[12.5px] text-foreground/80"
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
        className="-ml-2 min-h-11 self-start text-foreground/80"
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
      {/* Kept in the page while closed (hidden), so what it holds stays one
          read away and is never fetched twice. */}
      <div hidden={!open} className="flex flex-col gap-3">
        {children}
      </div>
    </div>
  );
}

/** The decision bar's base: the story's footer, on the card's own surface. */
export const STORY_FOOTER =
  "z-10 flex flex-col gap-2 border-t border-foreground/[0.08] bg-content1";

// ─── The story ───────────────────────────────────────────────────────────────

export function RequestStoryView({
  story,
  read,
  head,
  showSubject = true,
  afterExtra,
  footer,
  depth,
  children,
}: {
  /** The shared model; null while nothing is known (loading, failed, off). */
  story: RequestStory | null;
  read: StoryRead;
  /** The head (`StoryHead`); default: the shared model's requester and session. */
  head?: ReactNode;
  /** Draw the context's subject at the top of Now (asks); a proposal's change is its subject. */
  showSubject?: boolean;
  /** Said first under Next, before the shared steps (what approving does). */
  afterExtra?: ReactNode;
  /** The decision bar, the story's footer (the host pins it). */
  footer?: ReactNode;
  /** Depth, last and collapsed (a proposal's ONE Advanced; an ask's `StoryDepth`). */
  depth?: ReactNode;
  /** What is decided, in the Now order the host owns. */
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
  // "An agent waits on this" says what holds NOW, not what comes next.
  const waits = (story?.after ?? []).filter((s) => s.kind === "agent_waits");
  const steps = (story?.after ?? []).filter((s) => s.kind !== "agent_waits");
  // "Nothing else waits" only when the read answered and named nothing:
  // never over a failed or missing read.
  const reassure =
    read.status === "ok" &&
    steps.length === 0 &&
    afterUnreadable.length === 0 &&
    !afterExtra;
  const past = story?.before ?? [];
  const fold =
    story && (story.folded || story.olderExist) && story.timelineDoor
      ? { label: story.folded?.label ?? null, door: story.timelineDoor }
      : null;
  // The requester is named once, the same way in the head and the past.
  const requester = storyRequester(story);
  const actorName = (actor: ActivityActor) =>
    requester &&
    story?.head.by &&
    actor.kind === "agent" &&
    actor.id === story.head.by.id
      ? requester.label
      : activityActorName(actor);

  type Entry = {
    key: string;
    when: string;
    mark: Mark;
    node: "past" | "now" | "after";
    body: ReactNode;
  };
  const entries: Entry[] = [];
  if (read.status === "loading") {
    for (const k of ["load-1", "load-2"])
      entries.push({
        key: k,
        when: "",
        mark: "wait",
        node: "past",
        body: (
          <span
            aria-hidden={k === "load-2"}
            className="h-4 w-48 max-w-full animate-pulse rounded bg-foreground/[0.08]"
          >
            <span className="sr-only">{t("story.loading")}</span>
          </span>
        ),
      });
  }
  if (read.status === "error") {
    entries.push({
      key: "failed",
      when: "",
      mark: "unread",
      node: "past",
      body: (
        <p
          data-story-unreadable="all"
          className="flex flex-wrap items-center gap-2 text-[12.5px] text-status-stale"
        >
          {t("story.failed")}
          <Button
            size="sm"
            variant="light"
            className="min-h-11"
            startContent={<RotateCw className="h-3 w-3" aria-hidden />}
            onPress={read.retry}
          >
            {t("story.retry")}
          </Button>
        </p>
      ),
    });
  }
  if (fold) {
    entries.push({
      key: "fold",
      when: "",
      mark: "wait",
      node: "past",
      body: (
        <span
          data-story-fold=""
          className="flex flex-wrap items-baseline gap-x-1.5 text-[12.5px] text-foreground/70"
        >
          {fold.label && <span>{fold.label}</span>}
          {fold.label && <span aria-hidden>·</span>}
          <DoorMark door={fold.door} className="rq-ink font-medium">
            {t("story.fullTimeline")}
          </DoorMark>
        </span>
      ),
    });
  }
  let lastWhen = "";
  for (const g of past) {
    const when = formatRelative(g.at, { empty: "" });
    entries.push({
      key: g.key,
      // A time is printed when it changes from the line above.
      when: when === lastWhen ? "" : when,
      mark: "done",
      node: "past",
      body: <PastLine group={g} actorName={actorName} />,
    });
    lastWhen = when;
  }
  if (pastUnreadable.length > 0)
    entries.push({
      key: "past-unread",
      when: "",
      mark: "unread",
      node: "past",
      body: <Unreadable lines={pastUnreadable} />,
    });
  const pastCount = entries.length;
  entries.push({
    key: "now",
    when: t("story.now"),
    mark: "now",
    node: "now",
    body: (
      <>
        <div className="flex flex-col gap-5">
          {showSubject && subject && <StorySubject subject={subject} />}
          {children}
        </div>
        {waits.map((s) => (
          <Step key={s.key} step={s} />
        ))}
        {story?.now.meanwhile && (
          <p className="text-[12.5px] text-foreground/80">
            <span className="font-medium text-foreground/70">
              {story.now.meanwhile.label}
            </span>{" "}
            {story.now.meanwhile.text}
          </p>
        )}
        <Unreadable lines={nowUnreadable} />
      </>
    ),
  });
  const next: ReactNode[] = [];
  if (afterExtra) next.push(afterExtra);
  for (const s of steps) next.push(<Step key={s.key} step={s} />);
  if (afterUnreadable.length > 0)
    next.push(<Unreadable key="after-unread" lines={afterUnreadable} />);
  if (reassure)
    next.push(
      <p key="reassure" className="text-[12.5px] text-foreground/70">
        {t("story.nothingAfter")}
      </p>
    );
  next.forEach((body, i) =>
    entries.push({
      key: `next-${i}`,
      when: i === 0 ? t("story.whenNext") : t("story.whenThen"),
      mark: "next",
      node: "after",
      body,
    })
  );

  return (
    <div className="rq-story flex flex-col gap-5">
      <div data-story-node="before" className="flex flex-col gap-3">
        {head ?? (
          <StoryHead
            requester={requester}
            session={
              story?.head.session
                ? {
                    title: story.head.session.title,
                    door: story.head.session.door,
                  }
                : null
            }
          />
        )}
      </div>
      <ol
        aria-label={t("story.label")}
        data-request-story=""
        className="flex flex-col"
      >
        {entries.map((e, i) => {
          const below = entries[i + 1];
          // The rail toward the next item: solid through the past into Now,
          // dashed from Now on.
          const rail = !below ? null : i >= pastCount ? "next" : "done";
          return (
            <Item
              key={e.key}
              when={e.when}
              mark={e.mark}
              rail={rail}
              node={e.node}
            >
              {e.body}
            </Item>
          );
        })}
      </ol>
      {footer}
      {depth}
    </div>
  );
}
