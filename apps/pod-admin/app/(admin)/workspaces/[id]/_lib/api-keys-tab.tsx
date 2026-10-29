"use client";

/**
 * API Keys tab — the keys confined to this space
 * (`apiKeys.adminListAll({ workspaceId })` filters on the key's own space). A
 * member's pod-wide key can reach the space too, but it is not one of its
 * keys: it lives on the Keys page. "Create key" opens the New key page for
 * this space (`/keys/new?space=`), where the key is confined to it.
 */

import {
  addToast,
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
  useDisclosure,
} from "@heroui/react";
import { Ban, KeyRound, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { trpc } from "../../../../../lib/trpc";
import { SectionCard } from "../../../components/section-card";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../components/resource-row";
import { StatusPill } from "../../../components/status-pill";
import { useFocusRow } from "../../../components/use-focus-row";
import { newKeyHref } from "../../../keys/_lib/key-form-model";
import { formatRelative } from "../../../../../lib/format";

interface ApiKey {
  id: string;
  keyName: string;
  keyPrefix: string;
  keyType?: string | null;
  scope?: string[] | string | null;
  isActive: boolean;
  expiresAt?: Date | string | null;
  lastUsedAt?: Date | string | null;
  createdAt?: Date | string | null;
}

function normalizeScopes(s: string[] | string | null | undefined): string[] {
  if (!s) return [];
  if (Array.isArray(s)) return s;
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function keyStatus(k: ApiKey): {
  kind: "healthy" | "stale" | "down";
  label: string;
} {
  if (!k.isActive) return { kind: "down", label: "Revoked" };
  if (k.expiresAt) {
    const exp = new Date(k.expiresAt).getTime();
    if (exp < Date.now()) return { kind: "stale", label: "Expired" };
    if (exp - Date.now() < 7 * 24 * 60 * 60 * 1000)
      return { kind: "stale", label: "Expiring soon" };
  }
  return { kind: "healthy", label: "Active" };
}

function typeBadge(keyType: string | null | undefined): string {
  if (keyType === "hub_inbound") return "Inbound";
  if (keyType === "agent") return "Agent";
  if (keyType === "system") return "System";
  return "Operator";
}

export function ApiKeysTab({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  const utils = trpc.useUtils();
  const keysQuery = trpc.apiKeys.adminListAll.useQuery(
    { workspaceId },
    { staleTime: 30_000 }
  );

  const keys = useMemo(
    () => (keysQuery.data as ApiKey[] | undefined) ?? [],
    [keysQuery.data]
  );

  // ?focus=<keyId> — the receiver for a key confined to this space (Keys
  // rows and ⌘K open it here, `keyHref`). `data-row-id` is on each KeyRow.
  useFocusRow({ ready: !keysQuery.isLoading });
  const active = useMemo(() => keys.filter((k) => k.isActive), [keys]);
  const revoked = useMemo(() => keys.filter((k) => !k.isActive), [keys]);

  const revokeMutation = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      void utils.apiKeys.adminListAll.invalidate({ workspaceId });
      addToast({ title: "Key revoked", color: "default" });
      setRevokeTarget(null);
    },
    onError: (err) =>
      addToast({
        title: "Revoke failed",
        description: err.message,
        color: "danger",
      }),
  });

  return (
    <div className="flex flex-col gap-5">
      <SectionCard
        title="API keys"
        hint="Keys that can reach only this space. Members' pod-wide keys are on the Keys page."
        actions={
          <Button
            size="sm"
            variant="flat"
            radius="md"
            color="primary"
            startContent={<Plus className="h-3.5 w-3.5" />}
            onPress={() => router.push(newKeyHref({ space: workspaceId }))}
          >
            Create key
          </Button>
        }
      >
        {keysQuery.isLoading ? (
          <ResourceRowSkeleton count={3} />
        ) : keysQuery.isError ? (
          <ResourceRowError
            message="Couldn't load API keys."
            onRetry={() => void keysQuery.refetch()}
          />
        ) : keys.length === 0 ? (
          <ResourceRowEmpty message="No keys are confined to this space yet." />
        ) : (
          <div className="flex flex-col divide-y divide-foreground/[0.05] pt-1">
            {active.map((k) => (
              <KeyRow
                key={k.id}
                apiKey={k}
                onRevoke={() => setRevokeTarget(k)}
              />
            ))}
            {revoked.map((k) => (
              <KeyRow key={k.id} apiKey={k} />
            ))}
          </div>
        )}
      </SectionCard>

      {revokeTarget ? (
        <RevokeKeyModal
          apiKey={revokeTarget}
          isPending={revokeMutation.isPending}
          onClose={() => setRevokeTarget(null)}
          onConfirm={async (reason) => {
            await revokeMutation.mutateAsync({
              keyId: revokeTarget.id,
              reason,
            });
          }}
        />
      ) : null}
    </div>
  );
}

