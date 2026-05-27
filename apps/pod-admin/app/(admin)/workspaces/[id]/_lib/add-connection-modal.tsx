"use client";

/**
 * Add connection modal — 3-step flow.
 *
 * Step 1 — Service name + pattern (REST API | Hub Protocol | Webhook Outbound | Webhook Inbound)
 * Step 2 — Configure (scopes or webhook fields)
 * Step 3 — Integration guide
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
import { useState } from "react";
import { trpc, POD_URL } from "../../../../../lib/trpc";
import {
  RestGuide,
  HubGuide,
  WebhookGuide,
  type CreatedKey,
  type CreatedWebhook,
} from "./connection-guides";
import {
  Step1Pattern,
  Step2Key,
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

// ─── Scope definitions ─────────────────────────────────────────────────────────

const REST_SCOPES = [
  {
    value: "data.read",
    label: "data.read",
    description: "Read entities & documents",
  },
  {
    value: "data.write",
    label: "data.write",
    description: "Write entities & documents",
  },
];

const HUB_SCOPES = [
  {
    value: "hub-protocol.read",
    label: "hub-protocol.read",
    description: "Read data via Hub Protocol",
  },
  {
    value: "hub-protocol.write",
    label: "hub-protocol.write",
    description: "Write data via Hub Protocol",
  },
];

const INBOUND_SCOPES = [
  {
    value: "hub-protocol.read",
    label: "hub-protocol.read",
    description: "Read via Hub Protocol",
  },
  {
    value: "hub-protocol.write",
    label: "hub-protocol.write",
    description: "Write via Hub Protocol",
  },
  {
    value: "data.read",
    label: "data.read",
    description: "Read entities & documents",
  },
  {
    value: "data.write",
    label: "data.write",
    description: "Write entities & documents",
  },
];

function defaultScopes(pattern: Pattern): string[] {
  if (pattern === "hub-protocol")
    return ["hub-protocol.read", "hub-protocol.write"];
  if (pattern === "webhook-inbound")
    return ["hub-protocol.read", "hub-protocol.write"];
  return ["data.read"];
}

function scopeListFor(pattern: Pattern) {
  if (pattern === "hub-protocol") return HUB_SCOPES;
  if (pattern === "webhook-inbound") return INBOUND_SCOPES;
  return REST_SCOPES;
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
  const [step, setStep] = useState<Step>("pattern");
  const [pattern, setPattern] = useState<Pattern>("rest-api");
  const [serviceName, setServiceName] = useState(defaultServiceName ?? "");
  const [scopes, setScopes] = useState<string[]>(["data.read"]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookDesc, setWebhookDesc] = useState("");
  const [webhookEvents, setWebhookEvents] = useState<string[]>([]);
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null);
  const [createdWebhook, setCreatedWebhook] = useState<CreatedWebhook | null>(
    null
  );

  const isGuide = step === "guide";

  const createKeyMutation = trpc.apiKeys.adminCreateServiceKey.useMutation({
    onError: (err) =>
      addToast({
        title: "Create failed",
        description: err.message,
        color: "danger",
      }),
  });

  const createWebhookMutation =
    trpc.integrations.adminCreateForWorkspace.useMutation({
      onError: (err) =>
        addToast({
          title: "Create failed",
          description: err.message,
          color: "danger",
        }),
    });

  const isPending =
    createKeyMutation.isPending || createWebhookMutation.isPending;

  function handlePatternSelect(p: Pattern) {
    setPattern(p);
    setScopes(defaultScopes(p));
  }

  async function handleConfigure() {
    if (pattern === "webhook-outbound") {
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
    } else {
      const res = await createKeyMutation.mutateAsync({
        keyName: serviceName.trim(),
        scope: scopes,
        workspaceId,
      });
      if (res && "key" in res && typeof res.key === "string") {
        setCreatedKey({ plaintext: res.key, scopes });
        setStep("guide");
      }
    }
  }

  const step2Valid =
    pattern === "webhook-outbound"
      ? webhookUrl.trim().length > 0 && webhookEvents.length > 0
      : scopes.length > 0;

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
        : pattern === "webhook-outbound"
          ? "Subscription created"
          : "Connected — save your key";

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
              onPattern={handlePatternSelect}
              existingServiceNames={existingServiceNames}
            />
          )}
          {step === "configure" && pattern !== "webhook-outbound" && (
            <Step2Key
              podUrl={POD_URL}
              pattern={pattern}
              scopes={scopes}
              scopeList={scopeListFor(pattern)}
              onToggle={(s) =>
                setScopes((prev) =>
                  prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
                )
              }
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
          {step === "guide" && pattern === "rest-api" && createdKey && (
            <RestGuide podUrl={POD_URL} createdKey={createdKey} />
          )}
          {step === "guide" && pattern === "hub-protocol" && createdKey && (
            <HubGuide podUrl={POD_URL} createdKey={createdKey} />
          )}
          {step === "guide" && pattern === "webhook-inbound" && createdKey && (
            <HubGuide podUrl={POD_URL} createdKey={createdKey} />
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
                onPress={() => setStep("configure")}
              >
                Next →
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
                {pattern === "webhook-outbound"
                  ? "Create subscription"
                  : "Generate key"}
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
