/**
 * kind-missing — the TYPED refusal of a create whose kind is not available in
 * the space it was filed in.
 *
 * `entities.create` used to throw `TRPCError(NOT_FOUND, "Profile not found:
 * <slug>")`, which the failure classifier reads as `target_missing` ("what it
 * points at no longer exists"). For a capture whose kind lives in ANOTHER
 * space (live 2026-10-22, proposal e8fc00d6: `trend` exists in Ecosystem, the
 * entity was filed into Foundation) that sentence is false, and it hides the
 * one thing the person needs: where the kind does exist.
 *
 * The throw site now attaches a structured cause (`KIND_MISSING`) carrying the
 * slug, the space it was looked up in, and the spaces the caller can see that
 * DO hold an active kind with that exact slug. The message is unchanged
 * ("Profile not found: <slug>"), so every reader of the text keeps working.
 *
 * Pure: no database import. The lookup lives in
 * `services/profiles/kind-elsewhere.ts`; the classifier
 * (`routers/proposals/failure-classification.ts`) reads the cause through
 * {@link readKindMissing}, by SHAPE, because the error may have crossed a
 * tRPC caller hop (tRPC copies a plain-object cause onto an
 * `UnknownCauseError`, keeping its fields).
 */

import { TRPCError } from "@trpc/server";

export const KIND_MISSING_CODE = "KIND_MISSING" as const;

/** A space the caller can see that holds an active kind with the slug. */
export interface KindElsewhere {
  workspaceId: string;
  /** The space's name. */
  name: string;
}

/** What a person needs to understand a missing kind. */
export interface KindMissingDetail {
  /** The slug the write named. */
  profileSlug: string;
  /** The kind's display name where it exists (first match), when known. */
  kindName?: string;
  /** The space the kind was looked up in (null = no space lens). */
  workspaceId: string | null;
  /** That space's name, when known. */
  workspaceName?: string;
  /** Other spaces the caller can see where the kind exists. Empty = nowhere. */
  foundIn: KindElsewhere[];
}

interface KindMissingCause extends KindMissingDetail {
  code: typeof KIND_MISSING_CODE;
}

/** How many other spaces a refusal names. */
export const KIND_ELSEWHERE_MAX = 5;

/** The refusal `entities.create` throws for an unresolvable kind slug. */
export function kindMissingError(detail: KindMissingDetail): TRPCError {
  const cause: KindMissingCause = { code: KIND_MISSING_CODE, ...detail };
  return new TRPCError({
    code: "NOT_FOUND",
    // Kept verbatim: `materializationError` and older readers show this text.
    message: `Profile not found: ${detail.profileSlug}`,
    cause: cause as unknown as Error,
  });
}

const str = (v: unknown, max = 200): string | undefined =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;

/**
 * The missing-kind detail a thrown error carries, read by SHAPE; undefined
 * for any other error. Every field is re-validated: the cause is data.
 */
export function readKindMissing(err: unknown): KindMissingDetail | undefined {
  if (!err || typeof err !== "object") return undefined;
  const cause = (err as { cause?: unknown }).cause as
    Record<string, unknown> | undefined;
  if (!cause || typeof cause !== "object") return undefined;
  if (cause.code !== KIND_MISSING_CODE) return undefined;
  const profileSlug = str(cause.profileSlug, 120);
  if (!profileSlug) return undefined;
  const foundIn = Array.isArray(cause.foundIn)
    ? cause.foundIn
        .map((f) => {
          const r = (f ?? {}) as Record<string, unknown>;
          const workspaceId = str(r.workspaceId, 64);
          const name = str(r.name);
          return workspaceId && name ? { workspaceId, name } : null;
        })
        .filter((f): f is KindElsewhere => f !== null)
        .slice(0, KIND_ELSEWHERE_MAX)
    : [];
  const kindName = str(cause.kindName);
  const workspaceName = str(cause.workspaceName);
  return {
    profileSlug,
    ...(kindName ? { kindName } : {}),
    workspaceId: str(cause.workspaceId, 64) ?? null,
    ...(workspaceName ? { workspaceName } : {}),
    foundIn,
  };
}

/**
 * The person-facing sentence: names the kind, the space, and where it exists.
 * "Couldn't file it — the kind "Trend" isn't available in Foundation. It
 * exists in Ecosystem."
 */
export function kindMissingSentence(detail: KindMissingDetail): string {
  const kind = detail.kindName ?? detail.profileSlug;
  const space = detail.workspaceName ?? "this space";
  const here = `Couldn't file it — the kind "${kind}" isn't available in ${space}.`;
  if (detail.foundIn.length === 0) return here;
  const names = detail.foundIn.map((f) => f.name);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${here} It exists in ${list}.`;
}
