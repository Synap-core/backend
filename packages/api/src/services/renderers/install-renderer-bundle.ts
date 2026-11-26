/**
 * Install a RENDERER BUNDLE (decision c91d26dc, spec c9b1e4d0 §3a–§3b): its
 * host-module set, its frame cells and its defaults, as ONE act.
 *
 *   1. the definition passes `validateRendererBundleDefinition` (shape, sizes,
 *      kit imports, each cell's source under the frame rule);
 *   2. the pod RE-HASHES every module and cell with node crypto, and the set
 *      (`rendererSetSha256`), and refuses any declared hash that differs —
 *      the declared ones are never trusted;
 *   3. one transaction, one install at a time (an advisory lock: two
 *      installs of one slug run one after the other; a key violation that
 *      still gets through is refused CONFLICT `RENDERER_BUNDLE_INSTALL_RACED`,
 *      retry-safe, never a raw error): ONE active host-module set per pod (a second slug is
 *      refused `RENDERER_HOST_SET_TAKEN`, and the database refuses it too:
 *      `renderer_host_modules_one_set`), the modules, the cells through the
 *      one cell door (`installCellFromDefinition`: `cell:<slug>:<key>`,
 *      mechanism `frame`, its slot, view types and the bundle's version: the
 *      catalog row's, `options.version`, never `_meta.version`), and
 *      the bundle row LAST, carrying `defaults` (never `renderer_bindings`:
 *      a binding would beat the desktop's own adapters);
 *   4. after the commit, each written cell is announced (`emitCellWritten`).
 *
 * Before any of it, the bundle's requirements are checked against this pod's
 * contract (`unmetRendererBundleRequirements`: the bundle API, the bridge ops
 * its cells call): one this pod does not meet is refused PRECONDITION_FAILED
 * `RENDERER_BUNDLE_REQUIRES_UNMET`, nothing written (the update pass holds it
 * for the owner instead: the bundle is built against backend `main`).
 *
 * KEPT VERSIONS (0449). The same transaction records the definition with
 * the digest computed here (`officialContentHash`, what Synap's index lists)
 * in `renderer_bundle_versions` and on the bundle row, and keeps only the new
 * version and the one it replaced (N-1): Undo re-installs N-1 from the pod,
 * never from the control plane. The answer names the version replaced
 * (`previousVersion`), so a caller can tell an install from an update.
 *
 * Who may call it: the install door decides (`market.install` kind
 * `renderer-bundle`: a person installs, an agent proposes). `defineCell`
 * refuses an acting agent here too.
 *
 * Honest limits (W1): a cell a newer version drops stays installed (there is
 * no uninstall yet), and the delivery gate is the control plane's, not a
 * protection of the code (the licence is).
 */

import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  getDb,
  and,
  eq,
  ne,
  desc,
  notInArray,
  drizzleSql,
  findPgError,
  PG_UNIQUE_VIOLATION,
  uniqueViolationConstraint,
} from "@synap/database";
import {
  rendererBundles,
  rendererBundleVersions,
  rendererHostModules,
} from "@synap/database/schema";
import {
  RENDERER_BUNDLE_KIND,
  rendererSetDigestText,
  validateRendererBundleDefinition,
  type RendererBundleDefinition,
  type RendererBundleHostModules,
} from "@synap-core/types/renderables";
import { unmetRendererBundleRequirements } from "@synap-core/types/cell-bridge";
import { officialContentHash } from "@synap/jobs/workers/marketplace-source-verify.js";
import { installCellFromDefinition } from "../cells/install-cell-from-definition.js";
import { emitCellWritten } from "../cells/define-cell.js";

/** Machine reasons on the refusals below (`error.data.reasonCode`). */
export const RENDERER_BUNDLE_INVALID = "RENDERER_BUNDLE_INVALID" as const;
export const RENDERER_BUNDLE_HASH_MISMATCH =
  "RENDERER_BUNDLE_HASH_MISMATCH" as const;
export const RENDERER_HOST_SET_TAKEN = "RENDERER_HOST_SET_TAKEN" as const;
export const RENDERER_BUNDLE_INSTALL_RACED =
  "RENDERER_BUNDLE_INSTALL_RACED" as const;
export const RENDERER_BUNDLE_REQUIRES_UNMET =
  "RENDERER_BUNDLE_REQUIRES_UNMET" as const;

/** Serialises renderer bundle installs (`pg_advisory_xact_lock`). */
const INSTALL_LOCK_KEY = "renderer-bundles:install";

/** sha256 (hex) of a string's UTF-8 bytes. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The identity of a host-module set: sha256 of `rendererSetDigestText` (the
 * contract's ONE text: `"<module> <sha256>\n"` lines sorted by module name,
 * the same the official bundle's build and every host use); a host caches
 * the set under it.
 */
