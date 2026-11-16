/**
 * THE REQUEST CONTEXT READ — `signals.needsYou({ include: ["context"] })`:
 * what a page of needs-you rows needs to tell each request's story
 * (`requestStory`, `@synap-core/types/needs-you`), read ONCE for the page,
 * never per row (founder decision 1 A, plan d717d6ac §5). Each part comes
 * from its one owner:
 *
 *   timeline       `readSessionTimelines` — the timeline door's projection,
 *                  a page of sessions in a fixed number of queries;
 *   aiCanDo        `aiCanDoItems` — the continuation packet's rule, over ONE
 *                  read of the page's session rows;
 *   waiting        ONE read of the open sessions that wait on them
 *                  (`session --blocked_by--> session`, the packet's
 *                  `unblocks` edge), under the session floor;
 *   proposalWaits  ONE read of the page's proposals under the proposal floor,
 *                  then `resolveProposalWaits` (batched per page itself);
 *   subject        the object each row is about (an owed slot's `slotRef`,
 *                  the target its proposals share), ONE read per object kind
 *                  through `scopedDb` — the registered visibility rule the
 *                  attach-output floor (`isOutputRefVisible`) applies — so a
 *                  ref the reader cannot read resolves to nothing and its
 *                  title is never served.
 *
 * What the rows already carry (`unblocks`, `blocks`, `by`, `askCause`, the
 * session title) is not read again. A part whose read FAILED is
 * `unreadable` for every row it would have answered: the failure is logged
 * and the rest of the context still answers.
 */

import {
  and,
  db,
  eq,
  focusSessions,
  inArray,
  links,
  OPEN_SESSION_STATUSES,
  proposals,
  drizzleSql,
} from "@synap/database";
import {
  automations,
  documents,
  entities,
  playbooks,
  profiles,
  views,
} from "@synap/database/schema";
import { isHttpUrl } from "@synap/shared-utils";
import { createLogger } from "@synap-core/core";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import type {
  NeedsYouContextRead,
  RequestAiCanDo,
  RequestContextPart,
  RequestRowContext,
  RequestSessionContext,
  RequestSessionTimeline,
  RequestSubject,
  RequestSubjectKind,
  RequestWaitingSessions,
} from "@synap-core/types/needs-you";
import {
  REQUEST_CONTEXT_LIST_CAP,
  REQUEST_CONTEXT_TIMELINE_DEFAULT,
  REQUEST_SUBJECT_KINDS,
} from "@synap-core/types/needs-you";
import {
  presentationFromUiHints,
  resolveEntityMedia,
  type MediaRef,
} from "@synap-core/types/presentation";
import type { ProposalWaits } from "@synap-core/types/proposals/fate";
import { isUuid } from "@synap-core/types/property-render";
import type { ExpectedOutput } from "@synap/playbooks";

// The BARREL, not the leaf modules: importing it runs `registry.ts`'s
// registration side effects, without which `scopedDb` throws on every table.
import { AccessContext, scopedDb } from "../../access/index.js";
import {
  sessionReadableWhere,
  type SessionReader,
} from "../../access/session-visibility.js";
import { proposalUserFloor } from "../../routers/proposals/scope-conditions.js";
import { aiCanDoItems } from "../focus-sessions/continuation-packet.js";
import { resolveProposalWaits } from "../proposals/proposal-waits.js";
import { readSessionTimelines } from "../timeline/read-timeline.js";

const logger = createLogger({ module: "needs-you-context" });

/** The fields of a needs-you row this read looks at (the `Signal` shape). */
export interface NeedsYouContextRow {
  id: string;
  kind: string;
  title: string;
  target?: { kind: string; id: string } | null;
  groupKey?: string | null;
  proposalIds?: string[];
  /** An owed slot's `ref` (`ExpectedOutput.ref`): what the ask is about. */
  slotRef?: { kind: string; id: string } | { url: string } | null;
}

