"use client";

/**
 * Connections tab — outbound webhooks + external connections.
 *
 * Section A — Outbound webhooks: manage webhook subscriptions directly.
 * Section B — External connections: hub_inbound API keys with pattern-based
 *             "Add connection" flow (REST API / Hub Protocol / Webhooks).
 * Section C — "How it works" collapsible reference panel.
 */

import {
  addToast,
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure,
} from "@heroui/react";
import {
  Ban,
  Bot,
  ChevronDown,
  ChevronRight,
  Database,
  KeyRound,
  Plus,
  Webhook,
} from "lucide-react";
import { useMemo, useState } from "react";
import { trpc, POD_URL } from "../../../../../lib/trpc";
import { SectionCard } from "../../../components/section-card";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../components/resource-row";
import { WebhooksPanel } from "./webhooks-panel";
import { AddConnectionModal } from "./add-connection-modal";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiKey {
  id: string;
  keyName: string;
  keyType?: string | null;
  scope?: string[] | string | null;
  isActive: boolean;
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

function patternBadge(scopes: string[]): string {
  if (scopes.some((s) => s.startsWith("hub-protocol"))) return "Hub Protocol";
  if (scopes.some((s) => s.startsWith("data"))) return "REST API";
  return "API Key";
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ConnectionsTab({ workspaceId }: { workspaceId: string }) {
  const [addOpen, setAddOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);

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

  const revokeMutation = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      void utils.apiKeys.adminListAll.invalidate({ workspaceId });
      addToast({ title: "Connection revoked", color: "default" });
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
      {/* Section A — Outbound webhooks */}
      <WebhooksPanel workspaceId={workspaceId} />

      {/* Section B — External connections */}
      <SectionCard
        title="External connections"
        hint="Services authorised to call this pod's API"
        actions={
          <Button
            size="sm"
            variant="flat"
            radius="md"
            color="primary"
            startContent={<Plus className="h-3.5 w-3.5" />}
            onPress={() => setAddOpen(true)}
          >
            Add connection
          </Button>
        }
      >
        {keysQuery.isLoading ? (
          <ResourceRowSkeleton count={2} />
        ) : keysQuery.isError ? (
          <ResourceRowError
            message="Couldn't load connections."
            onRetry={() => void keysQuery.refetch()}
          />
        ) : inboundKeys.length === 0 ? (
          <ResourceRowEmpty message="No external connections yet." />
        ) : (
          <div className="flex flex-col divide-y divide-foreground/[0.05] pt-1">
            {inboundKeys.map((k) => (
              <ConnectionRow
                key={k.id}
                apiKey={k}
                podUrl={POD_URL}
                onRevoke={() => setRevokeTarget(k)}
              />
            ))}
          </div>
        )}
      </SectionCard>

      {/* Section C — How it works */}
      <div className="rounded-xl ring-1 ring-inset ring-foreground/[0.08] bg-foreground/[0.01] overflow-hidden">
        <button
          type="button"
          onClick={() => setHowItWorksOpen((v) => !v)}
          className="flex w-full items-center justify-between px-5 py-3.5 text-left hover:bg-foreground/[0.02] transition-colors"
        >
          <span className="text-[13px] font-medium text-foreground">
            How it works
          </span>
          {howItWorksOpen ? (
            <ChevronDown className="h-4 w-4 text-foreground/40" />
          ) : (
            <ChevronRight className="h-4 w-4 text-foreground/40" />
          )}
        </button>
        {howItWorksOpen && (
          <div className="border-t border-foreground/[0.06] px-5 py-4 flex flex-col gap-4">
            <HowItWorksPattern
              icon={<Database className="h-4 w-4 text-foreground/50" />}
              title="REST API"
              when="Backend services that need direct read/write access to entities and documents."
              endpoint={`${POD_URL}/trpc/{router}.{procedure}`}
              auth="Bearer token (API key)"
            />
            <HowItWorksPattern
              icon={<Bot className="h-4 w-4 text-foreground/50" />}
              title="Hub Protocol"
              when="AI agents and services that use memory, proposals, and channel operations."
              endpoint={`${POD_URL}/api/hub/*`}
              auth="Bearer token (API key)"
            />
            <HowItWorksPattern
              icon={<Webhook className="h-4 w-4 text-foreground/50" />}
              title="Webhooks"
              when="Services that need to react to events in real-time (entity changes, proposals, messages)."
              endpoint="Your endpoint — Synap posts to it"
              auth="HMAC-SHA256 signature in x-synap-signature header"
            />
            <p className="text-[11.5px] text-foreground/45">
              Machine-readable capabilities:{" "}
              <code className="font-mono text-[11px]">
                {POD_URL}/api/integrations/capabilities
              </code>
            </p>
          </div>
        )}
      </div>

      {/* Add connection modal */}
      {addOpen && (
        <AddConnectionModal
          workspaceId={workspaceId}
          onClose={() => {
            setAddOpen(false);
            void utils.apiKeys.adminListAll.invalidate({ workspaceId });
          }}
        />
      )}

      {/* Revoke modal */}
      {revokeTarget && (
        <RevokeModal
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
      )}
    </div>
  );
}

// ─── Connection row ───────────────────────────────────────────────────────────

function ConnectionRow({
  apiKey,
  podUrl,
  onRevoke,
}: {
  apiKey: ApiKey;
  podUrl: string;
  onRevoke: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const scopes = normalizeScopes(apiKey.scope);
  const badge = patternBadge(scopes);
  const inboundUrl = `${podUrl}/api/webhooks/inbound/${apiKey.id}`;

  return (
    <div className="flex flex-col py-3 px-1">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <KeyRound
            className="h-4 w-4 shrink-0 text-foreground/40"
            aria-hidden
          />
          <div className="min-w-0 flex flex-col">
            <span className="text-[13px] font-medium text-foreground truncate">
              {apiKey.keyName}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center rounded-md bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-foreground/55">
            {badge}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] text-success">
            Active
          </span>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] text-foreground/40 hover:text-foreground transition-colors px-1"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            radius="full"
            aria-label="Revoke connection"
            className="text-foreground/40 hover:text-danger"
            onPress={onRevoke}
          >
            <Ban className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-2 ml-6 flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <p className="text-[11px] text-foreground/40 uppercase tracking-wider">
              Webhook inbound URL
            </p>
            <code className="font-mono text-[10.5px] bg-foreground/[0.02] border border-foreground/[0.06] rounded-md px-2 py-1 text-foreground/55 truncate block">
              {inboundUrl}
            </code>
          </div>
          {scopes.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {scopes.map((s) => (
                <span
                  key={s}
                  className="rounded-full bg-foreground/[0.06] px-2 py-0.5 font-mono text-[10px] text-foreground/55"
                >
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── How it works pattern row ─────────────────────────────────────────────────

function HowItWorksPattern({
  icon,
  title,
  when,
  endpoint,
  auth,
}: {
  icon: React.ReactNode;
  title: string;
  when: string;
  endpoint: string;
  auth: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="flex flex-col gap-0.5">
        <span className="text-[12.5px] font-medium text-foreground">
          {title}
        </span>
        <span className="text-[11.5px] text-foreground/55">{when}</span>
        <code className="font-mono text-[10.5px] text-foreground/40">
          {endpoint}
        </code>
        <span className="text-[11px] text-foreground/40">Auth: {auth}</span>
      </div>
    </div>
  );
}

// ─── Revoke modal ─────────────────────────────────────────────────────────────

function RevokeModal({
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
            This connection will stop accepting requests immediately. Your
            backend will need a new connection to call this pod.
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
