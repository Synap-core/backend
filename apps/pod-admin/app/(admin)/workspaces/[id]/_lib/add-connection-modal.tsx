"use client";

/**
 * Add connection modal.
 *
 * Step 1 — Service name + pattern (REST API | Hub Protocol | Webhook Outbound | Webhook Inbound)
 * A key pattern then opens the New key page for a service key in this space
 * (`/keys/new?space=&holder=service`): the one page a key is made on, where
 * its doors come from where it is used (never a raw scope list) and its
 * access is chosen, not always Full access.
 * Webhook Outbound stays here: Step 2 (its fields), Step 3 (its guide).
 */

import {
  addToast,
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { ArrowDownToLine, Bot, Database, Webhook } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DEV_LOOP_POSTER_TEMPLATE_ID } from "@synap-core/types/grants";
import { trpc } from "../../../../../lib/trpc";
import { newKeyHref } from "../../../keys/_lib/key-form-model";
import { WebhookGuide, type CreatedWebhook } from "./connection-guides";
import {
  Step1Pattern,
  Step2WebhookOutbound,
  type Pattern,
} from "./connection-modal-steps";

// ─── Constants ─────────────────────────────────────────────────────────────────

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

/**
 * The New key page for a key pattern: a service key in this space, named
 * after the service. An inbound webhook only posts what happened, so it
 * starts from the Dev loop poster template; the others start from the
 * service default (Full access, shown in red, narrowed on the page).
 */
export function connectionKeyHref(
  pattern: Exclude<Pattern, "webhook-outbound">,
  workspaceId: string,
  serviceName: string
): string {
  return newKeyHref({
    space: workspaceId,
    holder: "service",
    name: serviceName.trim(),
    ...(pattern === "webhook-inbound"
      ? { template: DEV_LOOP_POSTER_TEMPLATE_ID }
      : {}),
  });
}

// ─── Modal ─────────────────────────────────────────────────────────────────────

type Step = "pattern" | "configure" | "guide";

export function AddConnectionModal({
  workspaceId,
  existingServiceNames,
  defaultServiceName,
  onClose,
}: {
  workspaceId: string;
  existingServiceNames: string[];
  defaultServiceName?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("pattern");
  const [pattern, setPattern] = useState<Pattern>("rest-api");
  const [serviceName, setServiceName] = useState(defaultServiceName ?? "");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookDesc, setWebhookDesc] = useState("");
  const [webhookEvents, setWebhookEvents] = useState<string[]>([]);
  const [createdWebhook, setCreatedWebhook] = useState<CreatedWebhook | null>(
    null
  );

  const isGuide = step === "guide";

  const createWebhookMutation =
    trpc.integrations.adminCreateForWorkspace.useMutation({
      onError: (err) =>
        addToast({
          title: "Create failed",
          description: err.message,
          color: "danger",
        }),
    });

  const isPending = createWebhookMutation.isPending;

  async function handleConfigure() {
    const res = await createWebhookMutation.mutateAsync({
      workspaceId,
      url: webhookUrl.trim(),
      events: webhookEvents,
      description: serviceName.trim() || undefined,
    });
    if (res) {
      setCreatedWebhook({
        url: webhookUrl.trim(),
        events: webhookEvents,
        secret: "secret" in res ? String(res.secret) : "",
      });
      setStep("guide");
    }
  }

  function handleNext() {
    if (pattern === "webhook-outbound") {
      setStep("configure");
      return;
    }
    onClose();
    router.push(connectionKeyHref(pattern, workspaceId, serviceName));
  }

  const step2Valid = webhookUrl.trim().length > 0 && webhookEvents.length > 0;

  const patternLabel: Record<Pattern, string> = {
    "rest-api": "REST API",
    "hub-protocol": "Hub Protocol",
    "webhook-outbound": "Webhook — Outbound",
    "webhook-inbound": "Webhook — Inbound",
  };

  const modalTitle =
    step === "pattern"
      ? "Add connection"
      : step === "configure"
        ? `Connect — ${patternLabel[pattern]}`
        : "Subscription created";

  const headerBg: Record<Pattern, string> = {
    "rest-api": "rgba(99, 179, 237, 0.18)",
    "hub-protocol": "rgba(52, 211, 153, 0.18)",
    "webhook-outbound": "rgba(167, 139, 250, 0.18)",
    "webhook-inbound": "rgba(251, 191, 36, 0.18)",
  };

  const headerIcon: Record<Pattern, React.ReactNode> = {
    "rest-api": <Database className="h-3.5 w-3.5 text-foreground/85" />,
    "hub-protocol": <Bot className="h-3.5 w-3.5 text-foreground/85" />,
    "webhook-outbound": <Webhook className="h-3.5 w-3.5 text-foreground/85" />,
    "webhook-inbound": (
      <ArrowDownToLine className="h-3.5 w-3.5 text-foreground/85" />
    ),
  };

  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open && !isGuide) onClose();
      }}
      size="md"
      placement="center"
      isDismissable={!isGuide}
      hideCloseButton={isGuide}
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-2 border-b border-foreground/[0.06] px-6 py-4">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: headerBg[pattern] }}
          >
            {headerIcon[pattern]}
          </span>
          <span className="text-[15px] font-medium">{modalTitle}</span>
        </ModalHeader>

        <ModalBody className="gap-4 px-6 py-4">
          {step === "pattern" && (
            <Step1Pattern
              serviceName={serviceName}
              onServiceName={setServiceName}
              pattern={pattern}
              onPattern={setPattern}
              existingServiceNames={existingServiceNames}
            />
          )}
          {step === "configure" && pattern === "webhook-outbound" && (
            <Step2WebhookOutbound
              url={webhookUrl}
              onUrl={setWebhookUrl}
              description={webhookDesc}
              onDescription={setWebhookDesc}
              events={webhookEvents}
              onToggleEvent={(e) =>
                setWebhookEvents((prev) =>
                  prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]
                )
              }
            />
          )}
          {step === "guide" &&
            pattern === "webhook-outbound" &&
            createdWebhook && <WebhookGuide createdWebhook={createdWebhook} />}
        </ModalBody>

        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          {step === "pattern" && (
            <>
              <Button variant="flat" radius="md" size="sm" onPress={onClose}>
                Cancel
              </Button>
              <Button
                color="primary"
                radius="md"
                size="sm"
                isDisabled={!serviceName.trim()}
                onPress={handleNext}
              >
                {pattern === "webhook-outbound" ? "Next →" : "Make its key →"}
              </Button>
            </>
          )}
          {step === "configure" && (
            <>
              <Button
                variant="flat"
                radius="md"
                size="sm"
                isDisabled={isPending}
                onPress={() => setStep("pattern")}
              >
                ← Back
              </Button>
              <Button
                color="primary"
                radius="md"
                size="sm"
                isDisabled={!step2Valid || isPending}
                isLoading={isPending}
                onPress={() => void handleConfigure()}
              >
                Create subscription
              </Button>
            </>
          )}
          {step === "guide" && (
            <Button color="primary" size="sm" radius="md" onPress={onClose}>
              Done
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
