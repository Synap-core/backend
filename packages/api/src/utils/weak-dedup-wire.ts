import { TRPCError } from "@trpc/server";

/**
 * Client-visible slice of an ENTITY_WEAK_DEDUP cause.
 * `guidance` and any other cause fields stay server-side.
 */
export interface WeakDedupWire {
  reasonCode: "ENTITY_WEAK_DEDUP";
  candidates: Array<{ id: string; title: string | null; type: string }>;
  opRef?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function project(cause: Record<string, unknown> | null): WeakDedupWire | null {
  if (!cause || cause.code !== "ENTITY_WEAK_DEDUP") return null;
  const candidates = Array.isArray(cause.candidates)
    ? cause.candidates.flatMap((row) => {
        const candidate = asRecord(row);
        if (
          !candidate ||
          typeof candidate.id !== "string" ||
          typeof candidate.type !== "string"
        ) {
          return [];
        }
        const title =
          candidate.title === null || typeof candidate.title === "string"
            ? candidate.title
            : null;
        return [{ id: candidate.id, title, type: candidate.type }];
      })
    : [];
  const opRef = typeof cause.opRef === "string" ? cause.opRef : undefined;
  return {
    reasonCode: "ENTITY_WEAK_DEDUP",
    candidates,
    ...(opRef ? { opRef } : {}),
  };
}

/**
 * Read a weak-dedup cause off a thrown error's `cause`.
 * One extra hop: `safeApprovalError` nests the original TRPCError as `cause`
 * when it has to rewrite the message, and the payload then sits on `cause.cause`.
 * A revision-guard CONFLICT has neither shape and returns null.
 */
export function readWeakDedupWire(cause: unknown): WeakDedupWire | null {
  const direct = asRecord(cause);
  const hit = project(direct);
  if (hit) return hit;
  const nested = asRecord(direct?.cause);
  const nestedHit = project(nested);
  if (nestedHit) return nestedHit;
  return project(asRecord(nested?.cause));
}

/** Fields batchApprove stores on a failed item. Empty when this isn't weak dedup. */
export function weakDedupFailureFields(error: unknown): Partial<WeakDedupWire> {
  if (!(error instanceof TRPCError)) return {};
  const wire = readWeakDedupWire(error.cause);
  if (!wire) return {};
  return {
    reasonCode: wire.reasonCode,
    candidates: wire.candidates,
    ...(wire.opRef ? { opRef: wire.opRef } : {}),
  };
}

/**
 * Re-throw a weak-dedup CONFLICT with `opRef` so a composite client can name
 * the op. Other errors are left for the caller to rethrow unchanged.
 */
export function rethrowIfWeakDedup(err: unknown, opRef: string): void {
  if (!(err instanceof TRPCError) || err.code !== "CONFLICT") return;
  const wire = readWeakDedupWire(err.cause);
  if (!wire) return;
  const cause = asRecord(err.cause) ?? asRecord(asRecord(err.cause)?.cause);
  throw new TRPCError({
    code: "CONFLICT",
    message: err.message,
    cause: {
      code: "ENTITY_WEAK_DEDUP",
      candidates: wire.candidates,
      ...(typeof cause?.guidance === "string"
        ? { guidance: cause.guidance }
        : {}),
      opRef,
    },
  });
}