/** A ref this read resolves: an in-pod object, or a link. */
type SubjectRef = { kind: RequestSubjectKind; id: string } | { url: string };

function isSubjectKind(kind: string): kind is RequestSubjectKind {
  return (REQUEST_SUBJECT_KINDS as readonly string[]).includes(kind);
}

/** A proposal's target, when it names an in-pod object this read resolves. */
function proposalTargetRef(p: {
  targetType: string;
  targetId: string;
}): SubjectRef | null {
  return isSubjectKind(p.targetType) && isUuid(p.targetId)
    ? { kind: p.targetType, id: p.targetId }
    : null;
}

const refKey = (r: SubjectRef) =>
  "url" in r ? `url:${r.url}` : `${r.kind}:${r.id}`;

/** One kind's titles under the reader's floor (one read for the page). */
async function readTitles(
  kind: Exclude<RequestSubjectKind, "entity" | "cell">,
  ids: string[],
  access: AccessContext
): Promise<Map<string, RequestSubject>> {
  const out = new Map<string, RequestSubject>();
  if (kind === "document") {
    const rows = await scopedDb(access).findMany<{
      id: string;
      title: string;
      mimeType: string | null;
    }>(documents, {
      where: inArray(documents.id, ids),
      columns: { id: true, title: true, mimeType: true },
    });
    for (const r of rows) {
      // A stored image, video or sound is the document's own media; the
      // display door signs it and owns the allowlist (`MediaRef`).
      const media: MediaRef | null =
        r.mimeType && /^(image|video|audio)\//.test(r.mimeType)
          ? { via: "stored", documentId: r.id, mime: r.mimeType }
          : null;
      out.set(r.id, {
        kind,
        id: r.id,
        title: r.title,
        ...(media ? { media } : {}),
      });
    }
    return out;
  }
  const table =
    kind === "view" ? views : kind === "automation" ? automations : playbooks;
  const rows = await scopedDb(access).findMany<{ id: string; name: string }>(
    table,
    { where: inArray(table.id, ids), columns: { id: true, name: true } }
  );
  for (const r of rows) out.set(r.id, { kind, id: r.id, title: r.name });
  return out;
}

/** The page's entities under the reader's floor, with their kind and media. */
async function readEntitySubjects(
  ids: string[],
  access: AccessContext
): Promise<Map<string, RequestSubject>> {
  void access;
  const rows = await (db.query.entities.findMany as (o: unknown) => Promise<unknown[]>)({
    where: inArray(entities.id, ids),
    columns: { id: true, title: true, profileId: true, documentId: true, properties: true, systemData: true },
  }) as unknown as Array<{
    id: string;
    title: string | null;
    profileId: string | null;
    documentId: string | null;
    properties: Record<string, unknown> | null;
    systemData: unknown;
  }>;
  const profileIds = [
    ...new Set(rows.flatMap((r) => (r.profileId ? [r.profileId] : []))),
  ];
  // A profile is the pod's schema (its slug and how its things are drawn),
  // not a record: read for the entities the floor already returned.
  const profileRows =
    profileIds.length === 0
      ? []
      : await db
          .select({
            id: profiles.id,
            slug: profiles.slug,
            uiHints: profiles.uiHints,
          })
          .from(profiles)
          .where(inArray(profiles.id, profileIds));
  const profileById = new Map(profileRows.map((p) => [p.id, p]));
  const out = new Map<string, RequestSubject>();
  for (const r of rows) {
    const profile = r.profileId ? profileById.get(r.profileId) : undefined;
    const { primary } = resolveEntityMedia(
      r,
      presentationFromUiHints(profile?.uiHints)
    );
    out.set(r.id, {
      kind: "entity",
      id: r.id,
      title: r.title,
      ...(profile ? { profileSlug: profile.slug } : {}),
      ...(primary.via !== "none" ? { media: primary } : {}),
    });
  }
  return out;
}

