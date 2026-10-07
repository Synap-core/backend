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
import { Select, SelectItem } from "@heroui/react";
import {
  GRANT_PRESETS,
  summarizeGrant,
  type GrantRole,
} from "@synap-core/types/grants";
import { trpc } from "../../../../lib/trpc";

export const NO_GRANT = "none";

/** The mint input a picked role becomes (`apiKeys.create` `grant`). */
export function grantFromRole(
  roleId: string,
  roles: readonly GrantRole[]
): { permissions: string[]; roleId?: string } | undefined {
  const role = roles.find((r) => r.id === roleId);
  if (!role) return undefined;
  return {
    permissions: [...role.grant.permissions],
    // Lineage is recorded only for the person's own stored roles.
    ...(role.stored ? { roleId: role.id } : {}),
  };
}

export function useGrantRoleOptions(): {
  roles: GrantRole[];
  isError: boolean;
} {
  const q = trpc.grantRoles.list.useQuery(undefined, { staleTime: 60_000 });
  const stored = ((q.data ?? []) as GrantRole[]).map((r) => ({
    ...r,
    stored: true,
  }));
  return { roles: [...GRANT_PRESETS, ...stored], isError: q.isError };
}

export function GrantRolePicker({
  value,
  onChange,
  roles,
  rolesFailed,
  isDisabled,
}: {
  value: string;
  onChange: (roleId: string) => void;
  roles: readonly GrantRole[];
  rolesFailed?: boolean;
  isDisabled?: boolean;
}) {
  const picked = roles.find((r) => r.id === value);
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
          <SelectItem key={NO_GRANT} textValue="No grant">
            No grant: everything its scopes allow
          </SelectItem>,
        ]}
      </Select>
      <p className="text-[11.5px] text-foreground/55">
        {picked
          ? summarizeGrant(picked.grant).what
          : "Only its scopes bound it."}
        {rolesFailed ? " Your saved roles couldn't be loaded." : ""}
      </p>
    </div>
  );
}
