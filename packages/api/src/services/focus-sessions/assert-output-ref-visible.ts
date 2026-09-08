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
import type { ExpectedOutput } from "@synap/playbooks";
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

  if (kind === "view") {
    // `views` DOES now carry a registered VisibilityRule (added since this file
    // was written), but the read path here stays `assertViewAccess` — the
    // imperative predicate every `views.*` door already calls, which throws on
    // refusal. Keep the two in step: a change to the view visibility rule must
    // be mirrored in `assertViewAccess` or this floor and the view doors
    // disagree.
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

  // DEFAULT ARM — a kind this floor cannot adjudicate is REFUSED, never routed
  // to the branch that happens to be last.
  //
  // `view` used to BE the fall-through, so an unparsed `{kind: "anything", id}`
  // was adjudicated as a view: a ref outside the six cleared the floor whenever
  // the id named a readable view, and was then stored verbatim for readers that
  // believe the union. Unreachable from a door that parses (`outputRefWireSchema`
  // enumerates `OUTPUT_REF_KINDS`), which is exactly why it must be explicit
  // here — the floor is what a caller reaching the service DIRECTLY hits, and
  // "the last branch wins" is one refactor away from being a disclosure hole
  // rather than merely a broken contract.
  return false;
}

/**
 * THE SAME FLOOR, for the ref a DECLARED OUTPUT SLOT carries.
 *
 * `ExpectedOutput.ref` points at exactly the kinds a produced artifact can
 * (`OUTPUT_REF_KINDS` = `SESSION_ARTIFACT_KINDS` minus `url`, which is the
 * union's other arm), so it goes through {@link isOutputRefVisible} rather than
 * a second predicate. That matters for the same reason the produced side does:
 * `session-outputs.ts` resolves referenced objects by bare id, and a slot whose
 * ref the caller cannot see would be a read oracle on the declare path instead
 * of the attach path — the identical hole, one door over.
 *
 * Returns the LABELS of the offending slots rather than throwing, so each door
 * shapes its own refusal (the update service returns `denied`, the block door
 * a 400/`BAD_REQUEST`). An empty array means every ref cleared the floor.
 *
 * A slot with no `ref`, or `ref: null` (the wire's CLEAR), has nothing to check.
 * The `{url}` arm was already scheme-gated at the parse by the same `isHttpUrl`
 * this floor uses; it is re-checked here anyway so a caller reaching the service
 * directly — the proposal executor re-applying an approved patch, above all —
 * cannot bypass the parse.
 */
export async function findUnreachableOutputRefs(params: {
  userId: string;
  outputs: ReadonlyArray<Pick<ExpectedOutput, "label" | "ref">>;
}): Promise<string[]> {
  const bad: string[] = [];
  for (const slot of params.outputs) {
    const ref = slot?.ref;
    if (!ref) continue;
    const visible =
      "url" in ref
        ? isHttpUrl(ref.url)
        : await isOutputRefVisible({
            userId: params.userId,
            kind: ref.kind,
            refId: ref.id,
          });
    if (!visible) bad.push(slot.label);
  }
  return bad;
}

/** The refusal sentence both doors say, so they cannot word it two ways. */
export function unreachableOutputRefError(labels: string[]): string {
  return `Cannot reference an object you cannot see, on: ${labels.join(", ")}`;
}