export function rendererSetSha256(
  hashes: Readonly<Record<string, string>>
): string {
  return sha256Hex(rendererSetDigestText({ ...hashes }));
}

/** Every declared hash that does not match its source, by definition path. */
export function rendererBundleHashMismatches(
  definition: RendererBundleDefinition
): string[] {
  const wrong: string[] = [];
  const actual: Record<string, string> = {};
  for (const [name, mod] of Object.entries(definition.hostModules)) {
    if (!mod) continue;
    actual[name] = sha256Hex(mod.source);
    if (actual[name] !== mod.sha256) wrong.push(`hostModules.${name}.sha256`);
  }
  if (rendererSetSha256(actual) !== definition.setSha256)
    wrong.push("setSha256");
  definition.cells.forEach((cell, i) => {
    if (sha256Hex(cell.code) !== cell.sha256) wrong.push(`cells[${i}].sha256`);
  });
  return wrong;
}

export interface InstallRendererBundleOptions {
  /** The person installing (an approved proposal's approver). */
  userId: string;
  /** The catalog source the definition came from (`synap`). */
  source: string;
  /**
   * The bundle's version: the catalog row's (`package.version`, what Synap's
   * signed index lists), never the definition's own `_meta.version`.
   */
  version: string;
}

export interface InstalledRendererBundle {
  slug: string;
  version: string;
  /** The digest recorded for this version (`officialContentHash`). */
  contentHash: string;
  /** The version this install replaced; null on a first install. */
  previousVersion: string | null;
  setSha256: string;
  cells: Array<{ typeKey: string; changeType: "created" | "updated" }>;
}

/** The digest of a bundle definition, as Synap's signed index lists it. */
export function rendererBundleContentHash(
  definition: Record<string, unknown>
): string {
  return officialContentHash(RENDERER_BUNDLE_KIND, definition);
}

/** The host-module constraints a racing install can meet. */
const HOST_MODULE_CONSTRAINTS = [
  "renderer_host_modules_one_set",
  "renderer_host_modules_pkey",
] as const;

/**
 * The database refused a host-module row (another install's rows, committed
 * while this one ran): the one-set index or the (bundle, module) key.
 */
function isHostModuleViolation(err: unknown): boolean {
  const e = findPgError(err, PG_UNIQUE_VIOLATION);
  if (!e) return false;
  // A driver that names no constraint still names it in its message.
  const name = uniqueViolationConstraint(err) ?? "";
  const message = String((e as { message?: unknown }).message ?? "");
  return HOST_MODULE_CONSTRAINTS.some((c) => name === c || message.includes(c));
}

/** Who holds the pod's host-module set now, read after a refused write. */
async function hostSetHolder(): Promise<string | null> {
  const db = await getDb();
  const [row] = await db
    .select({ slug: rendererHostModules.bundleSlug })
    .from(rendererHostModules)
    .limit(1);
  return row?.slug ?? null;
}

function hostSetTaken(slug: string, holder: string | null): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: holder
      ? `This pod already runs the renderer bundle "${holder}". A pod runs one host-module set: "${slug}" was not installed.`
      : `This pod already runs another renderer bundle's host modules: "${slug}" was not installed.`,
    cause: { reasonCode: RENDERER_HOST_SET_TAKEN, holder },
  });
}

