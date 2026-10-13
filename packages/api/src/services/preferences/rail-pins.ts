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
 * A pin names a surface: a saved `pipeline` view (`viewId`) or a kind/role's
 * implicit surface (`profileSlug` alone). Its `key` is `view:<id>` or
 * `kind:<slug>` — one pin per surface.
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
import { userPreferences, views, workspaces } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { assertKnownProfileSlug } from "../../utils/assert-known-profile-slug.js";
import { viewReadableWhere } from "../../utils/view-visibility.js";

export const RAIL_PINS_KEY = "railPins";
/** The most pins a rail holds — a rail, not a second sidebar. */
export const RAIL_PINS_MAX = 30;

export interface RailPin {
  /** `view:<viewId>` or `kind:<profileSlug>` — one pin per surface. */
  key: string;
  profileSlug: string;
  /** The saved pipeline view, when the pin is one. */
  viewId: string | null;
  /** The name the person (or the template) gave it; null = the kind's name. */
  label: string | null;
  /** `template` = suggested by a space's sidebar; `user` = pinned by hand. */
  source: "user" | "template";
}

interface StoredRailPins {
  pins: RailPin[];
  seededWorkspaceIds: string[];
}

export function railPinKey(p: { viewId?: string | null; profileSlug: string }) {
  return p.viewId ? `view:${p.viewId}` : `kind:${p.profileSlug}`;
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
        if (typeof r.profileSlug !== "string" || !r.profileSlug) return [];
        const viewId = typeof r.viewId === "string" ? r.viewId : null;
        return [
          {
            key: railPinKey({ viewId, profileSlug: r.profileSlug }),
            profileSlug: r.profileSlug,
            viewId,
            label: typeof r.label === "string" ? r.label : null,
            source: r.source === "template" ? "template" : "user",
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
      label: typeof item.label === "string" ? item.label : v.name,
      source: "template",
    });
  }
  return out;
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
  const [row] = await db
    .select({ ui: userPreferences.uiPreferences })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId));
  const stored = readStored(
    (row?.ui as Record<string, unknown> | undefined)?.[RAIL_PINS_KEY]
  );
  return effective(stored, await suggestionsBySpace(userId));
}

/**
 * A pin must name a real surface the person can open: a known kind/role, and
 * — for a saved surface — a `pipeline` view they can read whose board is that
 * kind. Throws NOT_FOUND / BAD_REQUEST (never pins a dead door).
 */
export async function assertPinnableSurface(
  userId: string,
  pin: { profileSlug: string; viewId?: string | null }
): Promise<void> {
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
      label?: string | null;
    }
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
    const stored = readStored(ui[RAIL_PINS_KEY]);
    let pins = effective(stored, suggested);

    if (op.op === "pin") {
      const key = railPinKey({
        viewId: op.viewId ?? null,
        profileSlug: op.profileSlug,
      });
      if (!pins.some((p) => p.key === key)) {
        if (pins.length >= RAIL_PINS_MAX) {
          throw new RailPinsFullError();
        }
        pins = [
          ...pins,
          {
            key,
            profileSlug: op.profileSlug,
            viewId: op.viewId ?? null,
            label: op.label ?? null,
            source: "user",
          },
        ];
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
    return pins;
  });
}

export class RailPinsFullError extends Error {
  constructor() {
    super(`A rail holds at most ${RAIL_PINS_MAX} pins — unpin one first.`);
    this.name = "RailPinsFullError";
  }
}
