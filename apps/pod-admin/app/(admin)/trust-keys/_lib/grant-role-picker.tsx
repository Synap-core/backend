"use client";

/**
 * What a new key may touch — picked from ROLES, in pod-admin.
 *
 * pod-admin cannot import the web grant editor (`@synap-core/grant-selector`
 * lives in synap-app, which this app's build cannot see), so here a key starts
 * from a role: a built-in preset or one of the person's stored roles
 * (`grantRoles.list`). Same roles, same grant, same words (`summarizeGrant`)
 * as the full editor; editing a role row by row stays in the browser.
 *
 * "No grant" keeps the legacy behaviour (bounded only by the scopes), and is
 * named for what it is.
 */
import { Button, Select, SelectItem } from "@heroui/react";
import {
  GRANT_PRESETS,
  grantMintFromRole,
  summarizeGrant,
  type GrantDraft,
  type GrantMintInput,
  type GrantRole,
} from "@synap-core/types/grants";
import { trpc } from "../../../../lib/trpc";

export const NO_GRANT = "none";

/**
 * The mint input (`apiKeys.create` `grant` + `expiresInDays`) for the picked
 * role: the role's own permissions, narrowing and lifetime. Where the role
 * sets no lifetime, the dialog's `expiresInDays` applies. `workspaceId` given
 * confines the key to that workspace — a key minted on a workspace's page
 * must never reach beyond it, and the mint door does not confine by
 * `input.workspaceId`. undefined = "No grant" (or an unknown role).
 */
export function keyMintFromRole(
  roleId: string,
  roles: readonly GrantRole[],
  opts: { expiresInDays: number | null; workspaceId?: string }
): GrantMintInput | undefined {
  const role = roles.find((r) => r.id === roleId);
  if (!role) return undefined;
  const mint = grantMintFromRole(role);
  if (opts.workspaceId) {
    // Re-confining a role made for other workspaces would hand it this one.
    if (!roleFitsWorkspace(role, opts.workspaceId))
      throw new Error(`Role "${role.name}" is confined to other workspaces`);
    mint.grant.workspaceIds = [opts.workspaceId];
  }
  if (mint.expiresInDays === undefined) mint.expiresInDays = opts.expiresInDays;
  return mint;
}

/** True when a role sets its own lifetime (the dialog's expiry then yields). */
export function roleSetsLifetime(
  roleId: string,
  roles: readonly GrantRole[]
): boolean {
  return roles.find((r) => r.id === roleId)?.grant.expiresInDays !== undefined;
}

/** A role a key on `workspaceId` may use: not confined to other workspaces. */
export function roleFitsWorkspace(
  role: GrantRole,
  workspaceId: string
): boolean {
  const ws = role.grant.workspaceIds;
  return !ws || ws.length === 0 || ws.includes(workspaceId);
}

/**
 * The key's scopes allow changes its grant does not: a write scope under a
 * grant that only reads. The grant wins, so the dialog must say so.
 */
export function writeScopesIdle(
  scopes: readonly string[],
  minted: GrantMintInput | undefined
): boolean {
  if (!minted || !scopes.some((s) => s.endsWith(".write"))) return false;
  const sum = summarizeGrant(mintDraft(minted));
  return !(
    sum.full ||
    sum.other.length > 0 ||
    sum.rows.some((r) => r.all || r.actions.some((a) => a !== "read"))
  );
}

/** The draft a mint input describes — what the hint line summarizes. */
export function mintDraft(mint: GrantMintInput): GrantDraft {
  return { ...mint.grant, expiresInDays: mint.expiresInDays };
}

export function useGrantRoleOptions(): {
  roles: GrantRole[];
  isError: boolean;
  refetch: () => void;
} {
  const q = trpc.grantRoles.list.useQuery(undefined, { staleTime: 60_000 });
  const stored = ((q.data ?? []) as GrantRole[]).map((r) => ({
    ...r,
    stored: true,
  }));
  return {
    roles: [...GRANT_PRESETS, ...stored],
    isError: q.isError,
    refetch: () => void q.refetch(),
  };
}

export function GrantRolePicker({
  value,
  onChange,
  roles,
  minted,
  scopes,
  rolesFailed,
  onRetryRoles,
  allowNoGrant = true,
  isDisabled,
}: {
  value: string;
  onChange: (roleId: string) => void;
  roles: readonly GrantRole[];
  /** What the key will really get (`keyMintFromRole`), summarized below. */
  minted: GrantMintInput | undefined;
  /** The key's scopes, to flag write scopes the grant leaves idle. */
  scopes?: readonly string[];
  rolesFailed?: boolean;
  onRetryRoles?: () => void;
  /** Off where an ungranted key would escape a boundary (a workspace's keys). */
  allowNoGrant?: boolean;
  isDisabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Select
        label="What it may touch"
        size="sm"
        selectedKeys={[value]}
        onSelectionChange={(keys) => {
          const k = Array.from(keys as Set<string>)[0];
          if (k) onChange(k);
        }}
        isDisabled={isDisabled}
      >
        {[
          ...roles.map((r) => (
            <SelectItem key={r.id} textValue={r.name}>
              {r.name}
            </SelectItem>
          )),
          ...(allowNoGrant
            ? [
                <SelectItem key={NO_GRANT} textValue="No grant">
                  No grant: everything its scopes allow
                </SelectItem>,
              ]
            : []),
        ]}
      </Select>
      <p className="text-tiny text-foreground/65">
        {minted
          ? summarizeGrant(mintDraft(minted)).sentence
          : "Only its scopes bound it."}
      </p>
      {scopes && writeScopesIdle(scopes, minted) ? (
        <p className="text-tiny text-warning">
          Its write scopes do nothing here: this role only reads.
        </p>
      ) : null}
      {rolesFailed ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-tiny text-danger"
        >
          <span>Your saved roles couldn&apos;t be loaded.</span>
          {onRetryRoles ? (
            <Button size="sm" variant="flat" onPress={onRetryRoles}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
