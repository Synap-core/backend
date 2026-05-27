"use client";

/**
 * Connections tab — unified panel grouping all connections (API keys + webhooks)
 * by service name, with collapsible ServiceGroupCards.
 */

import { addToast, Button } from "@heroui/react";
import {
  ArrowDownToLine,
  Bot,
  ChevronDown,
  ChevronRight,
  Database,
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
import {
  ServiceGroupCard,
  type ServiceConnection,
  type ServiceGroup,
  type ConnectionType,
} from "./service-group-card";
import { AddConnectionModal } from "./add-connection-modal";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function normalizeScopes(s: string[] | string | null | undefined): string[] {
  if (!s) return [];
  if (Array.isArray(s)) return s;
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function inferType(scopes: string[]): ConnectionType {
  if (scopes.some((s) => s.startsWith("hub-protocol"))) return "hub-protocol";
  return "rest-api";
}

type RawApiKey = {
  id: string;
  keyName: string;
  keyType?: string | null;
  scope?: string[] | string | null;
  isActive: boolean;
};

type RawWebhookSub = {
  id: string;
  url: string;
  active: boolean;
  name?: string | null;
  eventTypes?: string[] | null;
};

function buildGroups(keys: RawApiKey[], subs: RawWebhookSub[]): ServiceGroup[] {
  const map = new Map<string, ServiceConnection[]>();

  for (const k of keys) {
    if (k.keyType !== "hub_inbound" && k.keyType !== "service") continue;
    if (!k.isActive) continue;
    const scopes = normalizeScopes(k.scope);
    const conn: ServiceConnection = {
      type: inferType(scopes),
      id: k.id,
      name: k.keyName,
      active: true,
      scopes,
    };
    const group = map.get(k.keyName) ?? [];
    group.push(conn);
    map.set(k.keyName, group);
  }

  for (const sub of subs) {
    const groupName = sub.name ?? sub.url;
    const conn: ServiceConnection = {
      type: "webhook-outbound",
      id: sub.id,
      name: groupName,
      active: sub.active,
      url: sub.url,
      events: sub.eventTypes ?? [],
    };
    const group = map.get(groupName) ?? [];
    group.push(conn);
    map.set(groupName, group);
  }

  return Array.from(map.entries()).map(([name, connections]) => ({
    name,
    connections,
  }));
}

// ─── Main component ────────────────────────────────────────────────────────────

export function ConnectionsTab({ workspaceId }: { workspaceId: string }) {
  const [addOpen, setAddOpen] = useState(false);
  const [defaultServiceName, setDefaultServiceName] = useState<
    string | undefined
  >(undefined);
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);

  const utils = trpc.useUtils();
  const keysQuery = trpc.apiKeys.adminListAll.useQuery(
    { workspaceId },
    { staleTime: 30_000 }
  );
  const subsQuery = trpc.integrations.adminListForWorkspace.useQuery(
    { workspaceId },
    { staleTime: 30_000 }
  );

  const isLoading = keysQuery.isLoading || subsQuery.isLoading;
  const isError = keysQuery.isError || subsQuery.isError;

  const groups = useMemo(
    () =>
      buildGroups(
        (keysQuery.data as RawApiKey[] | undefined) ?? [],
        (subsQuery.data as RawWebhookSub[] | undefined) ?? []
      ),
    [keysQuery.data, subsQuery.data]
  );

  const existingServiceNames = useMemo(
    () => groups.map((g) => g.name),
    [groups]
  );

  const revokeMutation = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      void utils.apiKeys.adminListAll.invalidate({ workspaceId });
      addToast({ title: "Connection revoked", color: "default" });
    },
    onError: (err) =>
      addToast({
        title: "Revoke failed",
        description: err.message,
        color: "danger",
      }),
  });

  const deleteMutation = trpc.integrations.adminDeleteForWorkspace.useMutation({
    onSuccess: () => {
      void utils.integrations.adminListForWorkspace.invalidate({ workspaceId });
      addToast({ title: "Subscription deleted", color: "default" });
    },
    onError: (err) =>
      addToast({
        title: "Delete failed",
        description: err.message,
        color: "danger",
      }),
  });

  const toggleMutation = trpc.integrations.adminToggleForWorkspace.useMutation({
    onSuccess: () =>
      void utils.integrations.adminListForWorkspace.invalidate({ workspaceId }),
    onError: (err) =>
      addToast({
        title: "Toggle failed",
        description: err.message,
        color: "danger",
      }),
  });

  function openAddForService(name: string) {
    setDefaultServiceName(name);
    setAddOpen(true);
  }

  function closeAdd() {
    setAddOpen(false);
    setDefaultServiceName(undefined);
    void utils.apiKeys.adminListAll.invalidate({ workspaceId });
    void utils.integrations.adminListForWorkspace.invalidate({ workspaceId });
  }

  return (
    <div className="flex flex-col gap-6">
      <SectionCard
        title="Connections"
        hint="External services and webhooks connected to this pod"
        actions={
          <Button
            size="sm"
            variant="flat"
            radius="md"
            color="primary"
            startContent={<Plus className="h-3.5 w-3.5" />}
            onPress={() => {
              setDefaultServiceName(undefined);
              setAddOpen(true);
            }}
          >
            Add connection
          </Button>
        }
      >
        {isLoading ? (
          <ResourceRowSkeleton count={2} />
        ) : isError ? (
          <ResourceRowError
            message="Couldn't load connections."
            onRetry={() => {
              void keysQuery.refetch();
              void subsQuery.refetch();
            }}
          />
        ) : groups.length === 0 ? (
          <ResourceRowEmpty message="No connections yet." />
        ) : (
          <div className="flex flex-col gap-2 pt-1">
            {groups.map((group) => (
              <ServiceGroupCard
                key={group.name}
                group={group}
                podUrl={POD_URL}
                onAddToService={() => openAddForService(group.name)}
                onRevoke={(id) =>
                  void revokeMutation.mutate({
                    keyId: id,
                    reason: "Revoked by admin",
                  })
                }
                onDelete={(id) =>
                  void deleteMutation.mutate({ id, workspaceId })
                }
                onToggle={(id, active) =>
                  void toggleMutation.mutate({ id, workspaceId, active })
                }
                isTogglingId={toggleMutation.isPending ? "any" : null}
              />
            ))}
          </div>
        )}
      </SectionCard>

      {/* How it works */}
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
            <HowItWorksRow
              icon={<Database className="h-4 w-4 text-foreground/50" />}
              title="REST API"
              description="Your backend calls Synap's entity/document API."
              endpoint={`${POD_URL}/trpc/{router}.{procedure}`}
              auth="Bearer token (API key)"
            />
            <HowItWorksRow
              icon={<Bot className="h-4 w-4 text-foreground/50" />}
              title="Hub Protocol"
              description="Your AI agent uses memory, proposals, and channel ops."
              endpoint={`${POD_URL}/api/hub/*`}
              auth="Bearer token (API key)"
            />
            <HowItWorksRow
              icon={<Webhook className="h-4 w-4 text-foreground/50" />}
              title="Webhook — Outbound"
              description="Synap notifies your endpoint when things change."
              endpoint="Your endpoint — Synap POSTs to it"
              auth="HMAC-SHA256 in x-synap-signature header"
            />
            <HowItWorksRow
              icon={<ArrowDownToLine className="h-4 w-4 text-foreground/50" />}
              title="Webhook — Inbound"
              description="Your service sends events into this pod."
              endpoint={`${POD_URL}/api/hub/*`}
              auth="Bearer token (API key)"
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

      {addOpen && (
        <AddConnectionModal
          workspaceId={workspaceId}
          existingServiceNames={existingServiceNames}
          defaultServiceName={defaultServiceName}
          onClose={closeAdd}
        />
      )}
    </div>
  );
}

// ─── HowItWorksRow ─────────────────────────────────────────────────────────────

function HowItWorksRow({
  icon,
  title,
  description,
  endpoint,
  auth,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
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
        <span className="text-[11.5px] text-foreground/55">{description}</span>
        <code className="font-mono text-[10.5px] text-foreground/40">
          {endpoint}
        </code>
        <span className="text-[11px] text-foreground/40">Auth: {auth}</span>
      </div>
    </div>
  );
}
