"use client";

/**
 * /my-vault — self-service INVENTORY of MY OWN vault secrets.
 *
 * The counterpart to `/my-connections`, and built to the same rule: a
 * `protectedProcedure` that is already scoped to `ctx.userId` needs no
 * pod_admin gate to be safe, it just needed a surface. `secretsVault.list`,
 * `.hasVault`, `.getSecurityStats` and `.delete` are all owner-scoped in the
 * router — a member sees and can only touch their own rows (see the
 * `/my-vault` exemption in proxy.ts).
 *
 * WHAT THIS SURFACE DELIBERATELY IS NOT
 *
 * 1. It is not zero-knowledge, and it must never say so. Per
 *    `packages/api/src/routers/secrets-vault.ts` and the `encryptionMode`
 *    column in `packages/database/src/schema/secrets-vault.ts`,
 *    `encryption_mode` defaults to `'server'` and that is the ONLY write path:
 *    the server encrypts with VAULT_SERVER_KEY and CAN decrypt — that is what
 *    lets an agent redeem a credential you granted it. Legacy `'client'` rows
 *    exist but are no longer written. The property a vault actually gives you
 *    is ISOLATION: it is scoped to its owner.
 *
 * 2. It never reveals a plaintext value. `secretsVault.reveal` exists and
 *    works, but this is a browser surface a user may reach from a shared or
 *    borrowed machine. Adding a second plaintext-exposure door here buys
 *    nothing the desktop app does not already own, and widens the blast radius
 *    of a left-open tab. `reveal` is not imported, not called, not linked.
 *
 * 3. It does not author. Creating and editing a secret is the desktop app's
 *    job — the `HandoffCard` below says so rather than rendering a dead
 *    "New secret" button.
 *
 * What is left is the thing the web is genuinely good for: seeing what you
 * hold, and being able to take one away from anywhere.
 */

import { useEffect, useState } from "react";
import { Button, Spinner, addToast } from "@heroui/react";
import { KeyRound, ShieldAlert, Trash2 } from "lucide-react";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { ConfirmModal } from "../(admin)/components/confirm-modal";
import { HandoffCard } from "../(admin)/components/handoff-card";
import { SectionCard } from "../(admin)/components/section-card";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
} from "../(admin)/components/resource-row";
import { formatRelative } from "../(admin)/trust-keys/_lib/format";
import { openIn } from "../../lib/open-in";
import { trpc } from "../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../lib/auth-redirect";

/** One row of `secretsVault.list` — metadata only; never the encrypted blob. */
type VaultSecret = {
  id: string;
  name: string;
  type: string;
  category: string | null;
  isCompromised: boolean;
  lastAccessedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  tags: string[];
};

/**
 * The five Watchtower counters `getSecurityStats` returns, each paired with
 * what it ACTUALLY counts in `SecretsVaultRepository` — because a number a
 * reader cannot interpret is worse than no number. All five are server-side
 * column reads; none of them decrypts anything.
 */
const STAT_MEANINGS: ReadonlyArray<{
  key: "compromised" | "reused" | "weakPasswords" | "oldPasswords" | "noTotp";
  label: string;
  detail: string;
}> = [
  {
    key: "compromised",
    label: "marked compromised",
    detail: "flagged as breached and still stored",
  },
  {
    key: "reused",
    label: "reused passwords",
    detail: "share a password with another of your secrets",
  },
  {
    key: "weakPasswords",
    label: "weak passwords",
    detail: "scored below 3 out of 4 at the time they were saved",
  },
  {
    key: "oldPasswords",
    label: "passwords unchanged for 90 days",
    detail: "passwords whose value has not been rotated in three months",
  },
  {
    key: "noTotp",
    label: "logins without 2FA",
    detail: "password, credential or OAuth secrets carrying no TOTP",
  },
];

