/**
 * Install a RENDERER BUNDLE (decision c91d26dc, spec c9b1e4d0 §3a–§3b): its
 * host-module set, its frame cells and its defaults, as ONE act.
 *
 *   1. the definition passes `validateRendererBundleDefinition` (shape, sizes,
 *      kit imports, each cell's source under the frame rule);
 *   2. the pod RE-HASHES every module and cell with node crypto, and the set
 *      (`rendererSetSha256`), and refuses any declared hash that differs —
 *      the declared ones are never trusted;
 *   3. one transaction: ONE active host-module set per pod (a second slug is
 *      refused `RENDERER_HOST_SET_TAKEN`, and the database refuses it too:
 *      `renderer_host_modules_one_set`), the modules, the cells through the
 *      one cell door (`installCellFromDefinition`: `cell:<slug>:<key>`,
 *      mechanism `frame`, its slot, view types and the bundle's version), and
 *      the bundle row LAST, carrying `defaults` (never `renderer_bindings`:
 *      a binding would beat the desktop's own adapters);
 *   4. after the commit, each written cell is announced (`emitCellWritten`).
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
import { getDb, eq, ne, drizzleSql } from "@synap/database";
import { rendererBundles, rendererHostModules } from "@synap/database/schema";
import {
  validateRendererBundleDefinition,
  type RendererBundleDefinition,
  type RendererBundleHostModules,
} from "@synap-core/types/renderables";
import { installCellFromDefinition } from "../cells/install-cell-from-definition.js";
import { emitCellWritten } from "../cells/define-cell.js";

/** Machine reasons on the refusals below (`error.data.reasonCode`). */
export const RENDERER_BUNDLE_INVALID = "RENDERER_BUNDLE_INVALID" as const;
export const RENDERER_BUNDLE_HASH_MISMATCH =
  "RENDERER_BUNDLE_HASH_MISMATCH" as const;
export const RENDERER_HOST_SET_TAKEN = "RENDERER_HOST_SET_TAKEN" as const;

/** sha256 (hex) of a string's UTF-8 bytes. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The identity of a host-module set: sha256 of the lines
 * `"<module> <sha256>\n"`, sorted by module name. The SAME formula the
 * official bundle's build writes (app-bases
 * `workspace-templates/scripts/build-renderer-bundle.mjs`,
 * `rendererSetSha256`); a host caches the set under it.
 */
export function rendererSetSha256(
  hashes: Readonly<Record<string, string>>
): string {
  return sha256Hex(
    Object.keys(hashes)
      .sort()
      .map((name) => `${name} ${hashes[name]}\n`)
      .join("")
  );
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
}

export interface InstalledRendererBundle {
  slug: string;
  version: string;
  setSha256: string;
  cells: Array<{ typeKey: string; changeType: "created" | "updated" }>;
}

/** The database refused a second host set (`renderer_host_modules_one_set`). */
function isHostSetViolation(err: unknown): boolean {
  for (
    let e = err as
      | {
          code?: unknown;
          constraint?: unknown;
          message?: unknown;
          cause?: unknown;
        }
      | undefined;
    e;
    e = e.cause as typeof e
  ) {
    if (
      e.code === "23505" &&
      (e.constraint === "renderer_host_modules_one_set" ||
        String(e.message ?? "").includes("renderer_host_modules_one_set"))
    )
      return true;
  }
  return false;
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

  const { slug, version } = def._meta;
  const modules = Object.entries(def.hostModules) as Array<
    [keyof RendererBundleHostModules, { source: string; sha256: string }]
  >;
  const db = await getDb();
  let cells: InstalledRendererBundle["cells"];
  try {
    cells = await db.transaction(async (tx) => {
      // One host set per pod: the friendly refusal (the index is the floor).
      const [holder] = await tx
        .select({ slug: rendererHostModules.bundleSlug })
        .from(rendererHostModules)
        .where(ne(rendererHostModules.bundleSlug, slug))
        .limit(1);
      if (holder) throw hostSetTaken(slug, holder.slug);

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

      // Last: the bundle row is the install's commit marker.
      const row = {
        version,
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
    // Two installs of different slugs racing: the index refused the second.
    if (isHostSetViolation(err)) throw hostSetTaken(slug, null);
    throw err;
  }

  for (const cell of cells) {
    emitCellWritten(cell, { userId: options.userId, workspaceId: null });
  }
  return { slug, version, setSha256: def.setSha256, cells };
}
