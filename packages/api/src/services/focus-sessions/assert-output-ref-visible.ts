/**
 * `assertOutputRefVisible` — the visibility floor for the object an output
 * POINTS AT, applied at both attach-output doors before the ledger row exists.
 *
 * WHY: the two doors only ever checked the SESSION (owner floor). `refId` was
 * accepted as an opaque string and written straight into `artifacts.ref_id`.
 * `resolveTitles` (`session-outputs.ts`) then resolves every referenced object
 * by bare `inArray(id)` — deliberately, because it is reading rows the session
 * already claims. So posting ANY uuid to your OWN session and re-reading the
 * room returned that object's LIVE title: a cheap, authenticated read oracle
 * over every entity, document and view in the pod.
 *
 * The fix belongs at the DOOR, not in the reader: an output must reference
 * something the caller can already see, and once that holds, `resolveTitles`'
 * bare join is correct rather than merely convenient.
 *
 * Each kind is resolved through the floor that kind's OWN read door uses — never
 * a fourth hand-rolled predicate:
 *   - entity / document → the registered `VisibilityRule` via `scopedDb`
 *     (`accessScopeWhere` — the same predicate `entities.search` and
 *     `documents` reads apply, exposure and facet-lens included).
 *   - view → `assertViewAccess` (`routers/views.ts`), the imperative twin of
 *     `viewVisibleWhere` that every `views.*` door already calls.
 *   - automation / playbook → their registered `VisibilityRule` via `scopedDb`
 *     (the `workspace` lens with `nullWorkspaceMeans: "podGlobalConfig"` — a
 *     NULL-workspace automation or playbook IS pod-wide substrate every
 *     workspace can see, unlike an artifact, so a pod-wide one legitimately
 *     passes this floor).
 *   - cell / url → no backing row exists (and `url` is not even a uuid), so
 *     there is nothing to leak and nothing to check. Accepted as-is, exactly
 *     like `resolveTitles` leaves them with the artifact's own title.
 */

import { db, eq } from "@synap/database";
import {
  entities,
  documents,
  views,
  automations,
  playbooks,
} from "@synap/database/schema";
// The BARREL, not the leaf modules: importing it runs `registry.ts`'s
// registration side effects, without which `scopedDb` throws on every table.
import { AccessContext, scopedDb } from "../../access/index.js";
import { assertViewAccess } from "../../routers/views.js";
import type { SessionArtifactKind } from "./record-session-artifact.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `userId` may already see the object `kind:refId` names — i.e. when
 * recording it as a session output reveals nothing new.
 *
 * Returns a BOOLEAN rather than throwing so each door can shape its own refusal
 * (tRPC `NOT_FOUND`, REST 404). Deliberately indistinguishable from "does not
 * exist": telling an unauthorised caller the id is real is the leak, smaller.
 */
export async function isOutputRefVisible(params: {
  userId: string;
  kind: SessionArtifactKind;
  refId: string;
}): Promise<boolean> {
  const { userId, kind, refId } = params;

  // No backing row ⇒ nothing to authorize. `url` is not a uuid at all.
  if (kind === "url" || kind === "cell") return true;

  // The three backed kinds are keyed by uuid columns; a non-uuid can name no
  // row, and comparing it would be a PG 22P02 rather than a refusal. The read
  // side skips non-uuid refs for the same reason (`resolveTitles`' UUID_RE).
  if (!UUID_RE.test(refId)) return false;

  const access = AccessContext.operator({ userId });

  if (kind === "entity") {
    const row = await scopedDb(access).findFirst(entities, {
      where: eq(entities.id, refId),
      columns: { id: true },
    });
    return Boolean(row);
  }

  if (kind === "document") {
    const row = await scopedDb(access).findFirst(documents, {
      where: eq(documents.id, refId),
      columns: { id: true },
    });
    return Boolean(row);
  }

  if (kind === "automation") {
    const row = await scopedDb(access).findFirst(automations, {
      where: eq(automations.id, refId),
      columns: { id: true },
    });
    return Boolean(row);
  }

  if (kind === "playbook") {
    const row = await scopedDb(access).findFirst(playbooks, {
      where: eq(playbooks.id, refId),
      columns: { id: true },
    });
    return Boolean(row);
  }

  // `views` has no registered VisibilityRule (it is not read through scopedDb);
  // its door-level predicate is `assertViewAccess`, which throws on refusal.
  const view = await db.query.views.findFirst({
    where: eq(views.id, refId),
    columns: { id: true, workspaceId: true, userId: true },
  });
  if (!view) return false;
  try {
    await assertViewAccess(view, userId, "read");
    return true;
  } catch {
    return false;
  }
}
