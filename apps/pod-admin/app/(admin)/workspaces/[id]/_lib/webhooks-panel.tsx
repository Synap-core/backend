"use client";

/**
 * Webhooks panel — Section A of the Connections tab.
 * Lists outbound webhook subscriptions for a workspace and allows
 * creating / toggling / deleting them via podAdminProcedure.
 *
 * Router key: trpc.integrations (webhooksRouter mounted at "integrations").
 */

import {
  addToast,
  Button,
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Switch,
  useDisclosure,
} from "@heroui/react";
import { Ban, Plus, Webhook } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../../../../lib/trpc";
import { SectionCard } from "../../../components/section-card";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../components/resource-row";

// ─── Event types ──────────────────────────────────────────────────────────────

export const WEBHOOK_EVENTS = [
  "entity.create.completed",
  "entity.update.completed",
  "entity.delete.completed",
  "proposal.created",
  "proposal.approved",
  "proposal.rejected",
  "channel.message.created",
  "notification.created",
  "workspace.member.added",
  "workspace.member.removed",
] as const;

// ─── Panel ────────────────────────────────────────────────────────────────────

export function WebhooksPanel({ workspaceId }: { workspaceId: string }) {
  const [addOpen, setAddOpen] = useState(false);

  const utils = trpc.useUtils();
  const query = trpc.integrations.adminListForWorkspace.useQuery(
    { workspaceId },
    { staleTime: 30_000 }
  );

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
    onSuccess: () => {
      void utils.integrations.adminListForWorkspace.invalidate({ workspaceId });
    },
    onError: (err) =>
      addToast({
        title: "Toggle failed",
        description: err.message,
        color: "danger",
      }),
  });

  const subs = query.data ?? [];

  return (
    <SectionCard
      title="Outbound webhooks"
      hint="Synap → your backend: POST events to external URLs"
      actions={
        <Button
          size="sm"
          variant="flat"
          radius="md"
          color="primary"
          startContent={<Plus className="h-3.5 w-3.5" />}
          onPress={() => setAddOpen(true)}
        >
          Add subscription
        </Button>
      }
    >
      {query.isLoading ? (
        <ResourceRowSkeleton count={2} />
      ) : query.isError ? (
        <ResourceRowError
          message="Couldn't load subscriptions."
          onRetry={() => void query.refetch()}
        />
      ) : subs.length === 0 ? (
        <ResourceRowEmpty message="No outbound webhook subscriptions yet." />
      ) : (
        <div className="flex flex-col divide-y divide-foreground/[0.05] pt-1">
          {subs.map((sub) => (
            <WebhookRow
              key={sub.id}
              sub={sub}
              onToggle={(active) =>
                void toggleMutation.mutate({ id: sub.id, workspaceId, active })
              }
              onDelete={() =>
                void deleteMutation.mutate({ id: sub.id, workspaceId })
              }
              isToggling={toggleMutation.isPending}
              isDeleting={deleteMutation.isPending}
            />
          ))}
        </div>
      )}

      {addOpen && (
        <AddWebhookModal
          workspaceId={workspaceId}
          onClose={() => {
            setAddOpen(false);
            void utils.integrations.adminListForWorkspace.invalidate({
              workspaceId,
            });
          }}
        />
      )}
    </SectionCard>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function WebhookRow({
  sub,
  onToggle,
  onDelete,
  isToggling,
  isDeleting,
}: {
  sub: WebhookSub;
  onToggle: (active: boolean) => void;
  onDelete: () => void;
  isToggling: boolean;
  isDeleting: boolean;
}) {
  const events = sub.eventTypes ?? [];
  const shown = events.slice(0, 3);
  const extra = events.length - shown.length;
  const displayUrl = sub.url.length > 55 ? sub.url.slice(0, 52) + "…" : sub.url;

  return (
    <div className="flex items-center gap-3 py-3 px-1">
      <Webhook className="h-4 w-4 shrink-0 text-foreground/40" aria-hidden />
      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className="text-[13px] font-medium text-foreground truncate">
          {sub.name || displayUrl}
        </span>
        <code className="font-mono text-[10.5px] text-foreground/45 truncate">
          {displayUrl}
        </code>
        <div className="flex flex-wrap gap-1 mt-0.5">
          {shown.map((e) => (
            <span
              key={e}
              className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] text-foreground/55"
            >
              {e}
            </span>
          ))}
          {extra > 0 && (
            <span className="text-[10px] text-foreground/40">
              +{extra} more
            </span>
          )}
        </div>
      </div>
      <Switch
        size="sm"
        isSelected={sub.active}
        isDisabled={isToggling}
        onValueChange={onToggle}
        aria-label={sub.active ? "Disable" : "Enable"}
      />
      <Button
        isIconOnly
        size="sm"
        variant="light"
        radius="full"
        aria-label="Delete subscription"
        className="shrink-0 text-foreground/40 hover:text-danger"
        isDisabled={isDeleting}
        onPress={onDelete}
      >
        <Ban className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ─── Add modal ────────────────────────────────────────────────────────────────

function AddWebhookModal({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>([]);

  const mutation = trpc.integrations.adminCreateForWorkspace.useMutation({
    onSuccess: () => {
      addToast({ title: "Subscription created", color: "success" });
      onClose();
    },
    onError: (err) =>
      addToast({
        title: "Create failed",
        description: err.message,
        color: "danger",
      }),
  });

  function toggleEvent(e: string) {
    setEvents((prev) =>
      prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]
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
            style={{ background: "rgba(99, 179, 237, 0.18)" }}
          >
            <Webhook className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="text-[15px] font-medium">
            Add webhook subscription
          </span>
        </ModalHeader>
        <ModalBody className="gap-4 px-6 py-4">
          <Input
            label="Endpoint URL"
            placeholder="https://example.com/webhook"
            value={url}
            onValueChange={setUrl}
            size="sm"
            isRequired
          />
          <Input
            label="Description"
            placeholder="e.g. n8n automation trigger"
            value={description}
            onValueChange={setDescription}
            size="sm"
          />
          <div className="flex flex-col gap-1.5">
            <p className="text-[12.5px] font-medium text-foreground">
              Events
              <span className="ml-1 text-[11px] font-normal text-foreground/45">
                (select at least one)
              </span>
            </p>
            <div className="rounded-lg ring-1 ring-inset ring-foreground/10 max-h-48 overflow-y-auto">
              {WEBHOOK_EVENTS.map((e) => (
                <label
                  key={e}
                  className="flex cursor-pointer items-center gap-2 border-b border-foreground/[0.05] px-3 py-2 last:border-0 hover:bg-content2/40"
                >
                  <Checkbox
                    size="sm"
                    isSelected={events.includes(e)}
                    onValueChange={() => toggleEvent(e)}
                  />
                  <span className="font-mono text-[11.5px] text-foreground/75">
                    {e}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </ModalBody>
        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          <Button variant="flat" radius="md" size="sm" onPress={onClose}>
            Cancel
          </Button>
          <Button
            color="primary"
            radius="md"
            size="sm"
            isDisabled={
              !url.trim() || events.length === 0 || mutation.isPending
            }
            isLoading={mutation.isPending}
            onPress={() =>
              void mutation.mutate({
                workspaceId,
                url: url.trim(),
                events,
                description: description.trim() || undefined,
              })
            }
          >
            Create subscription
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