export async function installRendererBundle(
  definition: unknown,
  options: InstallRendererBundleOptions
): Promise<InstalledRendererBundle> {
  // First: a bundle built for a newer pod is "not yet", never "invalid".
  const unmet = unmetRendererBundleRequirements(definition);
  if (unmet.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `This pod cannot run this renderer bundle yet: ${unmet.join(" ")} Update the pod first. Nothing was installed.`,
      cause: { reasonCode: RENDERER_BUNDLE_REQUIRES_UNMET, unmet },
    });
  }
  const problems = validateRendererBundleDefinition(definition);
  if (problems.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The renderer bundle cannot be installed: ${problems
        .slice(0, 5)
        .map((p) => (p.path ? `${p.path}: ${p.message}` : p.message))
        .join(" ")}`,
      cause: { reasonCode: RENDERER_BUNDLE_INVALID, problems },
    });
  }
  const def = definition as RendererBundleDefinition;
  const mismatches = rendererBundleHashMismatches(def);
  if (mismatches.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The renderer bundle's sources do not match their declared sha256 (${mismatches.join(", ")}). Nothing was installed.`,
      cause: { reasonCode: RENDERER_BUNDLE_HASH_MISMATCH, mismatches },
    });
  }

  const { slug } = def._meta;
  const { version } = options;
  const contentHash = rendererBundleContentHash(
    definition as Record<string, unknown>
  );
  const modules = Object.entries(def.hostModules) as Array<
    [keyof RendererBundleHostModules, { source: string; sha256: string }]
  >;
  const db = await getDb();
  let cells: InstalledRendererBundle["cells"];
  let previousVersion: string | null = null;
  try {
    cells = await db.transaction(async (tx) => {
      // One install at a time per pod: a second install (the same slug or
      // another) waits here, then sees the first one committed, so the same
      // slug re-installs over it and another slug meets the refusal below.
      await tx.execute(
        drizzleSql`select pg_advisory_xact_lock(hashtext(${INSTALL_LOCK_KEY}))`
      );
      // One host set per pod: the friendly refusal (the index is the floor).
      const [holder] = await tx
        .select({ slug: rendererHostModules.bundleSlug })
        .from(rendererHostModules)
        .where(ne(rendererHostModules.bundleSlug, slug))
        .limit(1);
      if (holder) throw hostSetTaken(slug, holder.slug);

      const [before] = await tx
        .select({ version: rendererBundles.version })
        .from(rendererBundles)
        .where(eq(rendererBundles.slug, slug))
        .limit(1);
      previousVersion = before?.version ?? null;

      await tx
        .delete(rendererHostModules)
        .where(eq(rendererHostModules.bundleSlug, slug));
      await tx.insert(rendererHostModules).values(
        modules.map(([name, mod]) => ({
          bundleSlug: slug,
          module: name,
          source: mod.source,
          sha256: mod.sha256,
          byteLength: Buffer.byteLength(mod.source, "utf8"),
        }))
      );

      const written: InstalledRendererBundle["cells"] = [];
      for (const cell of def.cells) {
        const result = await installCellFromDefinition({
          definition: {
            key: cell.key,
            code: cell.code,
            contentKind: cell.contentKind,
            viewTypes: cell.viewTypes,
            defaultSize: cell.defaultSize,
            minSize: cell.minSize,
            rendererType: "frame",
          },
          name: cell.name,
          packageSlug: slug,
          cellKey: cell.key,
          workspaceId: null,
          packageVersion: version,
          userId: options.userId,
          tx,
        });
        written.push({
          typeKey: result.typeKey,
          changeType: result.changeType,
        });
      }

      // The definitions kept for Undo: this one, and the one it replaces.
      await tx
        .insert(rendererBundleVersions)
        .values({
          slug,
          version,
          contentHash,
          definition: definition as Record<string, unknown>,
        })
        .onConflictDoUpdate({
          target: [rendererBundleVersions.slug, rendererBundleVersions.version],
          set: {
            contentHash,
            definition: drizzleSql`excluded.definition`,
            installedAt: new Date(),
          },
        });
      // N-1 is the newest OTHER version: a reinstall of the same version
      // keeps the one before it, so its Undo still has somewhere to go.
      const [prior] = await tx
        .select({ version: rendererBundleVersions.version })
        .from(rendererBundleVersions)
        .where(
          and(
            eq(rendererBundleVersions.slug, slug),
            ne(rendererBundleVersions.version, version)
          )
        )
        .orderBy(desc(rendererBundleVersions.installedAt))
        .limit(1);
      const keep = prior ? [version, prior.version] : [version];
      await tx
        .delete(rendererBundleVersions)
        .where(
          and(
            eq(rendererBundleVersions.slug, slug),
            notInArray(rendererBundleVersions.version, keep)
          )
        );

      // Last: the bundle row is the install's commit marker.
      const row = {
        version,
        contentHash,
        setSha256: def.setSha256,
        reactVersion: def.reactVersion,
        kitExports: def.kitExports,
        defaults: def.defaults,
        source: options.source,
        installedBy: options.userId,
      };
      await tx
        .insert(rendererBundles)
        .values({ slug, ...row })
        .onConflictDoUpdate({
          target: rendererBundles.slug,
          set: {
            ...row,
            kitExports: drizzleSql`excluded.kit_exports`,
            defaults: drizzleSql`excluded.defaults`,
            updatedAt: new Date(),
          },
        });
      return written;
    });
  } catch (err) {
    // Another install's host modules committed while this one ran (the lock
    // above serialises installs, this is the floor under it): another slug's
    // set is the usual refusal; this same slug's is a race, and retrying is
    // safe (nothing of this attempt was written).
    if (isHostModuleViolation(err)) {
      const holder = await hostSetHolder().catch(() => null);
      if (holder && holder !== slug) throw hostSetTaken(slug, holder);
      throw new TRPCError({
        code: "CONFLICT",
        message: `Another install of the renderer bundle "${slug}" ran at the same moment. Nothing of this one was written: retry it.`,
        cause: { reasonCode: RENDERER_BUNDLE_INSTALL_RACED },
      });
    }
    throw err;
  }

  for (const cell of cells) {
    emitCellWritten(cell, { userId: options.userId, workspaceId: null });
  }
  return {
    slug,
    version,
    contentHash,
    previousVersion,
    setSha256: def.setSha256,
    cells,
  };
}
