"use client";

/**
 * API Keys tab — workspace-scoped keys.
 * Uses trpc.apiKeys.adminListAll filtered by workspaceId.
 */

import {
  addToast,
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Input,
  Select,
  SelectItem,
  Snippet,
  useDisclosure,
} from "@heroui/react";
import { Ban, KeyRound, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { trpc } from "../../../../../lib/trpc";
import { SectionCard } from "../../../components/section-card";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../components/resource-row";
import { StatusPill } from "../../../components/status-pill";

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
  workspaceId?: string | null;
}

function normalizeScopes(s: string[] | string | null | undefined): string[] {
  if (!s) return [];
  if (Array.isArray(s)) return s;
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function formatRelTime(d: Date | string | null | undefined): string {
  if (!d) return "never";
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
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

const COMMON_SCOPES = [
  "data.read",
  "data.write",
  "hub-protocol.read",
  "hub-protocol.write",
  "setup.agent",
  "sync",
];

export function ApiKeysTab({ workspaceId }: { workspaceId: string }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [revealedKey, setRevealedKey] = useState<{
    keyName: string;
    plaintext: string;
  } | null>(null);

  const utils = trpc.useUtils();
  const keysQuery = trpc.apiKeys.adminListAll.useQuery(
    { workspaceId },
    { staleTime: 30_000 }
  );

  const keys = useMemo(
    () => (keysQuery.data as ApiKey[] | undefined) ?? [],
    [keysQuery.data]
  );
  const active = useMemo(() => keys.filter((k) => k.isActive), [keys]);
  const revoked = useMemo(() => keys.filter((k) => !k.isActive), [keys]);

  const createMutation = trpc.apiKeys.create.useMutation({
    onSuccess: (res) => {
      void utils.apiKeys.adminListAll.invalidate({ workspaceId });
      if (res && "key" in res && typeof res.key === "string" && res.key) {
        setRevealedKey({ keyName: "New key", plaintext: res.key });
      }
    },
    onError: (err) =>
      addToast({
        title: "Create failed",
        description: err.message,
        color: "danger",
      }),
  });

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
        hint="Keys scoped to this workspace"
        actions={
          <Button
            size="sm"
            variant="flat"
            radius="md"
            color="primary"
            startContent={<Plus className="h-3.5 w-3.5" />}
            onPress={() => setCreateOpen(true)}
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
          <ResourceRowEmpty message="No keys for this workspace." />
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

      {createOpen ? (
        <CreateKeyModal
          workspaceId={workspaceId}
          isPending={createMutation.isPending}
          onClose={() => setCreateOpen(false)}
          onConfirm={async (input) => {
            const res = await createMutation.mutateAsync({
              keyName: input.keyName,
              scope: input.scope,
              workspaceId,
              expiresInDays: input.expiresInDays,
            });
            if (res && "key" in res && typeof res.key === "string" && res.key) {
              setRevealedKey({ keyName: input.keyName, plaintext: res.key });
            }
            setCreateOpen(false);
          }}
        />
      ) : null}

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

      {revealedKey ? (
        <RevealKeyModal
          keyName={revealedKey.keyName}
          plaintext={revealedKey.plaintext}
          onClose={() => setRevealedKey(null)}
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
    <div className="flex items-center gap-3 py-3 px-1">
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
          <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] text-foreground/55">
            {typeBadge(apiKey.keyType)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {scopes.slice(0, 3).map((s) => (
            <span
              key={s}
              className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] text-foreground/55"
            >
              {s}
            </span>
          ))}
          {scopes.length > 3 ? (
            <span className="text-[10.5px] text-foreground/40">
              +{scopes.length - 3} more
            </span>
          ) : null}
        </div>
        <span className="text-[11px] text-foreground/40">
          {apiKey.keyPrefix ? `${apiKey.keyPrefix}…` : ""} · last used{" "}
          {formatRelTime(apiKey.lastUsedAt)} · created{" "}
          {apiKey.createdAt
            ? new Date(apiKey.createdAt).toLocaleDateString()
            : "—"}
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

// ─── Create modal ──────────────────────────────────────────────────────

type CreateInput = { keyName: string; scope: string[]; expiresInDays?: number };

function CreateKeyModal({
  workspaceId: _workspaceId,
  isPending,
  onClose,
  onConfirm,
}: {
  workspaceId: string;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (input: CreateInput) => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["data.read"]);
  const [expiry, setExpiry] = useState("90");

  function toggle(s: string) {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  }

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
            style={{ background: "rgba(52, 211, 153, 0.18)" }}
          >
            <KeyRound className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="text-[15px] font-medium">New API key</span>
        </ModalHeader>
        <ModalBody className="gap-4 px-6 py-4">
          <Input
            label="Key name"
            placeholder="e.g. My integration"
            value={name}
            onValueChange={setName}
            size="sm"
            isDisabled={isPending}
          />
          <div>
            <p className="mb-1.5 text-[12.5px] font-medium text-foreground">
              Scopes
            </p>
            <div className="flex flex-wrap gap-1.5">
              {COMMON_SCOPES.map((s) => {
                const active = scopes.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggle(s)}
                    className={[
                      "rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors",
                      active
                        ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/40"
                        : "bg-foreground/[0.05] text-foreground/65 hover:bg-foreground/[0.08]",
                    ].join(" ")}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>
          <Select
            label="Expires in"
            size="sm"
            selectedKeys={[expiry]}
            onSelectionChange={(keys) => {
              const k = Array.from(keys as Set<string>)[0];
              if (k) setExpiry(k);
            }}
            isDisabled={isPending}
          >
            <SelectItem key="never">Never</SelectItem>
            <SelectItem key="30">30 days</SelectItem>
            <SelectItem key="90">90 days</SelectItem>
            <SelectItem key="365">1 year</SelectItem>
          </Select>
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
            color="primary"
            radius="md"
            size="sm"
            isDisabled={!name.trim() || scopes.length === 0 || isPending}
            isLoading={isPending}
            onPress={() =>
              void onConfirm({
                keyName: name.trim(),
                scope: scopes,
                expiresInDays: expiry === "never" ? undefined : Number(expiry),
              })
            }
          >
            Create
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
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
          <Input
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

// ─── Reveal modal ──────────────────────────────────────────────────────

function RevealKeyModal({
  keyName,
  plaintext,
  onClose,
}: {
  keyName: string;
  plaintext: string;
  onClose: () => void;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="md"
      placement="center"
      isDismissable={false}
      hideCloseButton
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-2 border-b border-foreground/[0.06] px-6 py-4">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(245, 158, 11, 0.20)" }}
          >
            <ShieldAlert className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="text-[15px] font-medium">Key created</span>
        </ModalHeader>
        <ModalBody className="gap-3 px-6 py-4">
          <p className="text-[12.5px] text-foreground/85">
            Save <span className="font-medium">{keyName}</span> now — this is
            the only time it will be shown.
          </p>
          <Snippet
            symbol=""
            size="sm"
            className="overflow-hidden font-mono"
            classNames={{ base: "bg-foreground/[0.05]" }}
          >
            {plaintext}
          </Snippet>
          <p className="text-[11.5px] text-foreground/55">
            Treat this like a password. Anyone with the key can act on this
            workspace within its scopes.
          </p>
        </ModalBody>
        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          <Button color="primary" size="sm" radius="md" onPress={onClose}>
            I have saved it
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

void Trash2;
