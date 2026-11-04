/**
 * RAIL PINS — the intent surfaces a person pinned to their rail (surfaces
 * W1.7, founder decision S5: pins are PER USER, seeded from each template's
 * `sidebarItems`).
 *
 * Intents ("Posts", "Leads") cut across spaces, so a pin lives on the
 * person's OWN preference row (`user_preferences.ui_preferences.railPins`,
 * owner floor by key — the row `signals.skipNextMove` writes), never in a
 * space's `layout.sidebarItems` (per space, admin-only).
 *
 * A pin names a surface: a saved `pipeline` view (`viewId`), a kind/role's
 * implicit surface (`profileSlug` alone), a GOAL (`trackId` — "This week",
 * D4: at most `RAIL_GOAL_PINS_MAX` of them, `@synap-core/types/units`), or a
 * DOCUMENT (`documentId` — a living document opened as an app, plan 9ad4b2fc
 * P4; pinned by the person only, never suggested, Q6). Its `key` is
 * `view:<id>`, `kind:<slug>`, `track:<id>` or `doc:<id>` — one pin per
 * surface.
 *
 * SEEDING (configuration over code, no install-path hook). Every space the
 * person can see whose `layout.sidebarItems` points at a `pipeline` view
 * SUGGESTS that view as a pin until the person first edits their pins with
 * that space in view: the read returns stored pins + the suggestions of
 * spaces not yet seeded (pure, no write); every write persists the effective
 * list and marks every space it saw as seeded. So a template's pins appear on
 * install, and a pin the person removed never comes back.
 */
import {
  db,
  and,
  eq,
  inArray,
  isNull,
  drizzleSql,
  userVisibleWhere,
} from "@synap/database";
import {
  projectTracks,
  userPreferences,
  views,
  workspaces,
} from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { AccessContext, scopedDb } from "../../access/index.js";
import { RAIL_GOAL_PINS_MAX, goalRailPinKey } from "@synap-core/types/units";
import { documentRailPinKey } from "@synap-core/types/documents";
import { assertKnownProfileSlug } from "../../utils/assert-known-profile-slug.js";
import {
  loadReadableDocument,
  loadReadableDocumentTitles,
} from "../../utils/document-edit-access.js";
import { viewReadableWhere } from "../../utils/view-visibility.js";
import { getTrack } from "../tracks/tracks-service.js";

export const RAIL_PINS_KEY = "railPins";
/**
 * The most pins a rail holds — a rail, not a second sidebar. It counts EVERY
 * pin of the person's one list, including the goal and document pins a client
 * that does not ask for them never sees (review A11): the list is the same on
 * every client, so one client can never fill another's rail past its cap. A
 * full rail says how many of its pins the asking client hides
 * ({@link RailPinsFullError}).
 */
export const RAIL_PINS_MAX = 30;

export interface RailPin {
  /** `view:<viewId>`, `kind:<profileSlug>`, `track:<trackId>` or `doc:<documentId>` — one pin per surface. */
  key: string;
  /** The kind the surface lists — `null` on a goal or a document pin. */
  profileSlug: string | null;
  /** The saved pipeline view, when the pin is one. */
  viewId: string | null;
  /** The goal, when the pin is one ("This week", D4) — then `profileSlug` is null. */
  trackId: string | null;
  /** The document, when the pin is one (P4) — then `profileSlug` and `trackId` are null. */
  documentId: string | null;
  /** The name the person (or the template) gave it; null = the kind's, goal's or document's own name. */
  label: string | null;
  /** `template` = suggested by a space's sidebar; `user` = pinned by hand. */
  source: "user" | "template";
  /**
   * A document pin only: the document's own title, read with the pin (the
   * same read that drops a document the person can no longer open), so a
   * client draws the pin without a read per document. Never stored.
   */
  title?: string;
}

interface StoredRailPins {
  pins: RailPin[];
  seededWorkspaceIds: string[];
}