// ─── Key row ──────────────────────────────────────────────────────────

function KeyRow({
  apiKey,
  onRevoke,
}: {
  apiKey: ApiKey;
  onRevoke?: () => void;
}) {
  const status = keyStatus(apiKey);
  const scopes = normalizeScopes(apiKey.scope);

  return (
    <div
      data-row-id={apiKey.id}
      className="flex items-center gap-3 rounded-md py-3 px-1 transition-shadow"
    >
      <KeyRound
        className="h-4 w-4 shrink-0 text-foreground/40"
        strokeWidth={2}
        aria-hidden
      />

      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-foreground">
            {apiKey.keyName}
          </span>
          <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] text-foreground/65">
            {typeBadge(apiKey.keyType)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {scopes.slice(0, 3).map((s) => (
            <span
              key={s}
              className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] text-foreground/65"
            >
              {s}
            </span>
          ))}
          {scopes.length > 3 ? (
            <span className="text-[10.5px] text-foreground/65">
              +{scopes.length - 3} more
            </span>
          ) : null}
        </div>
        <span className="text-[11px] text-foreground/65">
          {apiKey.keyPrefix ? `${apiKey.keyPrefix}…` : ""} · last used{" "}
          {formatRelative(apiKey.lastUsedAt, { empty: "never" })} · created{" "}
          {formatRelative(apiKey.createdAt)}
        </span>
      </div>

      <StatusPill kind={status.kind} label={status.label} />

      {onRevoke ? (
        <Button
          isIconOnly
          size="sm"
          variant="light"
          radius="full"
          aria-label="Revoke key"
          className="shrink-0 text-foreground/40 hover:text-status-down"
          onPress={onRevoke}
        >
          <Ban className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <div className="h-8 w-8 shrink-0" />
      )}
    </div>
  );
}

// ─── Revoke modal ──────────────────────────────────────────────────────

function RevokeKeyModal({
  apiKey,
  isPending,
  onClose,
  onConfirm,
}: {
  apiKey: ApiKey;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });
  const [reason, setReason] = useState("");

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="md"
      placement="center"
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-2 border-b border-foreground/[0.06] px-6 py-4">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(248, 113, 113, 0.18)" }}
          >
            <Ban className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="text-[15px] font-medium">
            Revoke {apiKey.keyName}
          </span>
        </ModalHeader>
        <ModalBody className="gap-3 px-6 py-4">
          <p className="text-[12.5px] text-foreground/85">
            This key will stop working immediately. It cannot be reactivated.
          </p>
          <Textarea
            minRows={1}
            label="Reason (optional)"
            placeholder="e.g. no longer needed"
            value={reason}
            onValueChange={setReason}
            size="sm"
          />
        </ModalBody>
        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          <Button
            variant="flat"
            radius="md"
            size="sm"
            onPress={onClose}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            color="danger"
            radius="md"
            size="sm"
            isLoading={isPending}
            onPress={() => void onConfirm(reason.trim() || "Revoked by admin")}
          >
            Revoke
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