export default function MyVaultPage() {
  const secrets = trpc.secretsVault.list.useQuery();
  const hasVault = trpc.secretsVault.hasVault.useQuery();
  const stats = trpc.secretsVault.getSecurityStats.useQuery();
  const utils = trpc.useUtils();
  const [pendingDelete, setPendingDelete] = useState<VaultSecret | null>(null);

  /* `secretsVault.delete` — NOT `deleteSecret`. Both soft-delete, but they
     answer different questions. `deleteSecret` is the headless Hub door: it
     gates on the LOADED row's workspaceId via `assertWorkspaceWrite`, so an
     editor of that workspace can delete a secret they do not own. `delete`
     goes through `repo.delete(id, ctx.userId)`, whose UPDATE is filtered on
     `secrets.user_id = ctx.userId` — the only shape that matches a page whose
     entire promise is "these are yours, and only yours". */
  const remove = trpc.secretsVault.delete.useMutation({
    onSuccess: async () => {
      setPendingDelete(null);
      await Promise.all([
        utils.secretsVault.list.invalidate(),
        utils.secretsVault.getSecurityStats.invalidate(),
      ]);
      addToast({ title: "Secret deleted", color: "default" });
    },
    onError: (err) => {
      setPendingDelete(null);
      addToast({
        title: "Couldn't delete",
        description: err.message,
        color: "danger",
      });
    },
  });

  useEffect(() => {
    if (secrets.isError) redirectToLoginIfUnauthorized(secrets.error);
  }, [secrets.isError, secrets.error]);
  const isAuthRedirecting = secrets.error?.data?.code === "UNAUTHORIZED";

  if (secrets.isLoading || isAuthRedirecting) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner label="Loading your vault" />
      </div>
    );
  }

  const rows = (secrets.data ?? []) as VaultSecret[];
  const attention = STAT_MEANINGS.map((s) => ({
    ...s,
    count: stats.data?.[s.key] ?? 0,
  })).filter((s) => s.count > 0);

  return (
    <div className="mx-auto max-w-[900px] px-6 py-10">
      <header className="mb-6 max-w-2xl">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          My vault
        </h1>
        {/* The honest sentence. This tab's predecessor claimed vaults were
            client-encrypted and unreadable by the pod; they are not. What is
            true — and is the reason to keep secrets here at all — is that the
            vault is scoped to its owner. */}
        <p className="mt-1 text-[13px] leading-5 text-foreground/65">
          Secrets you&apos;ve stored on this Pod. They&apos;re encrypted at rest
          with a key this Pod holds, which is what lets an agent use a
          credential you grant it. What the vault guarantees is isolation:
          nobody else on this Pod can list, use, or delete yours.
        </p>
      </header>

      <div className="flex flex-col gap-5">
        <SectionCard
          title="Stored secrets"
          hint={`${rows.length} in your vault`}
        >
          {secrets.isError ? (
            <ResourceRowError
              message="Couldn't load your vault."
              onRetry={() => void secrets.refetch()}
            />
          ) : rows.length === 0 ? (
            /* `hasVault` is the difference between "you never set one up" and
               "you set one up and it's empty" — two different next actions,
               and the reason this query is here at all. While it is still in
               flight neither claim is safe, so the copy stays neutral. */
            <ResourceRowEmpty
              message={
                hasVault.data === false
                  ? "You haven't set up a vault yet. The desktop app creates one the first time you save a secret."
                  : hasVault.data === true
                    ? "Your vault is set up and empty. Save your first secret from the desktop app."
                    : "Nothing stored yet."
              }
            />
          ) : (
            <div className="-mx-2">
              {rows.map((secret) => (
                <ResourceRow
                  key={secret.id}
                  Icon={KeyRound}
                  primary={secret.name}
                  secondary={describe(secret)}
                  status={
                    secret.isCompromised
                      ? { kind: "down", label: "Compromised" }
                      : undefined
                  }
                  actions={
                    <Button
                      isIconOnly
                      size="sm"
                      radius="md"
                      variant="light"
                      className="min-h-10 text-foreground/65"
                      aria-label={`Delete ${secret.name}`}
                      isLoading={
                        remove.isPending && remove.variables?.id === secret.id
                      }
                      onPress={() => setPendingDelete(secret)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  }
                />
              ))}
            </div>
          )}
        </SectionCard>

        {attention.length > 0 && (
          <SectionCard
            title="Needs attention"
            hint="Derived from stored metadata — no secret is decrypted to compute these"
          >
            <ul className="flex flex-col gap-2.5">
              {attention.map((s) => (
                <li key={s.key} className="flex items-start gap-2.5">
                  <ShieldAlert
                    className="mt-0.5 h-4 w-4 shrink-0 text-status-stale"
                    strokeWidth={2}
                    aria-hidden
                  />
                  <p className="text-[12.5px] leading-relaxed text-foreground/65">
                    <span className="font-medium text-foreground">
                      {s.count} {s.label}
                    </span>{" "}
                    — {s.detail}.
                  </p>
                </li>
              ))}
            </ul>
          </SectionCard>
        )}

        <SectionCard title="Adding and editing" hint="Owned by the desktop app">
          <HandoffCard
            title="Secrets are created and edited in the desktop app"
            body="This page is an inventory: it shows what you hold and lets you delete any of it from anywhere. Saving a new secret, changing a stored value, or reading one back happens in the desktop app, where the vault lives."
            exit={openIn({ kind: "settings", section: "vault" })}
            cta="Open Settings → Vault"
          />
        </SectionCard>
      </div>

      <ConfirmModal
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        /* Stays open until the mutation resolves — same reason as
           /my-connections: closing in onConfirm unmounts the dialog before
           `isPending` can ever render. onSuccess/onError closes it. */
        onConfirm={() => {
          if (!pendingDelete) return;
          remove.mutate({ id: pendingDelete.id });
        }}
        title={`Delete "${pendingDelete?.name ?? "this secret"}"?`}
        consequence={
          <>
            <p>
              The stored value stops being resolvable, and any AI grant on it
              stops working the next time an agent tries to use it.
            </p>
            <p className="mt-2 text-foreground/65">
              It does not change the password or key at the service it belongs
              to — rotate that there — and it does not sign anything out. The
              row is retained internally so its audit trail survives; it will no
              longer appear here.
            </p>
          </>
        }
        confirmLabel="Delete secret"
        /* Scoped to THIS row. A bare `remove.isPending` leaks across rows —
           see the prop's own docblock in confirm-modal.tsx. */
        isPending={
          remove.isPending && remove.variables?.id === pendingDelete?.id
        }
      />
    </div>
  );
}

/** Type · category · timestamps · tags, as one truncating meta line. */
function describe(secret: VaultSecret): string {
  return [
    // The ONE door for a domain token's noun — `api_key` → "API key",
    // `env_variable` → "Environment variable", and an unknown type humanizes
    // rather than leaking.
    resolveObjectNoun(secret.type),
    secret.category,
    `updated ${formatRelative(secret.updatedAt)}`,
    secret.lastAccessedAt
      ? `last used ${formatRelative(secret.lastAccessedAt)}`
      : "never used",
    secret.tags.length > 0 ? secret.tags.join(", ") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
