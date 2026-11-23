/**
 * A module frame's WRITE (`CellFrameWriteRequest`, already checked and
 * stamped by `createCellFrameHost`) → the pod's governed door, called with
 * the VIEWER'S session:
 *
 *   create_entity   → entities.create
 *   update_entity   → entities.update (a `title`, `properties` or both,
 *                     with `expectedStatus`)
 *   delete_entity   → entities.delete
 *   create_relation → relations.create
 *
 * Every call carries the host's stamp, never the frame's: `viewContext`
 * (the frame's type and view, from which the pod re-resolves its trust),
 * `source: "user"` and the host's lens. The pod decides
 * (`checkPermissionOrPropose`): an untrusted view's write becomes a proposal.
 *
 * The answer is what the POD said, mapped to approved / proposed / denied
 * (`readWriteAnswer`). Nothing is applied optimistically, and an answer this
 * reader does not recognise is never "approved".
 *
 * An approved write's `data` has ONE shape on every host (the desktop's
 * too), never mixed with `status`:
 *
 *   create_entity   → the entity record the pod returned (unwrapped)
 *   update_entity   → the entity record as the write left it (`id` + `written`)
 *   delete_entity   → `{ id }`
 *   create_relation → the relation record (`id`, both ends, `type`)
 */

import type {
  CellBridgeMutateResult,
  CellFrameWriteRequest,
} from "@synap-core/types/cell-bridge";
import { readableError } from "../../../../lib/format";
import type { BridgeClient } from "./html-bridge-reads";

export type WriteAnswer = {
  status?: unknown;
  proposalId?: unknown;
  id?: unknown;
  entity?: Record<string, unknown> | null;
  written?: Record<string, unknown> | null;
  statusMove?: { status?: unknown; proposalId?: unknown } | null;
};

const APPLIED = new Set<unknown>(["created", "updated", "deleted"]);

/** What the frame reads when the pod's answer says neither yes nor no. */
export const UNREAD_WRITE_ANSWER =
  "The pod did not say whether the change was made.";

/** What the frame reads when the pod refused without a sentence of its own. */
export const REFUSED_WRITE_ANSWER = "The pod refused this change.";

/**
 * The pod's answer to one write, as the frame reads it. `dataOf` is the op's
 * `data` (see the header); without it an approved answer carries its id.
 */
export function readWriteAnswer(
  answer: unknown,
  dataOf?: (answer: WriteAnswer) => unknown
): CellBridgeMutateResult {
  const a = (answer ?? {}) as WriteAnswer;
  if (a.status === "proposed") {
    return typeof a.proposalId === "string"
      ? { status: "proposed", proposalId: a.proposalId }
      : { status: "proposed" };
  }
  if (APPLIED.has(a.status)) {
    // An update whose status move was sent for review: the move waits, so
    // the frame must not draw the card in its new column.
    if (a.statusMove?.status === "proposed") {
      return typeof a.statusMove.proposalId === "string"
        ? { status: "proposed", proposalId: a.statusMove.proposalId }
        : { status: "proposed" };
    }
    if (dataOf) return { status: "approved", data: dataOf(a) };
    const id =
      typeof a.entity?.id === "string"
        ? a.entity.id
        : typeof a.id === "string"
          ? a.id
          : undefined;
    return id ? { status: "approved", data: { id } } : { status: "approved" };
  }
  return { status: "denied", error: UNREAD_WRITE_ANSWER };
}

/** A thrown tRPC error, as the client hands it. */
type WriteError = { message?: string; data?: { code?: string | null } | null };

/**
 * A refusal the pod TYPED as one (FORBIDDEN) is a denial with its sentence;
 * any other failure is thrown on, and the frame host answers it as a denial
 * with the error's text (`cellBridgeErrorText`).
 */
function deniedOrThrow(err: unknown): CellBridgeMutateResult {
  const e = err as WriteError;
  if (e?.data?.code === "FORBIDDEN") {
    const detail = readableError(e.message);
    return detail
      ? { status: "denied", error: detail }
      : { status: "denied", error: REFUSED_WRITE_ANSWER };
  }
  throw err;
}

/** The header lens for a call the pod reads its space from. */
function lensContext(request: CellFrameWriteRequest) {
  const ws = request.lens.workspaceId;
  return ws ? { context: { workspaceId: ws } } : undefined;
}

/** One checked, stamped write → the pod's governed door → its answer. */
export async function writeForFrame(
  client: BridgeClient,
  request: CellFrameWriteRequest
): Promise<CellBridgeMutateResult> {
  const { viewContext, source } = request;
  try {
    switch (request.op) {
      case "create_entity": {
        const p = request.payload;
        return readWriteAnswer(
          await client.entities.create.mutate(
            {
              profileSlug: p.profileSlug,
              ...(p.title !== undefined ? { title: p.title } : {}),
              ...(p.properties !== undefined
                ? { properties: p.properties }
                : {}),
              source,
              viewContext,
            },
            lensContext(request)
          ),
          (a) => a.entity ?? (typeof a.id === "string" ? { id: a.id } : {})
        );
      }
      case "update_entity": {
        const p = request.payload;
        return readWriteAnswer(
          await client.entities.update.mutate(
            {
              id: p.id,
              ...(p.title !== undefined ? { title: p.title } : {}),
              ...(p.properties !== undefined
                ? { properties: p.properties }
                : {}),
              ...(p.expectedStatus !== undefined
                ? { expectedStatus: p.expectedStatus }
                : {}),
              source,
              viewContext,
            },
            lensContext(request)
          ),
          (a) => ({ ...(a.written ?? {}), id: p.id })
        );
      }
      case "delete_entity": {
        const { id } = request.payload;
        return readWriteAnswer(
          await client.entities.delete.mutate(
            { id, source, viewContext },
            lensContext(request)
          ),
          () => ({ id })
        );
      }
      case "create_relation": {
        const p = request.payload;
        const ws = request.lens.workspaceId;
        return readWriteAnswer(
          await client.relations.create.mutate({
            sourceEntityId: p.sourceEntityId,
            targetEntityId: p.targetEntityId,
            type: p.type,
            viewContext,
            ...(ws ? { workspaceId: ws } : {}),
          }),
          (a) => ({
            ...(typeof a.id === "string" ? { id: a.id } : {}),
            sourceEntityId: p.sourceEntityId,
            targetEntityId: p.targetEntityId,
            type: p.type,
          })
        );
      }
      default: {
        // Every op of the one write table has a case: a new op fails the build here.
        const unanswered: never = request;
        throw new Error(
          `"${String((unanswered as { op?: unknown }).op)}" has no write here.`
        );
      }
    }
  } catch (err) {
    return deniedOrThrow(err);
  }
}
