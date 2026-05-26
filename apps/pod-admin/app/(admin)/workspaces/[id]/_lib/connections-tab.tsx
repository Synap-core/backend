"use client";

/**
 * Connections tab — outbound webhooks + inbound API keys.
 *
 * Section A — Outbound: "Synap → your backend"
 *   Uses trpc.webhooks.list (protectedProcedure, workspace-header-scoped).
 *   Since pod-admin doesn't set X-Workspace-Id, we skip the list and show
 *   a Studio deep-link instead — outbound webhook management is workspace-
 *   member-gated and belongs in Studio.
 *
 * Section B — Inbound: "Your backend → Synap"
 *   Shows hub_inbound keys filtered from adminListAll.
 *   "Generate inbound key" creates one via trpc.apiKeys.create.
 */

import {
  addToast,
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Snippet,
  useDisclosure,
} from "@heroui/react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  ExternalLink,
  KeyRound,
  ShieldAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { trpc } from "../../../../../lib/trpc";
import { POD_URL } from "../../../../../lib/trpc";
import { SectionCard } from "../../../components/section-card";
import {
  ResourceRowEmpty,
  ResourceRowSkeleton,
  ResourceRowError,
} from "../../../components/resource-row";
import { studioDeepLinkForWorkspace } from "../../../people/_lib/helpers";

interface ApiKey {
  id: string;
  keyName: string;
  keyType?: string | null;
  isActive: boolean;
  createdAt?: Date | string | null;
}