/**
 * Every ref of the page, resolved: one read per object kind. A ref the reader
 * cannot read (or that names nothing) is missing from the map.
 */
async function readSubjects(
  refs: readonly SubjectRef[],
  userId: string
): Promise<Map<string, RequestSubject>> {
  const out = new Map<string, RequestSubject>();
  const idsOf = new Map<RequestSubjectKind, Set<string>>();
  for (const r of refs) {
    if ("url" in r) {
      // A link has no row to authorize; it is drawn, so it is scheme-gated.
      if (isHttpUrl(r.url)) out.set(refKey(r), { kind: "url", url: r.url });
      continue;
    }
    // A cell has no backing row: nothing to read, nothing to leak.
    if (r.kind === "cell") {
      out.set(refKey(r), { kind: "cell", id: r.id, title: null });
      continue;
    }
    if (!isUuid(r.id)) continue;
    const set = idsOf.get(r.kind) ?? new Set<string>();
    set.add(r.id);
    idsOf.set(r.kind, set);
  }
  const access = AccessContext.operator({ userId });
  const reads = await Promise.all(
    [...idsOf].map(async ([kind, set]) => {
      const ids = [...set];
      return kind === "entity"
        ? readEntitySubjects(ids, access)
        : readTitles(
            kind as Exclude<RequestSubjectKind, "entity" | "cell">,
            ids,
            access
          );
    })
  );
  for (const read of reads) {
    for (const subject of read.values())
      out.set(refKey(subject as SubjectRef), subject);
  }
  return out;
}

/**
 * Who reads, and how far. No workspace lens: the rows are already the
 * reader's (floored and scoped by the needs-you read); this read only tells
 * their story.
 */
export interface NeedsYouContextReader extends Omit<SessionReader, "lens"> {
  /** Timeline items per session; default {@link REQUEST_CONTEXT_TIMELINE_DEFAULT}. */
  timelineItems?: number;
}

const SESSION_KEY = "session:";
const UNREADABLE = { status: "unreadable" } as const;

/** The session a row names: its door, else its group (`session:<id>`). */
function sessionOfRow(row: NeedsYouContextRow): string | null {
  if (row.target?.kind === "session" && isUuid(row.target.id)) {
    return row.target.id;
  }
  const key = row.groupKey ?? "";
  if (key.startsWith(SESSION_KEY)) {
    const id = key.slice(SESSION_KEY.length);
    return isUuid(id) ? id : null;
  }
  return null;
}

/** A proposal row's members: its sample, else its one door. */
function proposalIdsOf(row: NeedsYouContextRow): string[] {
  if (row.kind !== "proposal-cluster") return [];
  const ids = row.proposalIds?.length
    ? row.proposalIds
    : row.target?.kind === "proposal"
      ? [row.target.id]
      : [];
  return [...new Set(ids.filter(isUuid))];
}

/** Run one part; a failure is logged and the part reads `unreadable`. */
async function part<T>(
  name: string,
  read: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    logger.warn({ err, part: name }, "needs-you context: a part failed");
    return { ok: false };
  }
}

