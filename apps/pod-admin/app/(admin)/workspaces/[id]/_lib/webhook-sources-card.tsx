"use client";

/**
 * Webhook sources — where an outside service (a GitHub org webhook, a form
 * tool, a CI) posts signed events INTO this space. Each source fires the
 * space's automations whose trigger listens to it (`webhookSource.name` in a
 * catalog automation binds to the source of that name).
 *
 * The secret is shown ONCE: when the source is created, and when it is
 * replaced (the old one stops at once). An automation or a package install
 * that creates a source never reveals its secret — this card is where a
 * person gets it (services/webhooks/inbound-source.ts).
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
} from "@heroui/react";
import { ArrowDownToLine, Plus } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../../../../lib/trpc";
import { SectionCard } from "../../../components/section-card";
import { ConfirmModal } from "../../../components/confirm-modal";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../components/resource-row";
import { LabeledSnippet, SaveOnceBanner } from "./connection-guides";

type Revealed = {
  name: string;
  inboundUrl: string | null;
  inboundPath: string;
  secret: string;
};

function lastReceived(at: string | Date | null): string {
  if (!at) return "Nothing received yet";
  return `Last received ${new Date(at).toLocaleString()}`;
}

export function WebhookSourcesCard({ workspaceId }: { workspaceId: string }) {
  const utils = trpc.useUtils();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [replacing, setReplacing] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(
    null
  );

  const sources = trpc.integrations.adminListInboundSources.useQuery(
    { workspaceId },
    { staleTime: 30_000 }
  );
  const refresh = () =>
    void utils.integrations.adminListInboundSources.invalidate({
      workspaceId,
    });
  const failed = (title: string) => (err: { message: string }) =>
    addToast({ title, description: err.message, color: "danger" });

  const create = trpc.integrations.adminCreateInboundSource.useMutation({
    onSuccess: (res) => {
      setCreateOpen(false);
      setName("");
      setRevealed({ ...res.source, secret: res.secret });
      refresh();
    },
    onError: failed("Create failed"),
  });
  const rotate = trpc.integrations.adminRotateInboundSourceSecret.useMutation({
    onSuccess: (res) => {
      setReplacing(null);
      setRevealed({ ...res.source, secret: res.secret });
      refresh();
    },
    onError: failed("Replace failed"),
  });
  const toggle = trpc.integrations.adminToggleForWorkspace.useMutation({
    onSuccess: refresh,
    onError: failed("Toggle failed"),
  });
  const remove = trpc.integrations.adminDeleteForWorkspace.useMutation({
    onSuccess: () => {
      setDeleting(null);
      refresh();
    },
    onError: failed("Delete failed"),
  });

  return (
    <>
      <SectionCard
        title="Webhook sources"
        hint="Outside services that post signed events into this space"
        actions={
          <Button
            size="sm"
            variant="flat"
            radius="md"
            color="primary"
            startContent={<Plus className="h-3.5 w-3.5" />}
            onPress={() => setCreateOpen(true)}
          >
            New source
          </Button>
        }
      >
        {sources.isLoading ? (
          <ResourceRowSkeleton count={1} />
        ) : sources.isError ? (
          <ResourceRowError
            message="Couldn't load webhook sources."
            onRetry={() => void sources.refetch()}
          />
        ) : (sources.data ?? []).length === 0 ? (
          <ResourceRowEmpty message="No webhook source yet. Create one, then paste its URL and secret into the service that sends." />
        ) : (
          <div className="flex flex-col divide-y divide-foreground/[0.05] pt-1">
            {(sources.data ?? []).map((s) => (
              <ResourceRow
                key={s.id}
                wrap
                Icon={ArrowDownToLine}
                primary={s.name}
                secondary={`${s.inboundUrl ?? s.inboundPath} · ${lastReceived(s.lastTriggeredAt)}`}
                status={
                  s.active ? undefined : { kind: "stale", label: "Paused" }
                }
                actions={
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="flat"
                      radius="md"
                      onPress={() =>
                        toggle.mutate({
                          id: s.id,
                          workspaceId,
                          active: !s.active,
                        })
                      }
                    >
                      {s.active ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      radius="md"
                      onPress={() => setReplacing({ id: s.id, name: s.name })}
                    >
                      Replace secret
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      radius="md"
                      color="danger"
                      onPress={() => setDeleting({ id: s.id, name: s.name })}
                    >
                      Delete
                    </Button>
                  </div>
                }
              />
            ))}
          </div>
        )}
      </SectionCard>

      <Modal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        size="md"
        placement="center"
        isDismissable={!create.isPending}
      >
        <ModalContent>
          <ModalHeader className="text-[15px] font-medium">
            New webhook source
          </ModalHeader>
          <ModalBody className="gap-3">
            <Input
              label="Name"
              placeholder="e.g. GitHub"
              description="An automation that listens to a source names it (a catalog automation binds by this name)."
              value={name}
              onValueChange={setName}
              size="sm"
              isRequired
            />
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              radius="md"
              size="sm"
              isDisabled={create.isPending}
              onPress={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              color="primary"
              radius="md"
              size="sm"
              isDisabled={!name.trim() || create.isPending}
              isLoading={create.isPending}
              onPress={() => create.mutate({ workspaceId, name: name.trim() })}
            >
              Create source
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={revealed !== null}
        onClose={() => setRevealed(null)}
        size="md"
        placement="center"
        isDismissable={false}
        hideCloseButton
      >
        <ModalContent>
          <ModalHeader className="text-[15px] font-medium">
            {revealed?.name}: copy the secret now
          </ModalHeader>
          <ModalBody className="gap-3">
            <SaveOnceBanner noun="secret" />
            {revealed && (
              <>
                <LabeledSnippet
                  label="Payload URL"
                  value={revealed.inboundUrl ?? revealed.inboundPath}
                />
                <LabeledSnippet label="Secret" value={revealed.secret} />
                <p className="text-[11.5px] text-foreground/65">
                  Send JSON (content type application/json). Sign the raw body
                  with HMAC-SHA256 and this secret, as sha256=&lt;hex&gt; in
                  X-Hub-Signature-256 (GitHub does this) or X-Synap-Signature.
                  The event name rides in X-GitHub-Event or X-Synap-Event.
                </p>
              </>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              color="primary"
              size="sm"
              radius="md"
              onPress={() => setRevealed(null)}
            >
              Done
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <ConfirmModal
        isOpen={replacing !== null}
        onClose={() => setReplacing(null)}
        onConfirm={() =>
          replacing && rotate.mutate({ id: replacing.id, workspaceId })
        }
        title={`Replace the secret of ${replacing?.name ?? "this source"}?`}
        consequence="The current secret stops working at once: events the service signs with it are refused until you paste the new one there. The new secret is shown once."
        confirmLabel="Replace secret"
        confirmColor="warning"
        isPending={rotate.isPending}
      />

      <ConfirmModal
        isOpen={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() =>
          deleting && remove.mutate({ id: deleting.id, workspaceId })
        }
        title={`Delete ${deleting?.name ?? "this source"}?`}
        consequence="Its URL stops answering and the automations that listen to it stop firing. Recreating a source with the same name gives a new URL and secret."
        confirmLabel="Delete source"
        isPending={remove.isPending}
      />
    </>
  );
}