export function railPinKey(p: { viewId?: string | null; profileSlug: string }) {
  return p.viewId ? `view:${p.viewId}` : `kind:${p.profileSlug}`;
}

/** A document pin: always the person's own (Q6 — nothing suggests one). */
function documentPin(documentId: string, label: string | null): RailPin {
  return {
    key: documentRailPinKey(documentId),
    profileSlug: null,
    viewId: null,
    trackId: null,
    documentId,
    label,
    source: "user",
  };
}

function readStored(raw: unknown): StoredRailPins {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const pins = Array.isArray(o.pins)
    ? (o.pins as unknown[]).flatMap((p): RailPin[] => {
        const r = (p && typeof p === "object" ? p : {}) as Record<
          string,
          unknown
        >;
        const label = typeof r.label === "string" ? r.label : null;
        const source = r.source === "template" ? "template" : "user";
        // A document pin names its document, not a kind — and only the
        // person pins one (Q6), whatever the stored row claims.
        if (typeof r.documentId === "string" && r.documentId) {
          return [documentPin(r.documentId, label)];
        }
        // A goal pin names its goal, not a kind.
        if (typeof r.trackId === "string" && r.trackId) {
          return [
            {
              key: goalRailPinKey(r.trackId),
              profileSlug: null,
              viewId: null,
              trackId: r.trackId,
              documentId: null,
              label,
              source,
            },
          ];
        }
        if (typeof r.profileSlug !== "string" || !r.profileSlug) return [];
        const viewId = typeof r.viewId === "string" ? r.viewId : null;
        return [
          {
            key: railPinKey({ viewId, profileSlug: r.profileSlug }),
            profileSlug: r.profileSlug,
            viewId,
            trackId: null,
            documentId: null,
            label,
            source,
          },
        ];
      })
    : [];
  const seeded = Array.isArray(o.seededWorkspaceIds)
    ? (o.seededWorkspaceIds as unknown[]).filter(
        (x): x is string => typeof x === "string"
      )
    : [];
  return { pins, seededWorkspaceIds: seeded };
}

/**
 * What each visible space suggests: its sidebar items that point at a
 * `pipeline` view (by id, or by name within the space), in sidebar order.
 */
async function suggestionsBySpace(
  userId: string
): Promise<Map<string, RailPin[]>> {
  const spaces = await db
    .select({ id: workspaces.id, settings: workspaces.settings })
    .from(workspaces)
    .where(
      and(
        userVisibleWhere(workspaces.id, userId),
        isNull(workspaces.archivedAt)
      )
    );
  const out = new Map<string, RailPin[]>();
  const wanted = spaces.flatMap((s) => {
    const items = ((
      s.settings as { layout?: { sidebarItems?: unknown } } | null
    )?.layout?.sidebarItems ?? []) as Array<Record<string, unknown>>;
    return Array.isArray(items)
      ? items
          .filter((i) => i?.kind === "view" && (i.viewId || i.viewName))
          .map((i) => ({ space: s.id, item: i }))
      : [];
  });
  for (const s of spaces) out.set(s.id, []);
  if (wanted.length === 0) return out;
  const pipelineViews = await db
    .select({
      id: views.id,
      name: views.name,
      workspaceId: views.workspaceId,
      profileSlug: drizzleSql<string | null>`${views.config}->>'profileSlug'`,
    })
    .from(views)
    .where(
      and(
        eq(views.type, "pipeline"),
        inArray(
          views.workspaceId,
          spaces.map((s) => s.id)
        ),
        viewReadableWhere(userId, undefined)
      )
    );
  for (const { space, item } of wanted) {
    // By id; else by name within the space — and a name several views
    // share stays unresolved, never guessed (the reconcile's rule).
    const byName =
      typeof item.viewName === "string"
        ? pipelineViews.filter(
            (pv) => pv.workspaceId === space && pv.name === item.viewName
          )
        : [];
    const v =
      (typeof item.viewId === "string"
        ? pipelineViews.find((pv) => pv.id === item.viewId)
        : undefined) ?? (byName.length === 1 ? byName[0] : undefined);
    if (!v || !v.profileSlug) continue;
    out.get(space)!.push({
      key: railPinKey({ viewId: v.id, profileSlug: v.profileSlug }),
      profileSlug: v.profileSlug,
      viewId: v.id,
      trackId: null,
      documentId: null,
      label: typeof item.label === "string" ? item.label : v.name,
      source: "template",
    });
  }
  return out;
}

