"use client";

/**
 * /my-connections — self-service view of MY OWN Hub Protocol keys.
 *
 * Any signed-in pod member (not just pod_admin) can already mint their own
 * CLI/agent key at `/connect`, but had no UI to see or revoke it afterward —
 * `apiKeys.list` / `apiKeys.revoke` exist and are already self-scoped to
 * `ctx.userId` (a member sees and can only touch their own keys), they were
 * just rendered exclusively inside the admin-gated Trust & Keys page. This
 * page is the self-service counterpart: same self-scoped procedures, no
 * pod_admin role required (see the `/my-connections` exemption in proxy.ts).
 *
 * Badge derivation is shared with Trust & Keys — see `categorize()` in
 * `../(admin)/trust-keys/_lib/api-keys-section.tsx` — so "what type of
 * connection is this" never drifts between the two surfaces.
 */

import { useEffect, useState } from "react";
import { Button, Card, CardBody, Chip, Spinner, addToast } from "@heroui/react";
import { Ban, ChevronDown, Plug } from "lucide-react";
import { ConfirmModal } from "../(admin)/components/confirm-modal";
import { trpc } from "../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../lib/auth-redirect";
import {
  categorize,
  CATEGORY_LABEL,
  keyStatus,
  type UnifiedKey,
} from "../(admin)/trust-keys/_lib/api-keys-section";
import { formatRelative } from "../(admin)/trust-keys/_lib/format";

/** Human label for a key's `hubId` — mirrors ConnectForm's integration list. */
function connectionLabel(hubId: string | null | undefined): string {
  if (!hubId) return "Personal access token";
  if (hubId === "integration:cli") return "Synap CLI";
  if (hubId === "integration:raycast") return "Raycast";
  if (hubId === "integration:openclaw") return "OpenClaw";
  if (hubId === "integration:custom") return "Custom integration";
  if (hubId.startsWith("integration:"))
    return hubId.slice("integration:".length);
  return hubId;
}

