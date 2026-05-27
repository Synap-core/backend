"use client";

/**
 * ServiceGroupCard + ServiceConnectionRow + RevokeModal
 * Extracted from connections-tab.tsx to keep it under 500 lines.
 */

import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Switch,
  useDisclosure,
} from "@heroui/react";
import {
  ArrowDownToLine,
  Ban,
  Bot,
  ChevronDown,
  ChevronRight,
  Database,
  Plus,
  Webhook,
} from "lucide-react";
import { useState } from "react";

// ─── Types (re-exported so connections-tab can import them) ───────────────────

export type ConnectionType =
  | "rest-api"
  | "hub-protocol"
  | "webhook-inbound"
  | "webhook-outbound";

export interface ServiceConnection {
  type: ConnectionType;
  id: string;
  name: string;
  active: boolean;
  scopes?: string[];
  url?: string;
  events?: string[];
}

export interface ServiceGroup {
  name: string;
  connections: ServiceConnection[];
}

// ─── ServiceGroupCard ─────────────────────────────────────────────────────────

export function ServiceGroupCard({
  group,
  podUrl,
  onAddToService,
  onRevoke,
  onDelete,
  onToggle,
  isTogglingId,
}: {
  group: ServiceGroup;
  podUrl: string;
  onAddToService: () => void;
  onRevoke: (id: string) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string, active: boolean) => void;
  isTogglingId: string | null;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="rounded-xl ring-1 ring-inset ring-foreground/[0.08] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-foreground/[0.02] transition-colors"
      >
        <span className="flex-1 text-[13px] font-semibold text-foreground truncate">
          {group.name}
        </span>
        <span className="shrink-0 inline-flex items-center rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-foreground/55">
          {group.connections.length}{" "}
          {group.connections.length === 1 ? "connection" : "connections"}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground/35" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground/35" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-foreground/[0.06]">
          <div className="flex flex-col divide-y divide-foreground/[0.05]">
            {group.connections.map((conn) => (
              <ServiceConnectionRow
                key={conn.id}
                conn={conn}
                podUrl={podUrl}
                onRevoke={() => onRevoke(conn.id)}
                onDelete={() => onDelete(conn.id)}
                onToggle={(active) => onToggle(conn.id, active)}
                isToggling={isTogglingId !== null}
              />
            ))}
          </div>
          <div className="px-4 py-2.5 border-t border-foreground/[0.04]">
            <button
              type="button"
              onClick={onAddToService}
              className="flex items-center gap-1.5 text-[11.5px] text-foreground/45 hover:text-foreground/70 transition-colors"
            >
              <Plus className="h-3 w-3" />
              Add to this service
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ServiceConnectionRow ─────────────────────────────────────────────────────

const TYPE_META: Record<
  ConnectionType,
  { label: string; icon: React.ReactNode; color: string }
> = {
  "rest-api": {
    label: "REST API",
    icon: <Database className="h-3.5 w-3.5" />,
    color: "text-blue-400",
  },
  "hub-protocol": {
    label: "Hub Protocol",
    icon: <Bot className="h-3.5 w-3.5" />,
    color: "text-emerald-400",
  },
  "webhook-outbound": {
    label: "Webhook — Outbound",
    icon: <Webhook className="h-3.5 w-3.5" />,
    color: "text-violet-400",
  },
  "webhook-inbound": {
    label: "Webhook — Inbound",
    icon: <ArrowDownToLine className="h-3.5 w-3.5" />,
    color: "text-amber-400",
  },
};

function ServiceConnectionRow({
  conn,
  podUrl,
  onRevoke,
  onDelete,
  onToggle,
  isToggling,
}: {
  conn: ServiceConnection;
  podUrl: string;
  onRevoke: () => void;
  onDelete: () => void;
  onToggle: (active: boolean) => void;
  isToggling: boolean;
}) {
  const [revokeOpen, setRevokeOpen] = useState(false);
  const meta = TYPE_META[conn.type];

  const endpointUrl =
    conn.type === "hub-protocol" || conn.type === "webhook-inbound"
      ? `${podUrl}/api/hub`
      : conn.type === "webhook-outbound"
        ? (conn.url ?? "")
        : `${podUrl}/trpc`;

  const truncatedUrl =
    endpointUrl.length > 52 ? endpointUrl.slice(0, 49) + "…" : endpointUrl;

  const isWebhookOut = conn.type === "webhook-outbound";

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className={`shrink-0 ${meta.color}`}>{meta.icon}</span>

      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className="text-[12.5px] font-medium text-foreground">
          {meta.label}
        </span>
        <code className="font-mono text-[10px] text-foreground/40 truncate">
          {truncatedUrl}
        </code>
        {isWebhookOut && conn.events && conn.events.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {conn.events.slice(0, 3).map((e) => (
              <span
                key={e}
                className="rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[9.5px] text-foreground/50"
              >
                {e}
              </span>
            ))}
            {conn.events.length > 3 && (
              <span className="text-[9.5px] text-foreground/35">
                +{conn.events.length - 3} more
              </span>
            )}
          </div>
        )}
      </div>

      {isWebhookOut ? (
        <Switch
          size="sm"
          isSelected={conn.active}
          isDisabled={isToggling}
          onValueChange={onToggle}
          aria-label={conn.active ? "Disable" : "Enable"}
        />
      ) : (
        <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10.5px] text-success">
          Active
        </span>
      )}

      {isWebhookOut ? (
        <Button
          isIconOnly
          size="sm"
          variant="light"
          radius="full"
          aria-label="Delete subscription"
          className="shrink-0 text-foreground/40 hover:text-danger"
          onPress={onDelete}
        >
          <Ban className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            radius="full"
            aria-label="Revoke connection"
            className="shrink-0 text-foreground/40 hover:text-danger"
            onPress={() => setRevokeOpen(true)}
          >
            <Ban className="h-3.5 w-3.5" />
          </Button>
          {revokeOpen && (
            <RevokeModal
              name={conn.name}
              onClose={() => setRevokeOpen(false)}
              onConfirm={() => {
                onRevoke();
                setRevokeOpen(false);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

// ─── RevokeModal ──────────────────────────────────────────────────────────────

function RevokeModal({
  name,
  onClose,
  onConfirm,
}: {
  name: string;
  onClose: () => void;
  onConfirm: () => void;
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
          <span className="text-[15px] font-medium">Revoke connection?</span>
        </ModalHeader>
        <ModalBody className="px-6 py-4">
          <p className="text-[12.5px] text-foreground/85">
            <strong>{name}</strong> will stop accepting requests immediately.
          </p>
        </ModalBody>
        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          <Button variant="flat" radius="md" size="sm" onPress={onClose}>
            Cancel
          </Button>
          <Button color="danger" radius="md" size="sm" onPress={onConfirm}>
            Revoke
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