/**
 * The goals among `pins` the person can no longer read (deleted, or its
 * project no longer shared) — the same `project_tracks` rule every track read
 * is floored on, ONE read. A dead goal pin never shows, and never holds one
 * of the week's {@link RAIL_GOAL_PINS_MAX} places. Read OUTSIDE the write's
 * transaction: the row lock is held on its own connection, and only goals
 * checked here are dropped (a goal pinned meanwhile by another tab stays).
 */
async function unreadableGoalIds(
  userId: string,
  pins: readonly RailPin[]
): Promise<Set<string>> {
  const ids = pins.flatMap((p) => (p.trackId ? [p.trackId] : []));
  if (ids.length === 0) return new Set();
  const readable = await scopedDb(AccessContext.from({ userId })).findMany<{
    id: string;
  }>(projectTracks, {
    where: inArray(projectTracks.id, ids),
    columns: { id: true },
  });
  const keep = new Set(readable.map((r) => r.id));
  return new Set(ids.filter((id) => !keep.has(id)));
}

/**
 * The documents among `pins` the person can still read, with their titles:
 * ONE batched read through the documents read floor
 * (`loadReadableDocumentTitles`, the rule of `loadReadableDocument`), never a
 * document load per pin. A pinned document absent from the answer is
 * unreadable (deleted, or no longer shared); a failed read fails the call,
 * never a silently shorter rail. `extra` names a document about to be pinned,
 * so its title comes back with the write. Read OUTSIDE the write's
 * transaction, like the goals'.
 */
async function readableDocumentTitles(
  userId: string,
  pins: readonly RailPin[],
  extra: readonly string[] = []
): Promise<Map<string, string>> {
  const ids = [
    ...pins.flatMap((p) => (p.documentId ? [p.documentId] : [])),
    ...extra,
  ];
  return loadReadableDocumentTitles(userId, ids);
}

/** What a read or a write learns about the goals and the documents among the pins. */
interface PinReadability {
  /** Goals the person can no longer read: they leave the rail. */
  goals: Set<string>;
  /** Documents the person can no longer read: they leave the rail. */
  documents: Set<string>;
  /** The title of each document the person can read. */
  titles: Map<string, string>;
}

async function readPinReadability(
  userId: string,
  pins: readonly RailPin[],
  extraDocuments: readonly string[] = []
): Promise<PinReadability> {
  const [goals, titles] = await Promise.all([
    unreadableGoalIds(userId, pins),
    readableDocumentTitles(userId, pins, extraDocuments),
  ]);
  const documents = new Set(
    pins.flatMap((p) =>
      p.documentId && !titles.has(p.documentId) ? [p.documentId] : []
    )
  );
  return { goals, documents, titles };
}

/** The pins as the wire carries them: each document pin with its title. */
function withTitles(
  pins: readonly RailPin[],
  titles: ReadonlyMap<string, string>
): RailPin[] {
  return pins.map((p) => {
    const title = p.documentId ? titles.get(p.documentId) : undefined;
    return title === undefined ? p : { ...p, title };
  });
}

function withoutUnreadable(
  stored: StoredRailPins,
  drop: { goals: ReadonlySet<string>; documents: ReadonlySet<string> }
): StoredRailPins {
  if (drop.goals.size === 0 && drop.documents.size === 0) return stored;
  return {
    ...stored,
    pins: stored.pins.filter(
      (p) =>
        !(p.trackId && drop.goals.has(p.trackId)) &&
        !(p.documentId && drop.documents.has(p.documentId))
    ),
  };
}

