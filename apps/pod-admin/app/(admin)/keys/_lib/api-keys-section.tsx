"use client";

/**
 * Keys → the unified key list (no system/operator split).
 * Tabs: Active | Revoked. Each row carries a type badge (`categorize`, in
 * `key-model.ts`); revoked keys get a "Delete" action to remove the record.
 *
 * Procedures used:
 *   • trpc.apiKeys.adminListAll      — pod-admin, all keys
 *   • trpc.apiKeys.listSystemKeys    — pod-admin, system/hub-internal keys
 *   • trpc.apiKeys.create            — protectedProcedure (any user)
 *   • trpc.apiKeys.revoke            — keyId + reason
 *   • trpc.apiKeys.rotate            — keyId → new plaintext key (shown ONCE)
 *   • trpc.apiKeys.adminDeleteRevoked — permanent delete of revoked key
 */

import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Input,
  Tab,
  Tabs,
  addToast,
} from "@heroui/react";
import {
  Ban,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { ConfirmModal } from "../../components/confirm-modal";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import { useFocusRow } from "../../components/use-focus-row";
import { formatRelative, shortId } from "../../../../lib/format";
import {
  CATEGORY_LABEL,
  categorize,
  keyHref,
  holderName,
  keyStatus,
  normalizeScopes,
  type KeyCategory,
  type UnifiedKey,
} from "./key-model";
import { CreateKeyModal, RevealKeyModal } from "./key-modals";

export function ApiKeysSection() {
  const operatorKeys = trpc.apiKeys.adminListAll.useQuery(undefined, {
    staleTime: 30_000,
  });
  const systemKeys = trpc.apiKeys.listSystemKeys.useQuery(undefined, {
    staleTime: 60_000,
  });

  // Expired session → login, not a dead "couldn't load" error.
  useEffect(() => {
    const err = operatorKeys.error ?? systemKeys.error;
    if (operatorKeys.isError || systemKeys.isError) {
      redirectToLoginIfUnauthorized(err);
    }
  }, [
    operatorKeys.isError,
    operatorKeys.error,
    systemKeys.isError,
    systemKeys.error,
  ]);
  const isAuthRedirecting =
    operatorKeys.error?.data?.code === "UNAUTHORIZED" ||
    systemKeys.error?.data?.code === "UNAUTHORIZED";

  useFocusRow({
    ready: !operatorKeys.isLoading && !systemKeys.isLoading,
  });

  const utils = trpc.useUtils();

  const [tab, setTab] = useState<"active" | "revoked">("active");
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<UnifiedKey | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<UnifiedKey | null>(null);
  const [revealedKey, setRevealedKey] = useState<{
    keyName: string;
    plaintext: string;
    note: "created" | "rotated";
  } | null>(null);

  const create = trpc.apiKeys.create.useMutation({
    onSuccess: (res) => {
      void utils.apiKeys.adminListAll.invalidate();
      void utils.apiKeys.listSystemKeys.invalidate();
      if (res && "key" in res && typeof res.key === "string" && res.key) {
        setRevealedKey({
          keyName: "New key",
          plaintext: res.key,
          note: "created",
        });
      } else if (res && "proposalId" in res && res.proposalId) {
        addToast({
          title: "Approval required",
          description: "Key creation submitted as a proposal.",
          color: "default",
        });
      }
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Create failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const createSystem = trpc.apiKeys.createSystemKey.useMutation({
    onSuccess: (res: {
      key: string;
      id: string;
      keyPrefix: string;
      status: string;
      message: string;
    }) => {
      void utils.apiKeys.adminListAll.invalidate();
      void utils.apiKeys.listSystemKeys.invalidate();
      if (res.key) {
        setRevealedKey({
          keyName: "New system key",
          plaintext: res.key,
          note: "created",
        });
      }
    },
    onError: (err: { message: string }) =>
      addToast({
        title: "Create failed",
        description: err.message,
        color: "danger",
      }),
  });

  const revoke = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      void utils.apiKeys.adminListAll.invalidate();
      void utils.apiKeys.listSystemKeys.invalidate();
      addToast({ title: "Key revoked", color: "default" });
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Revoke failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const rotate = trpc.apiKeys.rotate.useMutation({
    onSuccess: (res) => {
      void utils.apiKeys.adminListAll.invalidate();
      void utils.apiKeys.listSystemKeys.invalidate();
      if (res && "key" in res && typeof res.key === "string" && res.key) {
        setRevealedKey({
          keyName: "Rotated key",
          plaintext: res.key,
          note: "rotated",
        });
      }
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Rotate failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const deleteRevoked = trpc.apiKeys.adminDeleteRevoked.useMutation({
    onSuccess: () => {
      void utils.apiKeys.adminListAll.invalidate();
      void utils.apiKeys.listSystemKeys.invalidate();
      addToast({ title: "Key deleted", color: "default" });
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Delete failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  // Merge both queries into a single de-duplicated list keyed by id.
  const allKeys = useMemo<UnifiedKey[]>(() => {
    const map = new Map<string, UnifiedKey>();
    for (const k of (operatorKeys.data as UnifiedKey[] | undefined) ?? []) {
      map.set(k.id, k);
    }
    for (const k of (systemKeys.data as UnifiedKey[] | undefined) ?? []) {
      if (!map.has(k.id)) map.set(k.id, k);
    }
    return Array.from(map.values()).sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  }, [operatorKeys.data, systemKeys.data]);

  const active = useMemo(() => allKeys.filter((k) => k.isActive), [allKeys]);
  const revoked = useMemo(() => allKeys.filter((k) => !k.isActive), [allKeys]);

  const isLoading =
    operatorKeys.isLoading || systemKeys.isLoading || isAuthRedirecting;
  const isError = operatorKeys.isError || systemKeys.isError;
  const shown = tab === "active" ? active : revoked;

  return (
    <div className="flex flex-col gap-5">
      <SectionCard
        title="API keys"
        hint="Hub Protocol, agent, and operator keys on this pod"
        actions={
          <Button
            size="sm"
            variant="flat"
            radius="md"
            color="primary"
            startContent={<Plus className="h-3.5 w-3.5" />}
            onPress={() => setCreateOpen(true)}
          >
            New key
          </Button>
        }
      >
        <div className="mb-3 -mt-1">
          <Tabs
            size="sm"
            selectedKey={tab}
            onSelectionChange={(k) => setTab(k as "active" | "revoked")}
            classNames={{
              tabList: "bg-foreground/[0.04] rounded-lg",
              tab: "text-[12px]",
            }}
          >
            <Tab
              key="active"
              title={
                <span className="flex items-center gap-1.5">
                  Active
                  {active.length > 0 && (
                    <span className="rounded-full bg-foreground/10 px-1.5 py-px text-[10px] font-medium">
                      {active.length}
                    </span>
                  )}
                </span>
              }
            />
            <Tab
              key="revoked"
              title={
                <span className="flex items-center gap-1.5">
                  Revoked
                  {revoked.length > 0 && (
                    <span className="rounded-full bg-foreground/10 px-1.5 py-px text-[10px] font-medium">
                      {revoked.length}
                    </span>
                  )}
                </span>
              }
            />
          </Tabs>
        </div>

        {isLoading ? (
          <ResourceRowSkeleton count={3} />
        ) : isError ? (
          <ResourceRowError
            message="Couldn't load API keys."
            onRetry={() => {
              void operatorKeys.refetch();
              void systemKeys.refetch();
            }}
          />
        ) : shown.length === 0 ? (
          <ResourceRowEmpty
            message={tab === "active" ? "No active keys." : "No revoked keys."}
          />
        ) : (
          <div className="-mx-2 divide-y divide-foreground/[0.05]">
            {shown.map((k) => (
              <div
                key={k.id}
                data-row-id={k.id}
                className="rounded-md transition-shadow"
              >
                <KeyRow
                  apiKey={k}
                  category={categorize(k)}
                  onRevoke={k.isActive ? () => setRevokeTarget(k) : undefined}
                  onRotate={
                    k.isActive && categorize(k) !== "system"
                      ? () => rotate.mutate({ keyId: k.id })
                      : undefined
                  }
                  onDelete={!k.isActive ? () => setDeleteTarget(k) : undefined}
                />
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {createOpen && (
        <CreateKeyModal
          isPending={create.isPending || createSystem.isPending}
          onClose={() => setCreateOpen(false)}
          onConfirm={async (input) => {
            if (input.kind === "system") {
              const res = await createSystem.mutateAsync({
                keyName: input.keyName,
                scope: input.scope,
                // A system key with no lifetime never expires.
                expiresInDays: input.expiresInDays ?? undefined,
              });
              if (res.key) {
                setRevealedKey({
                  keyName: input.keyName,
                  plaintext: res.key,
                  note: "created",
                });
              }
            } else if (input.grant) {
              const res = await create.mutateAsync({
                keyName: input.keyName,
                scope: input.scope,
                expiresInDays: input.expiresInDays,
                grant: input.grant,
              });
              if (
                res &&
                "key" in res &&
                typeof res.key === "string" &&
                res.key
              ) {
                setRevealedKey({
                  keyName: input.keyName,
                  plaintext: res.key,
                  note: "created",
                });
              }
            }
            setCreateOpen(false);
          }}
        />
      )}

      <ConfirmModal
        isOpen={revokeTarget !== null}
        onClose={() => {
          setRevokeTarget(null);
          setRevokeReason("");
        }}
        onConfirm={() => {
          if (!revokeTarget) return;
          revoke.mutate(
            {
              keyId: revokeTarget.id,
              reason: revokeReason.trim() || "Revoked by admin",
            },
            {
              onSuccess: () => {
                setRevokeTarget(null);
                setRevokeReason("");
              },
            }
          );
        }}
        title={`Revoke ${revokeTarget?.keyName ?? "key"}`}
        consequence="This key will stop working immediately. It cannot be reactivated."
        confirmLabel="Revoke"
        isPending={revoke.isPending}
      >
        <Input
          label="Reason (optional)"
          placeholder="e.g. compromised, no longer needed"
          value={revokeReason}
          onValueChange={setRevokeReason}
          size="sm"
        />
      </ConfirmModal>

      <ConfirmModal
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteRevoked.mutate(
            { keyId: deleteTarget.id },
            { onSuccess: () => setDeleteTarget(null) }
          );
        }}
        title={`Delete ${deleteTarget?.keyName ?? "key"}`}
        consequence="This permanently removes the key record. The key is already revoked and can no longer authenticate. This cannot be undone."
        confirmLabel="Delete permanently"
        isPending={deleteRevoked.isPending}
      />

      {revealedKey && (
        <RevealKeyModal
          keyName={revealedKey.keyName}
          plaintext={revealedKey.plaintext}
          note={revealedKey.note}
          onClose={() => setRevealedKey(null)}
        />
      )}
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

function KeyRow({
  apiKey,
  category,
  onRevoke,
  onRotate,
  onDelete,
}: {
  apiKey: UnifiedKey;
  category: KeyCategory;
  onRevoke?: () => void;
  onRotate?: () => void;
  onDelete?: () => void;
}) {
  const router = useRouter();
  // A computer's or app's key opens its holder's page (what holds it, what it
  // reaches, how to revoke it); a space key with neither opens its space.
  const holderPage = keyHref(apiKey);
  const status = keyStatus(apiKey);
  const scopes = normalizeScopes(apiKey.scope);
  const lastUsed = apiKey.lastUsedAt
    ? `last used ${formatRelative(apiKey.lastUsedAt)}`
    : "never used";
  const created = apiKey.createdAt
    ? `created ${formatRelative(apiKey.createdAt)}`
    : null;

  const secondary = [
    // Which app / computer / agent holds it — the badge says what it is.
    holderName(apiKey),
    apiKey.keyPrefix ? `${apiKey.keyPrefix}…` : shortId(apiKey.id),
    scopes.length > 0
      ? scopes.slice(0, 2).join(", ") +
        (scopes.length > 2 ? ` +${scopes.length - 2}` : "")
      : null,
    lastUsed,
    created,
  ]
    .filter(Boolean)
    .join(" · ");

  const hasActions = onRevoke || onRotate || onDelete;

  return (
    <ResourceRow
      Icon={KeyRound}
      primary={apiKey.keyName}
      secondary={`[${CATEGORY_LABEL[category]}] ${secondary}`}
      status={status}
      onSelect={holderPage ? () => router.push(holderPage) : undefined}
      actions={
        hasActions ? (
          <Dropdown>
            <DropdownTrigger>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                radius="full"
                aria-label="Key actions"
                className="text-foreground/55"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownTrigger>
            <DropdownMenu aria-label="Key actions">
              {onRotate ? (
                <DropdownItem
                  key="rotate"
                  startContent={<RefreshCw className="h-3.5 w-3.5" />}
                  onPress={onRotate}
                  description="Issue a new key, revoke this one"
                >
                  Rotate
                </DropdownItem>
              ) : null}
              {onRevoke ? (
                <DropdownItem
                  key="revoke"
                  color="danger"
                  startContent={<Ban className="h-3.5 w-3.5" />}
                  onPress={onRevoke}
                >
                  Revoke
                </DropdownItem>
              ) : null}
              {onDelete ? (
                <DropdownItem
                  key="delete"
                  color="danger"
                  startContent={<Trash2 className="h-3.5 w-3.5" />}
                  onPress={onDelete}
                  description="Permanently remove from records"
                >
                  Delete
                </DropdownItem>
              ) : null}
            </DropdownMenu>
          </Dropdown>
        ) : (
          <span className="px-2 text-[11px] text-foreground/45">read-only</span>
        )
      }
    />
  );
}
