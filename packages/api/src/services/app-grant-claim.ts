/**
 * The `app_grant` claim of an IS delegation: the grant that bounds ONE app's
 * chat turn, carried in the pod-signed token so every hub call of that turn
 * runs under the app's grant instead of the full-access delegation grant.
 *
 * The pod mints it (`appGrantClaimOf`) from a grant it has already checked; the
 * hub reads it back (`parseAppGrantClaim`) and REFUSES anything that is not a
 * well-formed grant of bounded size. A refused claim is a 401, never a fallback
 * to `*`. The grant only narrows: effective access is grant ∩ the operator's
 * own floor (grants grammar, `grammar.data.ts`).
 */
import {
  InvalidPermissionError,
  parsePermission,
  type GrantScope,
} from "@synap/governance-policy/grants";
import type { KeyGrant } from "@synap/database";

export class AppGrantClaimError extends Error {}

const MAX_SCOPES = 16;
const MAX_PERMISSIONS = 256;

function refuse(why: string): never {
  throw new AppGrantClaimError(`The app grant ${why}.`);
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    refuse(`${name} is not a list of ids`);
  return value as string[];
}

function nullableList(value: unknown, name: string): string[] | null {
  if (value === undefined || value === null) return null;
  return stringList(value, name);
}

/** The claim for a grant (the pod side). Plain JSON, no extra fields. */
export function appGrantClaimOf(grant: KeyGrant): Record<string, unknown> {
  return {
    scopes: grant.scopes.map((s) => ({
      permissions: [...s.permissions],
      workspaceIds: s.workspaceIds ?? null,
      projectIds: s.projectIds ?? null,
      entityIds: s.entityIds ?? null,
    })),
    clientId: grant.clientId ?? null,
  };
}

/**
 * The grant a claim names (the hub side). Throws `AppGrantClaimError` for any
 * shape it does not accept: a non-object, no scopes, a scope without a
 * permission list, a permission the grammar does not parse, or a bad id list.
 * A deny-all scope (`permissions: []`) is valid: it reads nothing.
 */
export function parseAppGrantClaim(raw: unknown): KeyGrant {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    refuse("is not an object");
  const claim = raw as Record<string, unknown>;
  if (!Array.isArray(claim.scopes) || claim.scopes.length === 0)
    refuse("names no scope");
  if (claim.scopes.length > MAX_SCOPES) refuse("has too many scopes");
  if (claim.clientId !== undefined && claim.clientId !== null) {
    if (typeof claim.clientId !== "string") refuse("names a bad client");
  }

  const scopes: GrantScope[] = claim.scopes.map((s: unknown) => {
    if (!s || typeof s !== "object" || Array.isArray(s))
      refuse("has a scope that is not an object");
    const scope = s as Record<string, unknown>;
    if (!Array.isArray(scope.permissions))
      refuse("has a scope with no permission list");
    if (scope.permissions.length > MAX_PERMISSIONS)
      refuse("has too many permissions");
    for (const p of scope.permissions) {
      if (typeof p !== "string") refuse("has a permission that is not text");
      try {
        parsePermission(p);
      } catch (err) {
        if (err instanceof InvalidPermissionError)
          refuse(`has an invalid permission "${p}"`);
        throw err;
      }
    }
    return {
      permissions: scope.permissions as string[],
      workspaceIds: nullableList(scope.workspaceIds, "workspace list"),
      projectIds: nullableList(scope.projectIds, "project list"),
      entityIds: nullableList(scope.entityIds, "object list"),
    };
  });

  return {
    scopes,
    clientId: typeof claim.clientId === "string" ? claim.clientId : null,
  };
}