async function readStoredRow(userId: string): Promise<StoredRailPins> {
  const [row] = await db
    .select({ ui: userPreferences.uiPreferences })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId));
  return readStored(
    (row?.ui as Record<string, unknown> | undefined)?.[RAIL_PINS_KEY]
  );
}

/** Stored pins, then the suggestions of spaces not yet seeded — deduped by key, capped. */
function effective(
  stored: StoredRailPins,
  suggested: Map<string, RailPin[]>
): RailPin[] {
  const seeded = new Set(stored.seededWorkspaceIds);
  const seen = new Set<string>();
  const out: RailPin[] = [];
  const add = (p: RailPin) => {
    if (seen.has(p.key) || out.length >= RAIL_PINS_MAX) return;
    seen.add(p.key);
    out.push(p);
  };
  stored.pins.forEach(add);
  for (const [space, pins] of suggested) {
    if (!seeded.has(space)) pins.forEach(add);
  }
  return out;
}

/** THE read: the person's rail pins, template suggestions folded in. Pure. */
export async function readRailPins(userId: string): Promise<RailPin[]> {
  const stored = await readStoredRow(userId);
  const seen = await readPinReadability(userId, stored.pins);
  return withTitles(
    effective(
      withoutUnreadable(stored, seen),
      await suggestionsBySpace(userId)
    ),
    seen.titles
  );
}

/**
 * A pin must name a real surface the person can open: a document they can
 * read (the documents read floor, `loadReadableDocument`), a goal they can
 * read (the track read, `getTrack` — visible iff its project is), or a known
 * kind/role and — for a saved surface — a `pipeline` view they can read whose
 * board is that kind. Throws NOT_FOUND / BAD_REQUEST (never pins a dead door).
 */
export async function assertPinnableSurface(
  userId: string,
  pin:
    | { documentId: string; trackId?: undefined }
    | { trackId: string }
    | { profileSlug: string; viewId?: string | null; trackId?: undefined }
): Promise<void> {
  if ("documentId" in pin) {
    // NOT_FOUND for a document this person cannot read, named like the rest.
    try {
      await loadReadableDocument(userId, pin.documentId);
    } catch (err) {
      if (err instanceof TRPCError && err.code === "NOT_FOUND") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No document ${pin.documentId} you can open.`,
        });
      }
      throw err;
    }
    return;
  }
  if (pin.trackId) {
    if (!(await getTrack(pin.trackId, { userId }))) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `No goal ${pin.trackId} you can open.`,
      });
    }
    return;
  }
  if (!("profileSlug" in pin)) return;
  await assertKnownProfileSlug(db, pin.profileSlug);
  if (!pin.viewId) return;
  const [v] = await db
    .select({
      type: views.type,
      profileSlug: drizzleSql<string | null>`${views.config}->>'profileSlug'`,
    })
    .from(views)
    .where(and(eq(views.id, pin.viewId), viewReadableWhere(userId, undefined)));
  if (!v) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No view ${pin.viewId} you can open.`,
    });
  }
  if (v.type !== "pipeline" || v.profileSlug !== pin.profileSlug) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `View ${pin.viewId} is not the "${pin.profileSlug}" pipeline.`,
    });
  }
}

export type RailPinsOp =
  | {
      op: "pin";
      profileSlug: string;
      viewId?: string | null;
      trackId?: undefined;
      label?: string | null;
    }
  | { op: "pin"; trackId: string; label?: string | null }
  | { op: "pin"; documentId: string; label?: string | null }
  | { op: "unpin"; key: string }
  | { op: "reorder"; keys: string[] };

/**
 * THE write: apply one op to the EFFECTIVE list, persist it, and mark every
 * space the read saw as seeded. Serialized per person (row lock), so two
 * tabs pinning at once cannot drop each other's pin.
 */
