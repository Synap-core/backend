/**
 * `settings.exposurePolicy` — what a workspace lets its owner share, per kind,
 * per audience, per action.
 *
 * SHAPE. `{ version: 1, kinds: { <kind>: { <audience>: { read?, create? } } } }`
 * where kind ∈ SHARE_KINDS (the share doors' resource kinds), audience ∈
 * guest | link | public, and the two ACTIONS are `read` and `create`. There is
 * no `update` / `delete` key anywhere in the schema: an anonymous or guest edit
 * is NOT REPRESENTABLE, so no stored value can ever grant one. The input schema
 * is `.strict()` at every level, so a blob carrying `update` is refused at write
 * time rather than silently dropped.
 *
 * WRITE = FULL REPLACE OF A COMPLETE DOCUMENT. `shares.setPolicy` takes
 * every kind × audience × action and each public cell's `fields`; anything
 * missing is a validation error. `shares.getPolicy` returns the same shape
 * (under `kinds`), so get → edit → set is lossless and can never erase the
 * publish allowlist by omission.
 *
 * THE CEILING (code, not config). Whatever is stored, `resolveExposurePolicy`
 * clamps it at READ time:
 *   - public.create can be at most `proposal` (an anonymous create is always
 *     reviewed; the one anonymous create door, a public form, files every
 *     submission as a proposal whatever the form's stored mode:
 *     `services/forms/guest-submit.ts`);
 *   - public.read `direct` means "read of a PUBLISHED snapshot only" — the public
 *     door serves `resource_shares` rows with `state = 'published'` and
 *     nothing else; this module cannot widen that.
 * Clamping at read time (not only at write time) is what makes a blob planted by
 * any other writer — a package applier, a raw SQL fix, an older build — inert.
 *
 * DEFAULT when absent: guest and link may READ every kind and may CREATE only
 * as a proposal; public is denied entirely. A value that is PRESENT but
 * unreadable is not absent: that cell resolves to `denied` (fail closed), so a
 * corrupted or planted entry can only narrow, never fall back to the permissive
 * default.
 *
 * WHERE IT IS STORED. `settings.exposurePolicy` is a SERVER-OWNED settings key:
 * `workspaces.update` / `create` never take it from the client
 * (`connectors/server-owned-settings.ts`), and `WorkspaceRepository`'s generic
 * create / update / mergeSettings strip it (`@synap/database`,
 * `withoutExposurePolicy`). The ONE writer is `WorkspaceRepository.setExposurePolicy`,
 * called only by `shares.setPolicy` (owner, human). It is not in the client-safe
 * settings projection; `shares.getPolicy` is its read door.
 */

import { z } from "zod";

export const SHARE_KINDS = ["entity", "document", "view", "project"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

export const EXPOSURE_AUDIENCES = ["guest", "link", "public"] as const;
export type ExposureAudience = (typeof EXPOSURE_AUDIENCES)[number];

/** READ: allowed (`direct`) or not. There is no "propose to read". */
const ReadMode = z.enum(["direct", "denied"]);
/** CREATE (guest intake): applied, reviewed, or refused. */
const CreateMode = z.enum(["direct", "proposal", "denied"]);

export type ReadMode = z.infer<typeof ReadMode>;
export type CreateMode = z.infer<typeof CreateMode>;

/**
 * ONE cell, COMPLETE. `read` and `create` are both REQUIRED: the
 * write is a FULL REPLACE of the stored policy, so a key the caller leaves out
 * would not be "left alone" — it would be ERASED back to the default. The
 * schema therefore refuses an incomplete document instead of guessing.
 */
const CellInput = z.object({ read: ReadMode, create: CreateMode }).strict();

/**
 * A published property KEY. The PUBLIC cell alone carries
 * `fields`: the allowlist of property keys a publication SNAPSHOTS (`title`
 * names the record's title). Empty = nothing but the pinned body and the day it
 * was published. Guest and link cells have no such key — guests read the live
 * record through the access floor, not a snapshot.
 */
const PublishedFieldKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
/** `fields` is REQUIRED (possibly `[]`): omitting it must fail, never erase
 *  the stored allowlist (get → edit → set once dropped it by omission). */
const PublicCellInput = CellInput.extend({
  fields: z.array(PublishedFieldKey).max(64),
}).strict();

const KindInput = z
  .object({
    guest: CellInput,
    link: CellInput,
    public: PublicCellInput,
  })
  .strict();

/**
 * What `shares.setPolicy` accepts: the WHOLE policy, every kind × audience ×
 * action, plus each kind's public `fields`. Strict everywhere: no `update` /
 * `delete`. Its `kinds` shape is exactly what `shares.getPolicy` returns
 * ({@link ResolvedExposurePolicy}), so `setPolicy({ version: 1, kinds:
 * await getPolicy() })` is a LOSSLESS round-trip, and a partial payload is a
 * validation error rather than a silent erase.
 */
export const ExposurePolicyInputSchema = z
  .object({
    version: z.literal(1).default(1),
    kinds: z
      .object({
        entity: KindInput,
        document: KindInput,
        view: KindInput,
        project: KindInput,
      })
      .strict(),
  })
  .strict();

export type ExposurePolicyInput = z.input<typeof ExposurePolicyInputSchema>;
export type StoredExposurePolicy = z.output<typeof ExposurePolicyInputSchema>;

export interface ResolvedCell {
  read: ReadMode;
  create: CreateMode;
}
/** The public cell also carries its publish allowlist ({@link resolvePublicFields}). */
export interface ResolvedPublicCell extends ResolvedCell {
  fields: string[];
}
export interface ResolvedKindPolicy {
  guest: ResolvedCell;
  link: ResolvedCell;
  public: ResolvedPublicCell;
}
/** The EFFECTIVE policy — `shares.getPolicy`'s answer. The owner is its only
 *  reader, so it carries everything the stored policy holds (incl. `fields`). */
export type ResolvedExposurePolicy = Record<ShareKind, ResolvedKindPolicy>;

const DEFAULT_CELL: Record<ExposureAudience, ResolvedCell> = {
  guest: { read: "direct", create: "proposal" },
  link: { read: "direct", create: "proposal" },
  public: { read: "denied", create: "denied" },
};

const DENIED_CELL: ResolvedCell = { read: "denied", create: "denied" };

/**
 * One level of the stored policy: `absent` (undefined or null: the default
 * applies), a readable object, or `invalid` (present but not an object: every
 * cell under it is denied).
 */
type Level =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "object"; value: Record<string, unknown> };