export function ConnectionsTab({ workspaceId }: { workspaceId: string }) {
  const [createInboundOpen, setCreateInboundOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [revealedKey, setRevealedKey] = useState<{
    keyId: string;
    keyName: string;
    plaintext: string;
  } | null>(null);

  const utils = trpc.useUtils();
  const keysQuery = trpc.apiKeys.adminListAll.useQuery(
    { workspaceId },
    { staleTime: 30_000 }
  );

  const inboundKeys = useMemo(
    () =>
      ((keysQuery.data as ApiKey[] | undefined) ?? []).filter(
        (k) => k.keyType === "hub_inbound" && k.isActive
      ),
    [keysQuery.data]
  );

  const createMutation = trpc.apiKeys.create.useMutation({
    onSuccess: (res, variables) => {
      void utils.apiKeys.adminListAll.invalidate({ workspaceId });
      if (res && "key" in res && typeof res.key === "string" && res.key) {
        // We need the new key's id — use the id returned if available
        const newId =
          res && "id" in res && typeof res.id === "string" ? res.id : "new";
        setRevealedKey({
          keyId: newId,
          keyName: variables.keyName,
          plaintext: res.key,
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
    <div className="flex flex-col gap-6">
      {/* ── Section A: Outbound ───────────────────────────────────── */}
      <SectionCard
        title="Outbound webhooks"
        hint="Synap → your backend: POST events to external URLs"
        actions={
          <Button
            as="a"
            href={studioDeepLinkForWorkspace(workspaceId)}
            target="_blank"
            rel="noopener noreferrer"
            size="sm"
            variant="flat"
            radius="md"
            endContent={<ExternalLink className="h-3 w-3" />}
          >
            Manage in Studio
          </Button>
        }
      >
        <div className="flex items-start gap-3 rounded-md border border-foreground/[0.06] bg-foreground/[0.02] px-4 py-3 mt-1">
          <ArrowUpFromLine
            className="mt-0.5 h-4 w-4 shrink-0 text-foreground/40"
            aria-hidden
          />
          <div className="flex flex-col gap-1">
            <p className="text-[12.5px] font-medium text-foreground">
              Outbound webhooks are workspace-member-gated
            </p>
            <p className="text-[11.5px] text-foreground/55">
              Members manage subscriptions in Studio → Settings → Webhooks. Pod
              Admin doesn't hold workspace credentials, so the list is read from
              Studio.
            </p>
          </div>
        </div>
      </SectionCard>

      {/* ── Section B: Inbound ───────────────────────────────────── */}
      <SectionCard
        title="Inbound keys"
        hint="Your backend → Synap: keys for calling the Hub Protocol API"
        actions={
          <Button
            size="sm"
            variant="flat"
            radius="md"
            color="primary"
            startContent={<KeyRound className="h-3.5 w-3.5" />}
            onPress={() => setCreateInboundOpen(true)}
          >
            Generate inbound key
          </Button>
        }
      >
        {keysQuery.isLoading ? (
          <ResourceRowSkeleton count={2} />
        ) : keysQuery.isError ? (
          <ResourceRowError
            message="Couldn't load keys."
            onRetry={() => void keysQuery.refetch()}
          />
        ) : inboundKeys.length === 0 ? (
          <ResourceRowEmpty message="No inbound keys yet." />
        ) : (
          <div className="flex flex-col divide-y divide-foreground/[0.05] pt-1">
            {inboundKeys.map((k) => (
              <InboundKeyRow
                key={k.id}
                apiKey={k}
                podUrl={POD_URL}
                onRevoke={() => setRevokeTarget(k)}
              />
            ))}
          </div>
        )}

        {/* Info box */}
        <div className="mt-3 flex items-start gap-2 rounded-md border border-foreground/[0.06] bg-foreground/[0.02] px-3 py-2.5">
          <ArrowDownToLine
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/40"
            aria-hidden
          />
          <p className="text-[11.5px] text-foreground/55">
            Trusted issuers allow external services to call Synap using their
            own JWT tokens. Managed pod-wide →{" "}
            <a
              href="/trust-keys?section=issuers"
              className="text-primary underline underline-offset-2 hover:opacity-80"
            >
              Trust &amp; Keys → Issuers
            </a>
          </p>
        </div>
      </SectionCard>

      {createInboundOpen ? (
        <CreateInboundKeyModal
          isPending={createMutation.isPending}
          onClose={() => setCreateInboundOpen(false)}
          onConfirm={async (name) => {
            await createMutation.mutateAsync({
              keyName: name,
              keyType: "hub_inbound",
              workspaceId,
              scope: ["hub-protocol.read"],
            });
            setCreateInboundOpen(false);
          }}
        />
      ) : null}

      {revokeTarget ? (
        <RevokeInboundKeyModal
          apiKey={revokeTarget}
          isPending={revokeMutation.isPending}
          onClose={() => setRevokeTarget(null)}
          onConfirm={async () => {
            await revokeMutation.mutateAsync({
              keyId: revokeTarget.id,
              reason: "Revoked by admin",
            });
          }}
        />
      ) : null}

      {revealedKey ? (
        <RevealInboundKeyModal
          keyName={revealedKey.keyName}
          keyId={revealedKey.keyId}
          plaintext={revealedKey.plaintext}
          podUrl={POD_URL}
          onClose={() => setRevealedKey(null)}
        />
      ) : null}
    </div>
  );
}

// ─── Inbound key row ──────────────────────────────────────────────────

function InboundKeyRow({
  apiKey,
  podUrl,
  onRevoke,
}: {
  apiKey: ApiKey;
  podUrl: string;
  onRevoke: () => void;
}) {
  const webhookUrl = `${podUrl}/api/webhooks/inbound/${apiKey.id}`;

  return (
    <div className="flex flex-col gap-2 py-3 px-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-foreground">
          {apiKey.keyName}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-foreground/40">
            {apiKey.createdAt
              ? new Date(apiKey.createdAt).toLocaleDateString()
              : "—"}
          </span>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            radius="full"
            aria-label="Revoke inbound key"
            className="text-foreground/40 hover:text-status-down"
            onPress={onRevoke}
          >
            <Ban className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <code className="font-mono text-[10.5px] bg-foreground/[0.02] border border-foreground/[0.06] rounded-md px-2 py-1 text-foreground/70 truncate block">
        {webhookUrl}
      </code>
    </div>
  );
}

// ─── Create inbound key modal ─────────────────────────────────────────

function CreateInboundKeyModal({
  isPending,
  onClose,
  onConfirm,
}: {
  isPending: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });
  const [name, setName] = useState("");

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="sm"
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
          <span className="text-[15px] font-medium">Generate inbound key</span>
        </ModalHeader>
        <ModalBody className="gap-3 px-6 py-4">
          <p className="text-[12.5px] text-foreground/55">
            This key lets your backend POST events to Synap via the Hub Protocol
            inbound webhook. Save it once — it won't be shown again.
          </p>
          <Input
            label="Key name"
            placeholder="e.g. n8n integration"
            value={name}
            onValueChange={setName}
            size="sm"
            isDisabled={isPending}
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
            color="primary"
            radius="md"
            size="sm"
            isDisabled={!name.trim() || isPending}
            isLoading={isPending}
            onPress={() => void onConfirm(name.trim())}
          >
            Generate
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── Revoke inbound key modal ─────────────────────────────────────────

function RevokeInboundKeyModal({
  apiKey,
  isPending,
  onClose,
  onConfirm,
}: {
  apiKey: ApiKey;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="sm"
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
            Revoke {apiKey.keyName}?
          </span>
        </ModalHeader>
        <ModalBody className="px-6 py-4">
          <p className="text-[12.5px] text-foreground/85">
            This inbound key will stop accepting events immediately. Your
            backend will need a new key to post events.
          </p>
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
            onPress={() => void onConfirm()}
          >
            Revoke
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── Reveal modal ─────────────────────────────────────────────────────

function RevealInboundKeyModal({
  keyName,
  keyId,
  plaintext,
  podUrl,
  onClose,
}: {
  keyName: string;
  keyId: string;
  plaintext: string;
  podUrl: string;
  onClose: () => void;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });
  const webhookUrl = `${podUrl}/api/webhooks/inbound/${keyId}`;

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
        <ModalBody className="gap-4 px-6 py-4">
          <p className="text-[12.5px] text-foreground/85">
            Save <span className="font-medium">{keyName}</span> now — this is
            the only time it will be shown.
          </p>
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] uppercase tracking-wider text-foreground/45">
              Secret key
            </p>
            <Snippet
              symbol=""
              size="sm"
              className="overflow-hidden font-mono"
              classNames={{ base: "bg-foreground/[0.05]" }}
            >
              {plaintext}
            </Snippet>
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] uppercase tracking-wider text-foreground/45">
              Webhook URL
            </p>
            <code className="font-mono text-[10.5px] bg-foreground/[0.02] border border-foreground/[0.06] rounded-md px-2 py-1 text-foreground/70 block truncate">
              {webhookUrl}
            </code>
          </div>
          <p className="text-[11.5px] text-foreground/55">
            POST the key as a Bearer token in the{" "}
            <code className="font-mono">Authorization</code> header when calling
            the webhook URL.
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