export async function readNeedsYouContext(
  rows: readonly NeedsYouContextRow[],
  reader: NeedsYouContextReader
): Promise<NeedsYouContextRead> {
  const timelineItems =
    reader.timelineItems ?? REQUEST_CONTEXT_TIMELINE_DEFAULT;
  const floor: SessionReader = {
    userId: reader.userId,
    roster: reader.roster,
  };

  // The page's proposals, under the proposal floor (one read): each one's
  // session joins the page's sessions, and its waits are resolved below.
  const allProposalIds = [...new Set(rows.flatMap(proposalIdsOf))];
  const proposalRows = await part("proposals", () =>
    allProposalIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            id: proposals.id,
            proposalType: proposals.proposalType,
            status: proposals.status,
            sessionId: proposals.sessionId,
            targetType: proposals.targetType,
            targetId: proposals.targetId,
            data: proposals.data,
          })
          .from(proposals)
          .where(
            and(
              inArray(proposals.id, allProposalIds),
              proposalUserFloor(reader.userId)
            )
          )
  );
  const proposalById = new Map(
    proposalRows.ok ? proposalRows.value.map((p) => [p.id, p]) : []
  );

  // Each row's session: its own, else the one session all its proposals share.
  const rowSession = new Map<string, string | null>();
  for (const row of rows) {
    let sessionId = sessionOfRow(row);
    if (!sessionId) {
      const sessions = new Set(
        proposalIdsOf(row).map((id) => proposalById.get(id)?.sessionId ?? null)
      );
      const [only] = [...sessions];
      if (sessions.size === 1 && only && isUuid(only)) sessionId = only;
    }
    rowSession.set(row.id, sessionId);
  }
  const sessionIds = [
    ...new Set(
      [...rowSession.values()].filter((id): id is string => id !== null)
    ),
  ];

  // Each row's subject ref: an owed slot's `ref`; a proposal row's target,
  // when every member it stands for names the same one. A proposal row whose
  // members could not be read has no ref to resolve: its subject is
  // unreadable, never absent.
  const rowSubjectRef = new Map<string, SubjectRef | "unreadable">();
  for (const row of rows) {
    const ref = row.slotRef;
    if (ref && "url" in ref) rowSubjectRef.set(row.id, { url: ref.url });
    else if (ref && isSubjectKind(ref.kind)) {
      rowSubjectRef.set(row.id, { kind: ref.kind, id: ref.id });
    } else if (row.kind === "proposal-cluster") {
      const ids = proposalIdsOf(row);
      if (ids.length === 0) continue;
      if (!proposalRows.ok) {
        rowSubjectRef.set(row.id, "unreadable");
        continue;
      }
      const targets = new Map<string, SubjectRef>();
      for (const id of ids) {
        const p = proposalById.get(id);
        const target = p ? proposalTargetRef(p) : null;
        if (target) targets.set(refKey(target), target);
      }
      const [only] = [...targets.values()];
      if (targets.size === 1 && only) rowSubjectRef.set(row.id, only);
    }
  }
  const subjectRefs = [...rowSubjectRef.values()].filter(
    (r): r is SubjectRef => r !== "unreadable"
  );

  const [timelines, slotRows, waitingRows, waits, subjects] = await Promise.all(
    [
      part("timeline", () =>
        readSessionTimelines(
          sessionIds,
          { userId: reader.userId, isHubProtocol: false },
          timelineItems
        )
      ),
      part("aiCanDo", () =>
        sessionIds.length === 0
          ? Promise.resolve([])
          : db
              .select({
                id: focusSessions.id,
                expectedOutputs: focusSessions.expectedOutputs,
              })
              .from(focusSessions)
              .where(
                and(
                  inArray(focusSessions.id, sessionIds),
                  sessionReadableWhere(floor)
                )
              )
      ),
      part("waiting", () =>
        sessionIds.length === 0
          ? Promise.resolve([])
          : db
              .select({
                waitsOn: links.toId,
                id: focusSessions.id,
                title: focusSessions.title,
                goal: focusSessions.goal,
                status: focusSessions.status,
              })
              .from(links)
              .innerJoin(
                focusSessions,
                eq(drizzleSql`${focusSessions.id}::text`, links.fromId)
              )
              .where(
                and(
                  eq(links.fromType, "session"),
                  eq(links.toType, "session"),
                  eq(links.linkType, "blocked_by"),
                  inArray(links.toId, sessionIds),
                  inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
                  sessionReadableWhere(floor)
                )
              )
              .orderBy(focusSessions.createdAt)
      ),
      part("proposalWaits", async () => {
        if (!proposalRows.ok) throw new Error("the proposals read failed");
        return resolveProposalWaits(proposalRows.value, floor);
      }),
      part("subject", () =>
        subjectRefs.length === 0
          ? Promise.resolve(new Map<string, RequestSubject>())
          : Promise.all(subjectRefs.map((r) => readSubjects([r], reader.userId))).then(
              (maps) => new Map(maps.flatMap((m) => [...m]))
            )
      ),
    ]
  );

  // ── Per session ──────────────────────────────────────────────────────────
  const slotsOf = new Map(
    slotRows.ok
      ? slotRows.value.map((s) => [
          s.id,
          Array.isArray(s.expectedOutputs)
            ? (s.expectedOutputs as ExpectedOutput[]).filter(
                (o) => !!o && typeof o === "object"
              )
            : [],
        ])
      : []
  );
  const waitingOf = new Map<string, RequestWaitingSessions["items"]>();
  if (waitingRows.ok) {
    for (const r of waitingRows.value) {
      const list = waitingOf.get(r.waitsOn) ?? [];
      list.push({ id: r.id, title: resolveSessionTitle(r), status: r.status });
      waitingOf.set(r.waitsOn, list);
    }
  }

  const sessions: Record<string, RequestSessionContext> = {};
  for (const id of sessionIds) {
    // A session the floor did not return reads unreadable, never empty.
    const tl = timelines.ok ? timelines.value.get(id) : undefined;
    const timeline: RequestContextPart<RequestSessionTimeline> = tl
      ? {
          status: "ok",
          value: {
            events: tl.events.slice(0, timelineItems),
            olderExist: tl.truncated || tl.events.length > timelineItems,
          },
        }
      : { status: "ok", value: { events: [], olderExist: false } };
    const slots = slotsOf.get(id);
    const aiCanDo: RequestContextPart<RequestAiCanDo> = slots
      ? (() => {
          const items = aiCanDoItems(slots);
          return {
            status: "ok",
            value: {
              items: items.slice(0, REQUEST_CONTEXT_LIST_CAP).map((i) => ({
                label: i.label,
                answered: Boolean(i.answer),
              })),
              total: items.length,
            },
          };
        })()
      : UNREADABLE;
    const waitingList = waitingOf.get(id) ?? [];
    const waiting: RequestContextPart<RequestWaitingSessions> = waitingRows.ok
      ? {
          status: "ok",
          value: {
            items: waitingList.slice(0, REQUEST_CONTEXT_LIST_CAP),
            total: waitingList.length,
          },
        }
      : UNREADABLE;
    sessions[id] = { timeline, aiCanDo, waiting };
  }

  // ── Per row ──────────────────────────────────────────────────────────────
  const out: Record<string, RequestRowContext> = {};
  for (const row of rows) {
    const proposalIds = proposalIdsOf(row);
    let proposalWaits: RequestContextPart<ProposalWaits> | null = null;
    if (row.kind === "proposal-cluster") {
      if (!waits.ok) {
        proposalWaits = UNREADABLE;
      } else {
        const members = proposalIds.flatMap((id) => {
          const w = waits.value.get(id);
          return w ? [w] : [];
        });
        proposalWaits = {
          status: "ok",
          value: members.find((w) => w.waits) ?? { waits: false },
        };
      }
    }
    // Absent when the row names no object or names one the reader cannot
    // read; unreadable when the read failed.
    const ref = rowSubjectRef.get(row.id);
    let subject: RequestContextPart<RequestSubject> | undefined;
    if (ref === "unreadable" || (ref && !subjects.ok)) subject = undefined;
    else if (ref && subjects.ok) {
      const found = subjects.value.get(refKey(ref));
      if (found) subject = { status: "ok", value: found };
    }
    out[row.id] = {
      sessionId: rowSession.get(row.id) ?? null,
      slotLabel: row.kind === "owed-slot" ? row.title : null,
      proposalIds,
      proposalWaits,
      ...(subject ? { subject } : {}),
    };
  }

  return { timelineItems, sessions, rows: out };
}