export default function MyConnectionsPage() {
  const keys = trpc.apiKeys.list.useQuery();
  const utils = trpc.useUtils();
  const [showRevoked, setShowRevoked] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<UnifiedKey | null>(null);

  const revoke = trpc.apiKeys.revoke.useMutation({
    onSuccess: async (res) => {
      setPendingRevoke(null);
      await utils.apiKeys.list.invalidate();
      if ("proposalId" in res && res.proposalId) {
        addToast({
          title: "Approval required",
          description: "Revoke submitted as a proposal for review.",
          color: "default",
        });
      } else {
        addToast({ title: "Connection revoked", color: "default" });
      }
    },
    onError: (err) => {
      setPendingRevoke(null);
      addToast({
        title: "Couldn't revoke",
        description: err.message,
        color: "danger",
      });
    },
  });

  useEffect(() => {
    if (keys.isError) {
      redirectToLoginIfUnauthorized(keys.error);
    }
  }, [keys.isError, keys.error]);
  const isAuthRedirecting = keys.error?.data?.code === "UNAUTHORIZED";

  if (keys.isLoading || isAuthRedirecting) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner label="Loading your connections" />
      </div>
    );
  }
  if (keys.isError) {
    return (
      <div className="mx-auto max-w-[900px] px-6 py-6" role="alert">
        <p className="text-sm text-danger">
          Couldn&apos;t load your connections. Try again.
        </p>
        <Button
          size="sm"
          variant="flat"
          className="mt-3 min-h-10"
          isLoading={keys.isFetching}
          onPress={() => void keys.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  const all = (keys.data ?? []) as UnifiedKey[];
  const active = all.filter((k) => k.isActive);
  const revoked = all.filter((k) => !k.isActive);

  /* Was a native `window.confirm`. Same shared modal the admin surfaces use —
     revoking your own key is exactly as consequential as an admin revoking it,
     so it should not look like a cheaper decision. */
  function confirmRevoke(key: UnifiedKey) {
    setPendingRevoke(key);
  }

  return (
    <div className="mx-auto max-w-[900px] px-6 py-10">
      <header className="mb-6 max-w-2xl">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          My connections
        </h1>
        <p className="mt-1 text-[13px] leading-5 text-foreground/60">
          Keys you&apos;ve minted for CLI, agent, or personal access to this
          Pod. Revoking one here only affects you — it can&apos;t touch another
          member&apos;s keys.
        </p>
      </header>

      <section className="space-y-3" aria-labelledby="active-connections">
        <div className="flex items-center justify-between gap-3">
          <h2
            id="active-connections"
            className="text-sm font-medium text-foreground"
          >
            Active
          </h2>
          <span className="text-xs text-foreground/50">{active.length}</span>
        </div>
        {active.length === 0 ? (
          <EmptyState />
        ) : (
          active.map((key) => (
            <KeyCard
              key={key.id}
              apiKey={key}
              isRevoking={
                revoke.isPending && revoke.variables?.keyId === key.id
              }
              onRevoke={() => confirmRevoke(key)}
            />
          ))
        )}
      </section>

      {revoked.length > 0 ? (
        <section
          className="mt-9 space-y-3"
          aria-labelledby="revoked-connections"
        >
          <button
            type="button"
            onClick={() => setShowRevoked((v) => !v)}
            aria-expanded={showRevoked}
            className="flex w-full items-center justify-between gap-2 py-1 text-left"
          >
            <span
              id="revoked-connections"
              className="text-sm font-medium text-foreground/70"
            >
              Revoked
            </span>
            <span className="flex items-center gap-2 text-xs text-foreground/50">
              {revoked.length}
              <ChevronDown
                size={15}
                className={
                  showRevoked
                    ? "rotate-180 transition-transform"
                    : "transition-transform"
                }
              />
            </span>
          </button>
          {showRevoked ? (
            <div className="space-y-3">
              {revoked.map((key) => (
                <KeyCard key={key.id} apiKey={key} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <ConfirmModal
        isOpen={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        /* Deliberately does NOT close here. Closing in onConfirm unmounted the
           modal before the mutation resolved, so `isPending` could never
           render and the user got no sign the click landed on a network
           round-trip — on the one action the modal exists to slow down. The
           mutation's own onSuccess/onError closes it. */
        onConfirm={() => {
          if (!pendingRevoke) return;
          revoke.mutate({ keyId: pendingRevoke.id });
        }}
        title={`Revoke "${pendingRevoke?.keyName ?? "this key"}"?`}
        consequence={
          <>
            <p>Anything using this key loses access to this Pod.</p>
            <p className="mt-2 text-foreground/65">
              Depending on the key, revoking may need admin approval before it
              takes effect.
            </p>
          </>
        }
        confirmLabel="Revoke key"
        /* Scoped to THIS key — see connections/page.tsx for the cross-row
           staleness this prevents. */
        isPending={
          revoke.isPending && revoke.variables?.keyId === pendingRevoke?.id
        }
      />
    </div>
  );
}

function KeyCard({
  apiKey,
  isRevoking = false,
  onRevoke,
}: {
  apiKey: UnifiedKey;
  isRevoking?: boolean;
  onRevoke?: () => void;
}) {
  const category = categorize(apiKey);
  // Honest STATUS (Active / Expiring soon / Expired / Revoked) — separate from
  // the TYPE badge, so an expired key never reads as a green "active" one.
  const status = keyStatus(apiKey);
  const statusColor =
    status.kind === "healthy"
      ? "success"
      : status.kind === "stale"
        ? "warning"
        : "default";
  const meta = [
    apiKey.createdAt ? `created ${formatRelative(apiKey.createdAt)}` : null,
    apiKey.lastUsedAt
      ? `last used ${formatRelative(apiKey.lastUsedAt)}`
      : "never used",
    apiKey.isActive
      ? apiKey.expiresAt
        ? `expires ${formatRelative(apiKey.expiresAt)}`
        : "no expiry"
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card shadow="none" className="border border-foreground/10 bg-content1">
      <CardBody className="gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{apiKey.keyName}</p>
            <p className="mt-1 text-xs text-foreground/55">
              {connectionLabel(apiKey.hubId)} ·{" "}
              <span className="font-mono">{apiKey.keyPrefix}…</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Chip size="sm" variant="flat" color="default">
              {CATEGORY_LABEL[category]}
            </Chip>
            <Chip size="sm" variant="dot" color={statusColor}>
              {status.label}
            </Chip>
          </div>
        </div>

        <p className="text-xs text-foreground/55">{meta}</p>

        {onRevoke ? (
          <div className="pt-1">
            <Button
              color="danger"
              size="sm"
              className="min-h-10"
              variant="flat"
              startContent={<Ban size={14} />}
              isLoading={isRevoking}
              onPress={onRevoke}
            >
              Revoke
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-foreground/15 px-4 py-5">
      <div className="flex items-center gap-3 text-sm text-foreground/55">
        <Plug size={17} className="shrink-0" />
        You have no active connections yet.
      </div>
      <Button
        as="a"
        href="/connect"
        size="sm"
        variant="flat"
        className="min-h-10"
      >
        Connect an app
      </Button>
    </div>
  );
}
