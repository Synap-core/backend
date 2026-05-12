"use client";

/**
 * Trust & Keys → API keys sub-tab.
 *
 * Unified key list (no system/operator split).
 * Tabs: Active | Revoked
 * Each row has a type badge: Agent | Operator | System
 * Revoked keys get a "Delete" action to permanently remove them.
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
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Snippet,
  Tab,
  Tabs,
  addToast,
  useDisclosure,
} from "@heroui/react";
import {
  Ban,
  Copy,
  Eye,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import type { StatusKind } from "../../components/status-pill";
import { useFocusRow } from "../../components/use-focus-row";
import { formatRelative, shortId } from "./format";

interface UnifiedKey {
  id: string;
  userId?: string;
  keyName: string;
  keyPrefix: string;
  keyType?: string | null;
  hubId?: string | null;
  scope?: string[] | string | null;
  isActive: boolean;
  expiresAt?: Date | string | null;
  lastUsedAt?: Date | string | null;
  usageCount?: number | null;
  createdAt?: Date | string | null;
  workspaceId?: string | null;
  revokedAt?: Date | string | null;
  revokedReason?: string | null;
  user?: {
    id: string;
    email: string | null;
    name: string | null;
    userType?: string | null;
  };
}

type KeyCategory = "agent" | "system" | "operator";

function categorize(k: UnifiedKey): KeyCategory {
  if (k.user?.userType === "agent") return "agent";
  const isHub = k.hubId && !k.hubId.startsWith("integration:");
  const isInternalPrefix = k.keyPrefix?.startsWith("synap_hub_") ?? false;
  if (Boolean(isHub) || isInternalPrefix) return "system";
  return "operator";
}

const CATEGORY_LABEL: Record<KeyCategory, string> = {
  agent: "Agent",
  system: "System",
  operator: "Operator",
};

const COMMON_SCOPES = [
  "data.read",
  "data.write",
  "hub-protocol.read",
  "hub-protocol.write",
  "setup.agent",
  "sync",
];

export function ApiKeysSection() {
  const operatorKeys = trpc.apiKeys.adminListAll.useQuery(undefined, {
    staleTime: 30_000,
  });
  const systemKeys = trpc.apiKeys.listSystemKeys.useQuery(undefined, {
    staleTime: 60_000,
  });

  useFocusRow({
    ready: !operatorKeys.isLoading && !systemKeys.isLoading,
  });

  const utils = trpc.useUtils();

  const [tab, setTab] = useState<"active" | "revoked">("active");
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<UnifiedKey | null>(null);
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
    onError: (err) =>
      addToast({
        title: "Create failed",
        description: err.message,
        color: "danger",
      }),
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
    onError: (err) =>
      addToast({
        title: "Revoke failed",
        description: err.message,
        color: "danger",
      }),
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
    onError: (err) =>
      addToast({
        title: "Rotate failed",
        description: err.message,
        color: "danger",
      }),
  });

  const deleteRevoked = trpc.apiKeys.adminDeleteRevoked.useMutation({
    onSuccess: () => {
      void utils.apiKeys.adminListAll.invalidate();
      void utils.apiKeys.listSystemKeys.invalidate();
      addToast({ title: "Key deleted", color: "default" });
    },
    onError: (err) =>
      addToast({
        title: "Delete failed",
        description: err.message,
        color: "danger",
      }),
  });

  // Merge both queries into a single de-duplicated list keyed by id.
  const allKeys = useMemo<UnifiedKey[]>(() => {
    const map = new Map<string, UnifiedKey>();
    for (const k of (operatorKeys.data as UnifiedKey[] | undefined) ?? []) {
      if (k.hubId?.startsWith("workspace:") || k.workspaceId) continue;
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

  const isLoading = operatorKeys.isLoading || systemKeys.isLoading;
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
          <div className="-mx-2">
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
                expiresInDays: input.expiresInDays,
              });
              if (res.key) {
                setRevealedKey({
                  keyName: input.keyName,
                  plaintext: res.key,
                  note: "created",
                });
              }
            } else {
              const res = await create.mutateAsync({
                keyName: input.keyName,
                scope: input.scope,
                expiresInDays: input.expiresInDays,
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

      {revokeTarget && (
        <RevokeKeyModal
          apiKey={revokeTarget}
          isPending={revoke.isPending}
          onClose={() => setRevokeTarget(null)}
          onConfirm={async (reason) => {
            await revoke.mutateAsync({ keyId: revokeTarget.id, reason });
            setRevokeTarget(null);
          }}
        />
      )}

      {deleteTarget && (
        <DeleteKeyModal
          apiKey={deleteTarget}
          isPending={deleteRevoked.isPending}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            await deleteRevoked.mutateAsync({ keyId: deleteTarget.id });
            setDeleteTarget(null);
          }}
        />
      )}

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
  const status = keyStatus(apiKey);
  const scopes = normalizeScopes(apiKey.scope);
  const lastUsed = apiKey.lastUsedAt
    ? `last used ${formatRelative(apiKey.lastUsedAt)}`
    : "never used";
  const created = apiKey.createdAt
    ? `created ${formatRelative(apiKey.createdAt)}`
    : null;

  const secondary = [
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

function keyStatus(apiKey: {
  isActive: boolean;
  expiresAt?: Date | string | null;
}): { kind: StatusKind; label: string } {
  if (!apiKey.isActive) return { kind: "down", label: "Revoked" };
  if (apiKey.expiresAt) {
    const exp = new Date(apiKey.expiresAt).getTime();
    if (exp < Date.now()) return { kind: "stale", label: "Expired" };
    if (exp - Date.now() < 7 * 24 * 60 * 60 * 1000)
      return { kind: "stale", label: "Expiring soon" };
  }
  return { kind: "healthy", label: "Active" };
}

function normalizeScopes(s: string[] | string | null | undefined): string[] {
  if (!s) return [];
  if (Array.isArray(s)) return s;
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// ─── Create modal ─────────────────────────────────────────────────────────

type CreateKeyInput = {
  kind: "personal" | "system";
  keyName: string;
  scope: string[];
  expiresInDays?: number;
};

const SYSTEM_SCOPES = [
  "hub-protocol.read",
  "hub-protocol.write",
  "data.read",
  "data.write",
  "setup.agent",
  "sync",
];

function CreateKeyModal({
  isPending,
  onClose,
  onConfirm,
}: {
  isPending: boolean;
  onClose: () => void;
  onConfirm: (input: CreateKeyInput) => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });
  const [kind, setKind] = useState<"personal" | "system">("personal");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["data.read"]);
  const [expiry, setExpiry] = useState<string>("90");

  function toggle(s: string) {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  }

  const availableScopes = kind === "system" ? SYSTEM_SCOPES : COMMON_SCOPES;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(52, 211, 153, 0.18)" }}
          >
            <KeyRound className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="font-medium">New API key</span>
        </ModalHeader>
        <ModalBody className="gap-4 pb-2">
          {/* Key kind */}
          <div className="grid grid-cols-2 gap-2">
            {(["personal", "system"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setKind(k);
                  setScopes(
                    k === "system"
                      ? ["hub-protocol.read", "hub-protocol.write"]
                      : ["data.read"]
                  );
                }}
                className={[
                  "flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  kind === k
                    ? "border-primary/40 bg-primary/[0.07] ring-1 ring-inset ring-primary/30"
                    : "border-foreground/10 bg-foreground/[0.03] hover:bg-foreground/[0.06]",
                ].join(" ")}
              >
                <span className="text-[12.5px] font-medium text-foreground capitalize">
                  {k}
                </span>
                <span className="text-[11px] text-foreground/55">
                  {k === "personal"
                    ? "Your personal access token (synap_user_)"
                    : "For automation & scripts — CLI/Raycast use /admin/connect"}
                </span>
              </button>
            ))}
          </div>

          <Input
            label="Key name"
            placeholder={
              kind === "system" ? "e.g. n8n automation" : "e.g. Raycast laptop"
            }
            value={name}
            onValueChange={setName}
            size="sm"
            isRequired
          />
          <div>
            <p className="mb-1.5 text-[12.5px] font-medium text-foreground">
              Scopes
            </p>
            <div className="flex flex-wrap gap-1.5">
              {availableScopes.map((s) => {
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
          >
            <SelectItem key="never">Never</SelectItem>
            <SelectItem key="30">30 days</SelectItem>
            <SelectItem key="90">90 days</SelectItem>
            <SelectItem key="365">1 year</SelectItem>
          </Select>
        </ModalBody>
        <ModalFooter>
          <Button
            variant="light"
            size="sm"
            radius="md"
            onPress={onClose}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            color="primary"
            size="sm"
            radius="md"
            isDisabled={!name.trim() || scopes.length === 0 || isPending}
            isLoading={isPending}
            onPress={() =>
              void onConfirm({
                kind,
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

// ─── Revoke modal ─────────────────────────────────────────────────────────

function RevokeKeyModal({
  apiKey,
  isPending,
  onClose,
  onConfirm,
}: {
  apiKey: UnifiedKey;
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
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(248, 113, 113, 0.18)" }}
          >
            <Ban className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="font-medium">Revoke {apiKey.keyName}</span>
        </ModalHeader>
        <ModalBody className="gap-2 pb-2">
          <p className="text-[12.5px] text-foreground/85">
            This key will stop working immediately. It cannot be reactivated.
          </p>
          <Input
            label="Reason (optional)"
            placeholder="e.g. compromised, no longer needed"
            value={reason}
            onValueChange={setReason}
            size="sm"
          />
        </ModalBody>
        <ModalFooter>
          <Button
            variant="light"
            size="sm"
            radius="md"
            onPress={onClose}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            color="danger"
            size="sm"
            radius="md"
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

// ─── Delete modal ─────────────────────────────────────────────────────────

function DeleteKeyModal({
  apiKey,
  isPending,
  onClose,
  onConfirm,
}: {
  apiKey: UnifiedKey;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(248, 113, 113, 0.18)" }}
          >
            <Trash2 className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="font-medium">Delete {apiKey.keyName}</span>
        </ModalHeader>
        <ModalBody className="pb-2">
          <p className="text-[12.5px] text-foreground/85">
            This will permanently remove the key record. The key is already
            revoked and can no longer authenticate. This action cannot be
            undone.
          </p>
        </ModalBody>
        <ModalFooter>
          <Button
            variant="light"
            size="sm"
            radius="md"
            onPress={onClose}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            color="danger"
            size="sm"
            radius="md"
            isLoading={isPending}
            onPress={() => void onConfirm()}
          >
            Delete permanently
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── Reveal modal — shown ONCE on create / rotate ─────────────────────────

function RevealKeyModal({
  keyName,
  plaintext,
  note,
  onClose,
}: {
  keyName: string;
  plaintext: string;
  note: "created" | "rotated";
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
      isDismissable={false}
      hideCloseButton
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(245, 158, 11, 0.20)" }}
          >
            <ShieldAlert className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="font-medium">
            {note === "created" ? "Key created" : "Key rotated"}
          </span>
        </ModalHeader>
        <ModalBody className="gap-3 pb-2">
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
            Treat this like a password. Anyone with the key can act on this pod
            within its scopes.
          </p>
        </ModalBody>
        <ModalFooter>
          <Button color="primary" size="sm" radius="md" onPress={onClose}>
            I have saved it
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

void Copy;
void Eye;
