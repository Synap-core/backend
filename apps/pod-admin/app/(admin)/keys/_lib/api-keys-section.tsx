"use client";

/**
 * Keys → the unified key list (no system/operator split).
 * One toolbar row: search (name, prefix, holder, type, scopes, person), type,
 * status and order (`queryKeys`, in `key-model.ts`). Each row carries a type
 * badge (`categorize`); a row opens the key's panel (`KeyDrawer`: what it may
 * do, its use, what it did); revoked keys get a "Delete" action.
 *
 * Procedures used:
 *   • trpc.apiKeys.adminListAll      — pod-admin, all keys
 *   • trpc.apiKeys.listSystemKeys    — pod-admin, system/hub-internal keys
 *   (New key is a page, `/keys/new`; this list is its door.)
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
  Select,
  SelectItem,
  Textarea,
  addToast,
} from "@heroui/react";
import {
  Ban,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
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
  KEY_SORTS,
  KEY_STATUS_FILTERS,
  categorize,
  holderName,
  keyStatus,
  keyTypeCounts,
  normalizeScopes,
  queryKeys,
  type KeyCategory,
  type KeySort,
  type KeyStatusFilter,
  type UnifiedKey,
} from "./key-model";
import { KeyDrawer } from "./key-drawer";
import { RevealKeyModal } from "./key-modals";
import { newKeyHref } from "./key-form-model";

export function ApiKeysSection() {
  const router = useRouter();
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

  const [search, setSearch] = useState("");
  const [type, setType] = useState<KeyCategory | null>(null);
  const [status, setStatus] = useState<KeyStatusFilter>("live");
  const [sort, setSort] = useState<KeySort>("recent");
  const [opened, setOpened] = useState<UnifiedKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<UnifiedKey | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<UnifiedKey | null>(null);
  const [revealedKey, setRevealedKey] = useState<{
    keyName: string;
    plaintext: string;
    note: "created" | "rotated";
  } | null>(null);

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
    return Array.from(map.values());
  }, [operatorKeys.data, systemKeys.data]);

  const shown = useMemo(
    () => queryKeys(allKeys, { search, type, status }, sort),
    [allKeys, search, type, status, sort]
  );
  const typeCounts = useMemo(
    () => keyTypeCounts(allKeys, { search, status }),
    [allKeys, search, status]
  );
  const filtered = search.trim() !== "" || type !== null || status !== "live";

  const isLoading =
    operatorKeys.isLoading || systemKeys.isLoading || isAuthRedirecting;
  const isError = operatorKeys.isError || systemKeys.isError;

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
            onPress={() => router.push(newKeyHref())}
          >
            New key
          </Button>
        }
      >
        <div
          role="search"
          className="mb-3 -mt-1 flex flex-wrap items-center gap-2"
        >
          <Input
            aria-label="Search keys"
            placeholder="Search name, prefix, holder, scope…"
            value={search}
            onValueChange={setSearch}
            size="sm"
            radius="md"
            variant="flat"
            isClearable
            onClear={() => setSearch("")}
            startContent={<Search className="h-3.5 w-3.5 text-foreground/40" />}
            className="w-full sm:w-64"
          />
          <Select
            aria-label="Type"
            size="sm"
            radius="md"
            variant="flat"
            className="w-40"
            selectedKeys={[type ?? "all"]}
            disallowEmptySelection
            onSelectionChange={(keys) => {
              const v = Array.from(keys as Set<string>)[0];
              setType(!v || v === "all" ? null : (v as KeyCategory));
            }}
          >
            {[
              <SelectItem key="all">All types</SelectItem>,
              ...(Object.keys(CATEGORY_LABEL) as KeyCategory[]).map((c) => (
                <SelectItem
                  key={c}
                  textValue={CATEGORY_LABEL[c]}
                  endContent={
                    <span className="tabular text-[11px] text-foreground/60">
                      {typeCounts.get(c) ?? 0}
                    </span>
                  }
                >
                  {CATEGORY_LABEL[c]}
                </SelectItem>
              )),
            ]}
          </Select>
          <Select
            aria-label="Status"
            size="sm"
            radius="md"
            variant="flat"
            className="w-40"
            selectedKeys={[status]}
            disallowEmptySelection
            onSelectionChange={(keys) => {
              const v = Array.from(keys as Set<string>)[0];
              if (v) setStatus(v as KeyStatusFilter);
            }}
          >
            {KEY_STATUS_FILTERS.map((f) => (
              <SelectItem key={f.key}>{f.label}</SelectItem>
            ))}
          </Select>
          <Select
            aria-label="Order"
            size="sm"
            radius="md"
            variant="flat"
            className="w-40"
            selectedKeys={[sort]}
            disallowEmptySelection
            onSelectionChange={(keys) => {
              const v = Array.from(keys as Set<string>)[0];
              if (v) setSort(v as KeySort);
            }}
          >
            {KEY_SORTS.map((o) => (
              <SelectItem key={o.key}>{o.label}</SelectItem>
            ))}
          </Select>
          <span className="tabular ml-auto text-[11.5px] text-foreground/65">
            {shown.length} of {allKeys.length}
          </span>
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
            message={
              filtered ? "No key matches these filters." : "No active keys."
            }
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
                  onOpen={() => setOpened(k)}
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
        <Textarea
          minRows={1}
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

      <KeyDrawer apiKey={opened} onClose={() => setOpened(null)} />

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
  onOpen,
  onRevoke,
  onRotate,
  onDelete,
}: {
  apiKey: UnifiedKey;
  category: KeyCategory;
  /** Opens the key's panel; its holder's page is a link inside it. */
  onOpen: () => void;
  onRevoke?: () => void;
  onRotate?: () => void;
  onDelete?: () => void;
}) {
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
      onSelect={onOpen}
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
          <span className="px-2 text-[11px] text-foreground/65">read-only</span>
        )
      }
    />
  );
}
