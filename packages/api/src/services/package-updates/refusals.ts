/**
 * The typed refusals of a package update: a `TRPCError` (so tRPC and the Hub
 * map its status the usual way) that also names a `reasonCode` a client
 * branches on instead of the sentence's wording.
 *
 *   INVALID_CATALOG_DEFINITION  400  the catalog's definition does not fit the
 *                                    pod's schema; the sentence names the
 *                                    template and each failing field, and the
 *                                    zod issues travel as `fieldErrors` (tRPC
 *                                    `data.fieldErrors`, Hub `fieldErrors`).
 *   NEEDS_PERSON                403  only a person can do it, on pod admin
 *                                    (agree to data changes, change a view).
 *   CHOICES_NEEDED              400  a field both sides changed needs a
 *                                    choice (`choices`), which pod admin asks.
 *
 * The code rides on the error AND on its `cause`: tRPC's formatter forwards
 * `cause.reasonCode` (init-trpc.ts), and the Hub door reads it with
 * `refusalReasonOf`, duck-typed, so a `TRPCError` from another copy of the
 * module still reads.
 */

import { TRPCError } from "@trpc/server";
import {
  zodIssuesSentence,
  type ZodIssueLike,
} from "../../utils/zod-field-errors.js";

export const PACKAGE_UPDATE_REFUSALS = [
  "INVALID_CATALOG_DEFINITION",
  "NEEDS_PERSON",
  "CHOICES_NEEDED",
] as const;
export type PackageUpdateRefusal = (typeof PACKAGE_UPDATE_REFUSALS)[number];

type RefusalError = TRPCError & { reasonCode: PackageUpdateRefusal };

export function packageUpdateRefusal(
  code: "BAD_REQUEST" | "FORBIDDEN",
  reasonCode: PackageUpdateRefusal,
  message: string,
  /** Extra fields for the cause (zod `issues` + `name` for field errors). */
  causeFields: Record<string, unknown> = {}
): RefusalError {
  // The cause's message is the code, never the sentence: tRPC's formatter
  // swaps a message equal to a ZodError cause's for the bare field list, which
  // would drop the template's name.
  const cause = Object.assign(new Error(reasonCode), causeFields, {
    reasonCode,
  });
  const err = new TRPCError({ code, message, cause }) as RefusalError;
  err.reasonCode = reasonCode;
  return err;
}

/**
 * The catalog definition of `slug` failed the pod's schema: one sentence that
 * names the template and each failing field; the cause reads as a ZodError
 * (`name` + `issues`), so both doors project the same `fieldErrors`.
 * Incident 2026-11-02: Content OS's "Produce Content" stage goal was 5,225
 * characters against the 5,000 cap, and pod admin said only "invalid
 * definition".
 */
export function invalidCatalogDefinition(
  slug: string,
  zodError: { issues: readonly ZodIssueLike[] }
): RefusalError {
  return packageUpdateRefusal(
    "BAD_REQUEST",
    "INVALID_CATALOG_DEFINITION",
    `The catalog's definition of "${slug}" does not fit this pod (${zodIssuesSentence(zodError.issues)}). Nothing was applied: the template needs fixing in the catalog.`,
    { name: "ZodError", issues: zodError.issues }
  );
}

/** The refusal's `reasonCode`, when the error (or its cause) is one of these. */
export function refusalReasonOf(err: unknown): PackageUpdateRefusal | null {
  let cursor: unknown = err;
  for (
    let depth = 0;
    cursor && typeof cursor === "object" && depth < 3;
    depth++
  ) {
    const code = (cursor as { reasonCode?: unknown }).reasonCode;
    if (
      typeof code === "string" &&
      (PACKAGE_UPDATE_REFUSALS as readonly string[]).includes(code)
    )
      return code as PackageUpdateRefusal;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}
