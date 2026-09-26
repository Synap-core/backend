/**
 * `settings.exposurePolicy` — what a workspace lets its owner share, per kind,
 * per audience, per action (Sites W2 S3).
 *
 * SHAPE. `{ version: 1, kinds: { <kind>: { <audience>: { read?, create? } } } }`
 * where kind ∈ SHARE_KINDS (the share doors' resource kinds), audience ∈
 * guest | link | public, and the two ACTIONS are `read` and `create`. There is
 * no `update` / `delete` key anywhere in the schema: an anonymous or guest edit
 * is NOT REPRESENTABLE, so no stored value can ever grant one. The input schema
 * is `.strict()` at every level, so a blob carrying `update` is refused at write
 * time rather than silently dropped.
 *
 * THE CEILING (code, not config). Whatever is stored, `resolveExposurePolicy`
 * clamps it at READ time:
 *   - public.create can be at most `proposal` (an anonymous create is always
 *     reviewed);
 *   - public.read `direct` means "read of a PUBLISHED snapshot only" — the public
 *     door (W3) serves `resource_shares` rows with `state = 'published'` and
 *     nothing else; this module cannot widen that.
 * Clamping at read time (not only at write time) is what makes a blob planted by
 * any other writer — a package applier, a raw SQL fix, an older build — inert.
 *
 * DEFAULT when absent (or unreadable): guest and link may READ every kind and
 * may CREATE only as a proposal; public is denied entirely.
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
/** CREATE (guest intake, W4): applied, reviewed, or refused. */
const CreateMode = z.enum(["direct", "proposal", "denied"]);

export type ReadMode = z.infer<typeof ReadMode>;
export type CreateMode = z.infer<typeof CreateMode>;

const CellInput = z
  .object({ read: ReadMode.optional(), create: CreateMode.optional() })
  .strict();

/**
 * A published property KEY (Sites W5a). The PUBLIC cell alone may carry
 * `fields`: the allowlist of property keys a publication SNAPSHOTS (`title`
 * names the record's title). Absent / empty = nothing but the pinned body and
 * the day it was published. Guest and link cells have no such key — guests read
 * the live record through the access floor, not a snapshot.
 */
const PublishedFieldKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const PublicCellInput = CellInput.extend({
  fields: z.array(PublishedFieldKey).max(64).optional(),
}).strict();

const KindInput = z
  .object({
    guest: CellInput.optional(),
    link: CellInput.optional(),
    public: PublicCellInput.optional(),
  })
  .strict();

/** What `shares.setPolicy` accepts. Strict everywhere: no `update` / `delete`. */
export const ExposurePolicyInputSchema = z
  .object({
    version: z.literal(1).default(1),
    kinds: z
      .object({
        entity: KindInput.optional(),
        document: KindInput.optional(),
        view: KindInput.optional(),
        project: KindInput.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type ExposurePolicyInput = z.input<typeof ExposurePolicyInputSchema>;
export type StoredExposurePolicy = z.output<typeof ExposurePolicyInputSchema>;

export interface ResolvedCell {
  read: ReadMode;
  create: CreateMode;
}
export type ResolvedExposurePolicy = Record<
  ShareKind,
  Record<ExposureAudience, ResolvedCell>
>;

const DEFAULT_CELL: Record<ExposureAudience, ResolvedCell> = {
  guest: { read: "direct", create: "proposal" },
  link: { read: "direct", create: "proposal" },
  public: { read: "denied", create: "denied" },
};

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
 * The effective policy for a workspace's stored settings blob. Never throws:
 * an absent key yields the default; an unreadable value (wrong type, unknown
 * mode) falls back to the default CELL by cell, so one bad entry cannot widen or
 * blank the rest. Unknown keys (`update`, `delete`, a stray kind) are ignored —
 * the resolved type has no slot for them.
 */
export function resolveExposurePolicy(
  settings: unknown
): ResolvedExposurePolicy {
  const raw =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).exposurePolicy
      : undefined;
  const kinds =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? ((raw as Record<string, unknown>).kinds as unknown)
      : undefined;

  const out = {} as ResolvedExposurePolicy;
  for (const kind of SHARE_KINDS) {
    const storedKind =
      kinds && typeof kinds === "object" && !Array.isArray(kinds)
        ? (kinds as Record<string, unknown>)[kind]
        : undefined;
    const perAudience = {} as Record<ExposureAudience, ResolvedCell>;
    for (const audience of EXPOSURE_AUDIENCES) {
      const storedCell =
        storedKind && typeof storedKind === "object"
          ? ((storedKind as Record<string, unknown>)[audience] as
              Record<string, unknown> | undefined)
          : undefined;
      const read = ReadMode.safeParse(storedCell?.read);
      const create = CreateMode.safeParse(storedCell?.create);
      perAudience[audience] = clampToCeiling(audience, {
        read: read.success ? read.data : DEFAULT_CELL[audience].read,
        create: create.success ? create.data : DEFAULT_CELL[audience].create,
      });
    }
    out[kind] = perAudience;
  }
  return out;
}

/**
 * The property keys a PUBLICATION of `kind` may snapshot — the public cell's
 * `fields` allowlist (W5a). Never throws: an absent or unreadable list is `[]`
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
 *  schema cannot represent (an `update` key, an unknown mode, a stray kind). */
export function parseExposurePolicyInput(input: unknown): StoredExposurePolicy {
  return ExposurePolicyInputSchema.parse(input);
}
