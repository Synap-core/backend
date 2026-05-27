"use client";

/**
 * Add connection modal — 3-step flow for Section B of the Connections tab.
 *
 * Step 1 — Choose pattern (REST API | Hub Protocol | Webhooks) + service name
 * Step 2 — Configure (scopes or webhook fields)
 * Step 3 — Integration guide (pattern-specific, isDismissable=false until Done)
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
} from "@heroui/react";
import { Bot, Database, Webhook } from "lucide-react";
import { useState } from "react";
import { trpc, POD_URL } from "../../../../../lib/trpc";
import { WEBHOOK_EVENTS } from "./webhooks-panel";
import {
  RestGuide,
  HubGuide,
  WebhookGuide,
  type CreatedKey,
  type CreatedWebhook,
} from "./connection-guides";

// ─── Types ────────────────────────────────────────────────────────────────────

type Pattern = "rest" | "hub" | "webhook";
type Step = "pattern" | "configure" | "guide";

// ─── Scopes ───────────────────────────────────────────────────────────────────

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

// ─── Modal ────────────────────────────────────────────────────────────────────

export function AddConnectionModal({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>("pattern");
  const [pattern, setPattern] = useState<Pattern>("rest");
  const [serviceName, setServiceName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["data.read"]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookDesc, setWebhookDesc] = useState("");
  const [webhookEvents, setWebhookEvents] = useState<string[]>([]);
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null);
  const [createdWebhook, setCreatedWebhook] = useState<CreatedWebhook | null>(
    null
  );

  const isGuide = step === "guide";

  const createKeyMutation = trpc.apiKeys.create.useMutation({
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

  function toggleScope(s: string) {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  }

  function toggleEvent(e: string) {
    setWebhookEvents((prev) =>
      prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]
    );
  }

  function handlePatternSelect(p: Pattern) {
    setPattern(p);
    setScopes(
      p === "hub" ? ["hub-protocol.read", "hub-protocol.write"] : ["data.read"]
    );
  }

  async function handleConfigure() {
    if (pattern === "rest" || pattern === "hub") {
      const res = await createKeyMutation.mutateAsync({
        keyName: serviceName.trim(),
        scope: scopes,
        workspaceId,
      });
      if (res && "key" in res && typeof res.key === "string") {
        setCreatedKey({ plaintext: res.key, scopes });
        setStep("guide");
      }
    } else {
      const res = await createWebhookMutation.mutateAsync({
        workspaceId,
        url: webhookUrl.trim(),
        events: webhookEvents,
        description: webhookDesc.trim() || undefined,
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
  }

  const scopeList = pattern === "hub" ? HUB_SCOPES : REST_SCOPES;
  const step2Valid =
    pattern === "webhook"
      ? webhookUrl.trim().length > 0 && webhookEvents.length > 0
      : scopes.length > 0;

  const modalTitle =
    step === "pattern"
      ? "Connect external service"
      : step === "configure"
        ? `Connect — ${pattern === "rest" ? "REST API" : pattern === "hub" ? "Hub Protocol" : "Webhooks"}`
        : pattern === "webhook"
          ? "Subscription created"
          : "Connected — save your key";

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
            style={{
              background:
                pattern === "hub"
                  ? "rgba(52, 211, 153, 0.18)"
                  : pattern === "webhook"
                    ? "rgba(167, 139, 250, 0.18)"
                    : "rgba(99, 179, 237, 0.18)",
            }}
          >
            {pattern === "hub" ? (
              <Bot className="h-3.5 w-3.5 text-foreground/85" />
            ) : pattern === "webhook" ? (
              <Webhook className="h-3.5 w-3.5 text-foreground/85" />
            ) : (
              <Database className="h-3.5 w-3.5 text-foreground/85" />
            )}
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
            />
          )}

          {step === "configure" && pattern !== "webhook" && (
            <Step2Key
              podUrl={POD_URL}
              pattern={pattern}
              scopes={scopes}
              scopeList={scopeList}
              onToggle={toggleScope}
            />
          )}

          {step === "configure" && pattern === "webhook" && (
            <Step2Webhook
              url={webhookUrl}
              onUrl={setWebhookUrl}
              description={webhookDesc}
              onDescription={setWebhookDesc}
              events={webhookEvents}
              onToggleEvent={toggleEvent}
            />
          )}

          {step === "guide" && pattern === "rest" && createdKey && (
            <RestGuide podUrl={POD_URL} createdKey={createdKey} />
          )}
          {step === "guide" && pattern === "hub" && createdKey && (
            <HubGuide podUrl={POD_URL} createdKey={createdKey} />
          )}
          {step === "guide" && pattern === "webhook" && createdWebhook && (
            <WebhookGuide createdWebhook={createdWebhook} />
          )}
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
                {pattern === "webhook" ? "Create subscription" : "Generate key"}
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

// ─── Step 1 ───────────────────────────────────────────────────────────────────

function Step1Pattern({
  serviceName,
  onServiceName,
  pattern,
  onPattern,
}: {
  serviceName: string;
  onServiceName: (v: string) => void;
  pattern: Pattern;
  onPattern: (p: Pattern) => void;
}) {
  return (
    <>
      <Input
        label="Service name"
        placeholder="e.g. n8n integration"
        value={serviceName}
        onValueChange={onServiceName}
        size="sm"
        isRequired
      />
      <div className="flex flex-col gap-1.5">
        <p className="text-[12.5px] font-medium text-foreground">
          Integration pattern
        </p>
        <PatternCard
          selected={pattern === "rest"}
          onSelect={() => onPattern("rest")}
          icon={<Database className="h-4 w-4 text-foreground/60" />}
          title="REST API"
          description="Read/write entities and data via REST. Best for backend integrations that need direct data access."
        />
        <PatternCard
          selected={pattern === "hub"}
          onSelect={() => onPattern("hub")}
          icon={<Bot className="h-4 w-4 text-foreground/60" />}
          title="Hub Protocol"
          description="AI-native agent operations: memory, proposals, channels. Best for AI services and agent integrations."
        />
        <PatternCard
          selected={pattern === "webhook"}
          onSelect={() => onPattern("webhook")}
          icon={<Webhook className="h-4 w-4 text-foreground/60" />}
          title="Webhooks"
          description="Receive live events from this pod at your endpoint. Your service gets notified when things change."
        />
      </div>
    </>
  );
}

// ─── Step 2a — Key-based ──────────────────────────────────────────────────────

function Step2Key({
  podUrl,
  pattern,
  scopes,
  scopeList,
  onToggle,
}: {
  podUrl: string;
  pattern: Pattern;
  scopes: string[];
  scopeList: { value: string; label: string; description: string }[];
  onToggle: (s: string) => void;
}) {
  const endpoint =
    pattern === "hub"
      ? `${podUrl}/api/hub/*`
      : `${podUrl}/trpc/{router}.{procedure}`;
  return (
    <>
      <p className="text-[12.5px] text-foreground/55">
        Your service calls{" "}
        <code className="font-mono text-[11.5px]">{endpoint}</code> with{" "}
        <code className="font-mono text-[11.5px]">
          Authorization: Bearer {"{key}"}
        </code>
        .
      </p>
      <div className="flex flex-col gap-1">
        <p className="text-[12.5px] font-medium text-foreground">
          Allowed scopes
        </p>
        <div className="rounded-lg ring-1 ring-inset ring-foreground/10">
          {scopeList.map((s) => (
            <label
              key={s.value}
              className="flex cursor-pointer items-start gap-2 border-b border-foreground/[0.05] px-3 py-2 last:border-0 hover:bg-content2/40"
            >
              <Checkbox
                size="sm"
                isSelected={scopes.includes(s.value)}
                onValueChange={() => onToggle(s.value)}
              />
              <span className="flex flex-col">
                <span className="font-mono text-[12px] font-medium text-foreground">
                  {s.label}
                </span>
                <span className="text-[11px] text-foreground/55">
                  {s.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── Step 2b — Webhook ────────────────────────────────────────────────────────

function Step2Webhook({
  url,
  onUrl,
  description,
  onDescription,
  events,
  onToggleEvent,
}: {
  url: string;
  onUrl: (v: string) => void;
  description: string;
  onDescription: (v: string) => void;
  events: string[];
  onToggleEvent: (e: string) => void;
}) {
  return (
    <>
      <Input
        label="Endpoint URL"
        placeholder="https://example.com/webhook"
        value={url}
        onValueChange={onUrl}
        size="sm"
        isRequired
      />
      <Input
        label="Description"
        placeholder="e.g. n8n automation trigger"
        value={description}
        onValueChange={onDescription}
        size="sm"
      />
      <div className="flex flex-col gap-1.5">
        <p className="text-[12.5px] font-medium text-foreground">
          Events
          <span className="ml-1 text-[11px] font-normal text-foreground/45">
            (select at least one)
          </span>
        </p>
        <div className="rounded-lg ring-1 ring-inset ring-foreground/10 max-h-44 overflow-y-auto">
          {WEBHOOK_EVENTS.map((e) => (
            <label
              key={e}
              className="flex cursor-pointer items-center gap-2 border-b border-foreground/[0.05] px-3 py-2 last:border-0 hover:bg-content2/40"
            >
              <Checkbox
                size="sm"
                isSelected={events.includes(e)}
                onValueChange={() => onToggleEvent(e)}
              />
              <span className="font-mono text-[11.5px] text-foreground/75">
                {e}
              </span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── Pattern card ─────────────────────────────────────────────────────────────

function PatternCard({
  selected,
  onSelect,
  icon,
  title,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "flex items-start gap-3 rounded-lg p-3 text-left transition-all w-full",
        selected
          ? "ring-1 ring-primary bg-primary/[0.04]"
          : "ring-1 ring-foreground/[0.08] hover:ring-foreground/20",
      ].join(" ")}
    >
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium text-foreground">{title}</span>
        <span className="text-[11.5px] text-foreground/55">{description}</span>
      </div>
    </button>
  );
}
