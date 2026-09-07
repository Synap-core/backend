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
 *   - cell → no backing row exists, so there is nothing to leak and nothing to
 *     check. Accepted as-is, exactly like `resolveTitles` leaves it with the
 *     artifact's own title.
 *   - url → no backing row either, but the string IS rendered as a link, so it
 *     is scheme-gated (http/https) through `isHttpUrl` — a display-only
 *     check, not the SSRF guard, so loopback/private hosts are allowed.
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
import { isHttpUrl } from "@synap/shared-utils";
import type { SessionArtifactKind } from "./record-session-artifact.js";
// ONE uuid shape floor for the session services — this file had its own copy.
import { UUID_RE } from "./session-metadata.js";

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

  // A `url` output has no backing row to authorize, but it is NOT unvalidated
  // input: the string is rendered as a link in the session room, so a
  // `javascript:` / `data:` ref would be a stored script vector. Scheme-gated
  // through `isHttpUrl` (http/https only) — NOT the SSRF door
  // (`validateExternalUrl`): the pod never fetches this URL, it only renders a
  // link, so a developer recording `http://localhost:3000/...` is legitimate
  // and must be accepted. Loopback/private-host rejection belongs to the
  // outbound-fetch guard, not this display-only reference.
  if (kind === "url") return isHttpUrl(refId);

  // No backing row ⇒ nothing to authorize.
  if (kind === "cell") return true;

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

  // `views` DOES now carry a registered VisibilityRule (added since this file
  // was written), but the read path here stays `assertViewAccess` — the
  // imperative predicate every `views.*` door already calls, which throws on
  // refusal. Keep the two in step: a change to the view visibility rule must be
  // mirrored in `assertViewAccess` or this floor and the view doors disagree.
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