export async function writeRailPins(
  userId: string,
  op: RailPinsOp
): Promise<RailPin[]> {
  const suggested = await suggestionsBySpace(userId);
  const dead = await readPinReadability(
    userId,
    (await readStoredRow(userId)).pins,
    op.op === "pin" && "documentId" in op ? [op.documentId] : []
  );
  return db.transaction(async (tx) => {
    await tx
      .insert(userPreferences)
      .values({ userId, uiPreferences: {}, updatedAt: new Date() })
      .onConflictDoNothing({ target: userPreferences.userId });
    const [row] = await tx
      .select({ ui: userPreferences.uiPreferences })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .for("update");
    const ui = (row?.ui ?? {}) as Record<string, unknown>;
    const stored = withoutUnreadable(readStored(ui[RAIL_PINS_KEY]), dead);
    let pins = effective(stored, suggested);

    if (op.op === "pin") {
      // A goal or a document pin carries no `profileSlug` key (the router
      // builds it so).
      const pin: RailPin =
        "documentId" in op
          ? documentPin(op.documentId, op.label ?? null)
          : !("profileSlug" in op)
            ? {
                key: goalRailPinKey(op.trackId),
                profileSlug: null,
                viewId: null,
                trackId: op.trackId,
                documentId: null,
                label: op.label ?? null,
                source: "user",
              }
            : {
                key: railPinKey({
                  viewId: op.viewId ?? null,
                  profileSlug: op.profileSlug,
                }),
                profileSlug: op.profileSlug,
                viewId: op.viewId ?? null,
                trackId: null,
                documentId: null,
                label: op.label ?? null,
                source: "user",
              };
      if (!pins.some((p) => p.key === pin.key)) {
        if (pins.length >= RAIL_PINS_MAX) {
          throw new RailPinsFullError(pins);
        }
        if (
          pin.trackId &&
          pins.filter((p) => p.trackId).length >= RAIL_GOAL_PINS_MAX
        ) {
          throw new RailGoalPinsFullError();
        }
        pins = [...pins, pin];
      }
    } else if (op.op === "unpin") {
      pins = pins.filter((p) => p.key !== op.key);
    } else {
      // Named keys first, in the given order; any pin not named keeps its
      // relative place after them (a stale client never drops a pin).
      const byKey = new Map(pins.map((p) => [p.key, p]));
      const named = op.keys.flatMap((k) => {
        const p = byKey.get(k);
        if (!p) return [];
        byKey.delete(k);
        return [p];
      });
      pins = [...named, ...byKey.values()];
    }

    const next: StoredRailPins = {
      pins,
      seededWorkspaceIds: [
        ...new Set([...stored.seededWorkspaceIds, ...suggested.keys()]),
      ],
    };
    await tx
      .update(userPreferences)
      .set({
        uiPreferences: drizzleSql`jsonb_set(coalesce(${userPreferences.uiPreferences}, '{}'::jsonb), ${`{${RAIL_PINS_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(userPreferences.userId, userId));
    return withTitles(pins, dead.titles);
  });
}

/**
 * The rail is full. It carries the full list ({@link RAIL_PINS_MAX} counts
 * every pin), so the door that answers a client can say how many of them that
 * client does not show ({@link railPinsFullMessage}).
 */
export class RailPinsFullError extends Error {
  constructor(readonly pins: readonly RailPin[] = []) {
    super(railPinsFullMessage(0));
    this.name = "RailPinsFullError";
  }
}

/** The full rail's sentence, naming the pins the asking client does not show. */
export function railPinsFullMessage(hidden: number): string {
  const base = `A rail holds at most ${RAIL_PINS_MAX} pins`;
  if (hidden <= 0) return `${base} — unpin one first.`;
  const these =
    hidden === 1
      ? "1 of them is a goal or a document"
      : `${hidden} of them are goals or documents`;
  return `${base}; ${these} this app does not show. Unpin one first, here or in an app that shows them.`;
}

/** "This week" holds at most {@link RAIL_GOAL_PINS_MAX} goals (D4). */
export class RailGoalPinsFullError extends Error {
  constructor() {
    super(
      `This week holds at most ${RAIL_GOAL_PINS_MAX} goals — unpin one first.`
    );
    this.name = "RailGoalPinsFullError";
  }
}
