/**
 * Object-room read floors — who may see an object's ONE linked channel.
 *
 * Founder model (Documents v2, 2026-09-25): every document / entity has one
 * conversation, its "object room", and that room is visible EXACTLY when the
 * object is. The channel predicate lives in `@synap/database`
 * (`channelVisibilityWhere`, branch 5), below the access layer, so the floors
 * are REGISTERED from here — built from the objects' own registered
 * VisibilityRules, never a hand-written copy:
 *
 *   - document → the `documents` rule, widened by the `views` rule for a
 *     view-owned document (a canvas) — the SAME two gates `loadReadableDocument`
 *     applies (`document-edit-access.ts`), as SQL;
 *   - entity   → the `entities` rule (`scopedDb(entities)`'s floor).
 *
 * Importing this module registers both. It is imported by
 * `utils/channel-visibility.ts` (every api channel read) and by
 * `document-edit-access.ts`, so the `@synap/api/document-access` entry the
 * realtime server bundles registers them in that process too.
 */

import { QueryBuilder, type AnyPgColumn } from "drizzle-orm/pg-core";
import { and, eq, exists, or, sql as drizzleSql, type SQL } from "drizzle-orm";
import { documents, entities, views } from "@synap/database/schema";
import { registerObjectRoomFloor } from "@synap/database/channel-visibility";
// The access index (not its leaf modules): importing it runs the registry, so
// the `documents` / `views` / `entities` rules exist whenever a floor runs.
import {
  AccessContext,
  getVisibilityEntry,
  visibilityPredicate,
} from "../access/index.js";

const qb = new QueryBuilder();

function ruleFor(table: object, userId: string): SQL | undefined {
  // Lazy: the registry registers on first import of `access/index.js`; this
  // runs at QUERY time, never at module load, so the import order is free.
  return visibilityPredicate(
    getVisibilityEntry(table).rule,
    AccessContext.operator({ userId })
  );
}

/**
 * The document read floor as SQL, correlated to `documentId` — true exactly
 * when `loadReadableDocument(userId, documentId)` would return the row.
 */
export function documentReadableWhere(
  userId: string,
  documentId: AnyPgColumn | SQL
): SQL {
  return or(
    exists(
      qb
        .select({ one: drizzleSql`1` })
        .from(documents)
        .where(and(eq(documents.id, documentId), ruleFor(documents, userId)))
    ),
    // A view-owned document is readable when its view is (loadReadableDocument
    // gate 1's widening).
    and(
      exists(
        qb
          .select({ one: drizzleSql`1` })
          .from(views)
          .where(and(eq(views.documentId, documentId), ruleFor(views, userId)))
      ),
      exists(
        qb
          .select({ one: drizzleSql`1` })
          .from(documents)
          .where(eq(documents.id, documentId))
      )
    )
  )!;
}

/** The entity read floor as SQL, correlated to `entityId`. */
export function entityReadableWhere(
  userId: string,
  entityId: AnyPgColumn | SQL
): SQL {
  return exists(
    qb
      .select({ one: drizzleSql`1` })
      .from(entities)
      .where(and(eq(entities.id, entityId), ruleFor(entities, userId)))
  );
}

registerObjectRoomFloor("document", (userId, objectId) =>
  documentReadableWhere(userId, objectId as AnyPgColumn)
);
registerObjectRoomFloor("entity", (userId, objectId) =>
  entityReadableWhere(userId, objectId as AnyPgColumn)
);
