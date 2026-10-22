/**
 * Postgres integrity violations: the ONE door for recognising them.
 *
 * Drizzle wraps the driver error as `.cause`, tRPC wraps again, PGlite and
 * postgres.js put the SQLSTATE on different levels. A bare
 * `err.code === "23505"` therefore misses the wrapped case and turns a
 * recoverable race into a 500. Every check goes through here; the tripwire
 * `packages/api/src/__tripwires__/pg-error-codes-one-door.test.ts` forbids the
 * code literals and local copies of these predicates anywhere else.
 */

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_NOT_NULL_VIOLATION = "23502";

/** The fields of a driver error this door reads (node-pg, postgres.js, PGlite). */
export interface PgErrorFields {
  code: string;
  /** node-pg and PGlite. */
  constraint?: string;
  /** postgres.js. */
  constraint_name?: string;
}

/** The error in `err`'s cause chain that carries `code`, or undefined. */
export function findPgError(
  err: unknown,
  code: string
): PgErrorFields | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: unknown }).code === code) {
      return current as PgErrorFields;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Postgres unique_violation (23505), also when wrapped as a driver error's cause. */
export function isUniqueViolation(err: unknown): boolean {
  return findPgError(err, PG_UNIQUE_VIOLATION) !== undefined;
}

/** Postgres foreign_key_violation (23503), also when wrapped. */
export function isForeignKeyViolation(err: unknown): boolean {
  return findPgError(err, PG_FOREIGN_KEY_VIOLATION) !== undefined;
}

/** Postgres not_null_violation (23502), also when wrapped. */
export function isNotNullViolation(err: unknown): boolean {
  return findPgError(err, PG_NOT_NULL_VIOLATION) !== undefined;
}

/**
 * The constraint a unique violation names, or undefined when `err` is not
 * one (or the driver did not say which).
 */
export function uniqueViolationConstraint(err: unknown): string | undefined {
  const e = findPgError(err, PG_UNIQUE_VIOLATION);
  const name = e?.constraint_name ?? e?.constraint;
  return typeof name === "string" ? name : undefined;
}