function levelOf(value: unknown): Level {
  if (value === undefined || value === null) return { kind: "absent" };
  if (typeof value === "object" && !Array.isArray(value)) {
    return { kind: "object", value: value as Record<string, unknown> };
  }
  return { kind: "invalid" };
}

function childOf(level: Level, key: string): Level {
  if (level.kind === "object") return levelOf(level.value[key]);
  return level;
}

/** A stored cell: absent → the default; present → both modes must parse. */
function resolveCell(audience: ExposureAudience, level: Level): ResolvedCell {
  if (level.kind === "absent") return DEFAULT_CELL[audience];
  if (level.kind === "invalid") return DENIED_CELL;
  const read = ReadMode.safeParse(level.value.read);
  const create = CreateMode.safeParse(level.value.create);
  if (!read.success || !create.success) return DENIED_CELL;
  return { read: read.data, create: create.data };
}

/**
 * The code CEILING, applied to every resolved cell. Tighten-only: it can turn
 * a value down, never up.
 */
function clampToCeiling(
  audience: ExposureAudience,
  cell: ResolvedCell
): ResolvedCell {
  if (audience === "public" && cell.create === "direct") {
    return { ...cell, create: "proposal" };
  }
  return cell;
}

/**
 * The effective policy for a workspace's stored settings blob. Never throws.
 * ABSENT (at any level: the key, `kinds`, a kind, a cell) yields the default
 * for everything under it. PRESENT but unreadable (not an object, an unknown or
 * missing mode) yields `denied` for every cell under it, so a bad entry can
 * narrow what it covers and never widen it; the other cells are unaffected.
 * Unknown keys (`update`, `delete`, a stray kind) are ignored — the resolved
 * type has no slot for them.
 */
export function resolveExposurePolicy(
  settings: unknown
): ResolvedExposurePolicy {
  const root =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? levelOf((settings as Record<string, unknown>).exposurePolicy)
      : ({ kind: "absent" } as Level);
  const kinds = childOf(root, "kinds");

  const out = {} as ResolvedExposurePolicy;
  for (const kind of SHARE_KINDS) {
    const storedKind = childOf(kinds, kind);
    const perAudience = {} as Record<ExposureAudience, ResolvedCell>;
    for (const audience of EXPOSURE_AUDIENCES) {
      perAudience[audience] = clampToCeiling(
        audience,
        resolveCell(audience, childOf(storedKind, audience))
      );
    }
    out[kind] = {
      guest: perAudience.guest,
      link: perAudience.link,
      public: {
        ...perAudience.public,
        fields: resolvePublicFields(settings, kind),
      },
    };
  }
  return out;
}

/**
 * The property keys a PUBLICATION of `kind` may snapshot — the public cell's
 * `fields` allowlist. Never throws: an absent or unreadable list is `[]`
 * (publish only the body), and each entry is re-validated so a planted blob
 * cannot smuggle a malformed key. Deduplicated, order kept. The public READ
 * re-filters what it serves (`projectPublishedProperties`), so this is the
 * owner's choice, not the last line of defence.
 */
export function resolvePublicFields(
  settings: unknown,
  kind: ShareKind
): string[] {
  const raw =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).exposurePolicy
      : undefined;
  const kinds =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? ((raw as Record<string, unknown>).kinds as unknown)
      : undefined;
  const storedKind =
    kinds && typeof kinds === "object" && !Array.isArray(kinds)
      ? (kinds as Record<string, unknown>)[kind]
      : undefined;
  const cell =
    storedKind && typeof storedKind === "object"
      ? ((storedKind as Record<string, unknown>).public as unknown)
      : undefined;
  const fields =
    cell && typeof cell === "object" && !Array.isArray(cell)
      ? (cell as Record<string, unknown>).fields
      : undefined;
  if (!Array.isArray(fields)) return [];
  const out: string[] = [];
  for (const f of fields) {
    if (PublishedFieldKey.safeParse(f).success && !out.includes(f as string)) {
      out.push(f as string);
    }
  }
  return out.slice(0, 64);
}

/** Validate an owner's policy for storage. Throws a ZodError on anything the
 *  schema cannot represent (an `update` key, an unknown mode, a stray kind)
 *  and on an INCOMPLETE document (a missing kind, audience, action or public
 *  `fields`) — the write replaces the whole policy, so an omission would erase. */
export function parseExposurePolicyInput(input: unknown): StoredExposurePolicy {
  return ExposurePolicyInputSchema.parse(input);
}
