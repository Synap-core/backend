/**
 * A client app's component kit, as the design door reads it (plan 0fc746f4
 * §3.1 K1, W6): the app (`devplane_app`) names a `file` entity in its
 * `design-kit` property, the kit's catalog.json published by the app's own
 * build (`pnpm design:kit --publish` in a Website Factory app). The catalog
 * names the kit's two code files (kit.js, kit.css) and pins each by the
 * sha256 of its bytes.
 *
 * Reads go through the caller's read floor: the app entity through
 * `entityReadVisibleWhere`, each file through `readableFileEntity` (the floor
 * every file door shares, a key's grant included). A kit that cannot be read
 * is an ERROR naming why, never "no kit": a design of an app with a kit is
 * never silently checked against Synap's components instead.
 */
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, db, eq, isNull, entities } from "@synap/database";
import { storage } from "@synap/storage";
import {
  DESIGN_KIT_PROPERTY,
  readKitCatalog,
  type DesignKitCatalog,
  type KitPart,
} from "@synap-core/types/design-board";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";

/** The kind of an app (builder.yaml). */
export const APP_PROFILE = "devplane_app";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AppKitRead =
  /** The app names no kit: its designs are drawn with Synap's components. */
  | { status: "none"; appId: string }
  | {
      status: "kit";
      appId: string;
      /** The `file` entity holding the catalog (the app's `design-kit`). */
      catalogFileId: string;
      kit: DesignKitCatalog;
    };

const precondition = (message: string) =>
  new TRPCError({ code: "PRECONDITION_FAILED", message });

async function loadApp(userId: string, appId: string) {
  if (!UUID.test(appId))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `appId "${appId}" is not an id.`,
    });
  const [row] = await db
    .select({
      id: entities.id,
      type: entities.type,
      properties: entities.properties,
    })
    .from(entities)
    .where(
      and(
        eq(entities.id, appId),
        isNull(entities.deletedAt),
        entityReadVisibleWhere(userId)
      )
    )
    .limit(1);
  if (!row)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No app ${appId} you can read.`,
    });
  if (row.type !== APP_PROFILE)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${appId} is a ${row.type}, not an app (${APP_PROFILE}).`,
    });
  return {
    id: row.id,
    properties: (row.properties ?? {}) as Record<string, unknown>,
  };
}

/** A file's bytes, through the file read floor. */
async function readFileBytes(
  userId: string,
  fileId: string,
  what: string
): Promise<Buffer> {
  const { readableFileEntity } = await import("../../routers/file-upload.js");
  const readable = await readableFileEntity(userId, fileId);
  if (!readable.ok)
    throw new TRPCError({
      code: readable.status === 404 ? "NOT_FOUND" : "FORBIDDEN",
      message: `${what} (file ${fileId}): ${readable.error}`,
    });
  if (!readable.entity.storageKey)
    throw precondition(`${what} (file ${fileId}) has no stored bytes.`);
  return storage.downloadBuffer(readable.entity.storageKey);
}

/**
 * The app's kit, or `none` when it names none. Throws (with the reason and
 * what to do) when the app cannot be read, or names a kit whose catalog
 * cannot be read or trusted.
 */
export async function readAppKit(
  userId: string,
  appId: string
): Promise<AppKitRead> {
  const app = await loadApp(userId, appId);
  const ref = app.properties[DESIGN_KIT_PROPERTY];
  if (ref === undefined || ref === null || ref === "")
    return { status: "none", appId };
  if (typeof ref !== "string" || !UUID.test(ref))
    throw precondition(
      `App ${appId}'s ${DESIGN_KIT_PROPERTY} is not a file id; publish the kit again (pnpm design:kit --publish).`
    );
  const bytes = await readFileBytes(userId, ref, `App ${appId}'s design kit`);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw precondition(
      `App ${appId}'s design kit (file ${ref}) is not JSON; publish the kit again (pnpm design:kit --publish).`
    );
  }
  const read = readKitCatalog(raw);
  if (!read.ok)
    throw precondition(
      `App ${appId}'s design kit (file ${ref}) cannot be used: ${read.error}`
    );
  return { status: "kit", appId, catalogFileId: ref, kit: read.catalog };
}

export interface KitPartRead {
  kitId: string;
  /** The kit's hash (schema, canvas and both files' bytes). */
  hash: string;
  part: KitPart;
  sha256: string;
  bytes: Buffer;
}

/**
 * One of the app's kit code files, checked against the sha256 its catalog
 * pins: bytes that are not the published ones are refused, never served.
 */
export async function readKitPart(
  userId: string,
  appId: string,
  part: KitPart
): Promise<KitPartRead> {
  const read = await readAppKit(userId, appId);
  if (read.status === "none")
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `App ${appId} has no design kit: its designs are drawn with Synap's components.`,
    });
  const ref = read.kit.kit.files[part];
  const bytes = await readFileBytes(
    userId,
    ref.entityId,
    `App ${appId}'s kit ${part}`
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== ref.sha256)
    throw precondition(
      `App ${appId}'s kit ${part} (file ${ref.entityId}) is not the one its catalog pins (sha256 ${sha256.slice(0, 12)}…, expected ${ref.sha256.slice(0, 12)}…); publish the kit again.`
    );
  return { kitId: read.kit.kitId, hash: read.kit.hash, part, sha256, bytes };
}
