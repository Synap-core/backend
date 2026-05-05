"use client";

/**
 * Trust & Keys → API keys sub-tab.
 *
 * Procedures used:
 *   • trpc.apiKeys.adminListAll      — pod-admin, all operator keys
 *   • trpc.apiKeys.listSystemKeys    — pod-admin, system / hub-internal keys
 *   • trpc.apiKeys.create            — protectedProcedure (any user)
 *   • trpc.apiKeys.revoke            — keyId + reason
 *   • trpc.apiKeys.rotate            — keyId → new plaintext key (shown ONCE)
 *
 * Workspace-scoped keys (those whose owner has only workspace memberships
 * but no pod-admin scope) — the brief says they live in Studio.  We can't
 * tell that purely from the metadata returned, but we DO have `keyType`
 * (e.g. "operator", "integration", "system").  We exclude rows where the
 * key clearly looks workspace-bound — `hubId` starting with "workspace:".
 */

import {
  Button,
  Chip,
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
  Tooltip,
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

interface AdminKey {
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
}

interface SystemKey {
  id: string;
  keyName: string;
  keyPrefix: string;
  hubId?: string | null;
  scope?: string[] | string | null;
  isActive: boolean;
  expiresAt?: Date | string | null;
  lastUsedAt?: Date | string | null;
  usageCount?: number | null;
  createdAt?: Date | string | null;
  user?: { id: string; email: string | null; name: string | null };
}

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

  // ?focus=<keyId> from ⌘K — receiver wraps each KeyRow with data-row-id.
  useFocusRow({
    ready: !operatorKeys.isLoading && !systemKeys.isLoading,
  });

  const utils = trpc.useUtils();

  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AdminKey | null>(null);
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

  // Filter out workspace-bound keys per the brief.  hubId convention:
  //   • integration:<host>  → connector / integration key (operator-relevant)
  //   • workspace:<wsId>    → workspace-scoped (lives in Studio)
  //   • null                → personal key (operator-relevant)
  const operator = useMemo<AdminKey[]>(() => {
    const all = (operatorKeys.data as AdminKey[] | undefined) ?? [];
    return all.filter((k) => {
      if (k.hubId && k.hubId.startsWith("workspace:")) return false;
      if (k.workspaceId) return false;
      return true;
    });
  }, [operatorKeys.data]);

  const system = useMemo<SystemKey[]>(() => {
    const all = (systemKeys.data as SystemKey[] | undefined) ?? [];
    // System keys = those flagged with hub/integration prefix or marked
    // by hubId. We display all returned by listSystemKeys but de-duplicate
    // anything that's also in `operator`.  In practice listSystemKeys
    // returns ALL keys; we narrow it to keys that look system-internal.
    return all.filter((k) => {
      const isHub = k.hubId && !k.hubId.startsWith("integration:");
      const isInternalPrefix = k.keyPrefix?.startsWith("synap_hub_") ?? false;
      return Boolean(isHub) || isInternalPrefix;
    });
  }, [systemKeys.data]);

  return (
    <div className="flex flex-col gap-5">
      {/* System keys — read-only */}
      <SectionCard
        title="System keys"
        hint="Pod-internal Hub Protocol and system-service keys"
      >
        {systemKeys.isLoading ? (
          <ResourceRowSkeleton count={2} />
        ) : systemKeys.isError ? (
          <ResourceRowError
            message="Couldn't load system keys."
            onRetry={() => void systemKeys.refetch()}
          />
        ) : system.length === 0 ? (
          <ResourceRowEmpty message="No system keys present." />
        ) : (
          <div className="-mx-2">
            {system.map((k) => (
              <div
                key={k.id}
                data-row-id={k.id}
                className="rounded-md transition-shadow"
              >
                <KeyRow apiKey={toAdminLike(k)} readOnly />
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Operator keys — full CRUD */}
      <SectionCard
        title="Operator keys"
        hint="Keys created by pod admins for personal use and external integrations"
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
        {operatorKeys.isLoading ? (
          <ResourceRowSkeleton count={3} />
        ) : operatorKeys.isError ? (
          <ResourceRowError
            message="Couldn't load API keys."
            onRetry={() => void operatorKeys.refetch()}
          />
        ) : operator.length === 0 ? (
          <ResourceRowEmpty message="No operator keys yet." />
        ) : (
          <div className="-mx-2">
            {operator.map((k) => (
              <div
                key={k.id}
                data-row-id={k.id}
                className="rounded-md transition-shadow"
              >
                <KeyRow
                  apiKey={k}
                  onRevoke={() => setRevokeTarget(k)}
                  onRotate={() => rotate.mutate({ keyId: k.id })}
                />
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Create modal */}
      {createOpen && (
        <CreateKeyModal
          isPending={create.isPending}
          onClose={() => setCreateOpen(false)}
          onConfirm={async (input) => {
            const res = await create.mutateAsync(input);
            if (res && "key" in res && typeof res.key === "string" && res.key) {
              setRevealedKey({
                keyName: input.keyName,
                plaintext: res.key,
                note: "created",
              });
            }
            setCreateOpen(false);
          }}
        />
      )}

      {/* Revoke modal */}
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

      {/* One-time key reveal */}
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
  readOnly,
  onRevoke,
  onRotate,
}: {
  apiKey: AdminKey;
  readOnly?: boolean;
  onRevoke?: () => void;
  onRotate?: () => void;
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

  return (
    <ResourceRow
      Icon={KeyRound}
      primary={apiKey.keyName}
      secondary={secondary}
      status={status}
      actions={
        readOnly ? (
          <span className="px-2 text-[11px] text-foreground/45">read-only</span>
        ) : (
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
              {apiKey.isActive ? (
                <DropdownItem
                  key="rotate"
                  startContent={<RefreshCw className="h-3.5 w-3.5" />}
                  onPress={onRotate}
                  description="Issue a new key, revoke this one"
                >
                  Rotate
                </DropdownItem>
              ) : null}
              {apiKey.isActive ? (
                <DropdownItem
                  key="revoke"
                  color="danger"
                  startContent={<Ban className="h-3.5 w-3.5" />}
                  onPress={onRevoke}
                >
                  Revoke
                </DropdownItem>
              ) : null}
            </DropdownMenu>
          </Dropdown>
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
  // scope is sometimes stored as a comma-separated text column.
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function toAdminLike(k: SystemKey): AdminKey {
  return { ...k };
}

// ─── Create modal ─────────────────────────────────────────────────────────

function CreateKeyModal({
  isPending,
  onClose,
  onConfirm,
}: {
  isPending: boolean;
  onClose: () => void;
  onConfirm: (input: {
    keyName: string;
    scope: string[];
    expiresInDays?: number;
  }) => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["data.read"]);
  const [expiry, setExpiry] = useState<string>("90");

  function toggle(s: string) {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  }

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
        <ModalBody className="gap-3 pb-2">
          <Input
            label="Key name"
            placeholder="e.g. Raycast laptop"
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
  apiKey: AdminKey;
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

// Suppress unused warnings for icons referenced for visual symmetry.
void Copy;
void Eye;
void Tooltip;
