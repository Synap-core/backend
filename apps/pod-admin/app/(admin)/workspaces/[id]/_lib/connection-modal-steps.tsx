"use client";

/**
 * Step sub-components for AddConnectionModal.
 * Extracted to keep add-connection-modal.tsx under 500 lines.
 */

import { Checkbox, Input } from "@heroui/react";
import { ArrowDownToLine, Bot, Database, Webhook } from "lucide-react";
import { WEBHOOK_EVENTS } from "./add-connection-modal";

export type Pattern =
  | "rest-api"
  | "hub-protocol"
  | "webhook-outbound"
  | "webhook-inbound";

// ─── Step 1 ───────────────────────────────────────────────────────────────────

export function Step1Pattern({
  serviceName,
  onServiceName,
  pattern,
  onPattern,
  existingServiceNames,
}: {
  serviceName: string;
  onServiceName: (v: string) => void;
  pattern: Pattern;
  onPattern: (p: Pattern) => void;
  existingServiceNames: string[];
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
        description={
          existingServiceNames.length > 0
            ? `Existing: ${existingServiceNames.slice(0, 3).join(", ")}${existingServiceNames.length > 3 ? ` +${existingServiceNames.length - 3} more` : ""}`
            : undefined
        }
      />
      <div className="flex flex-col gap-1.5">
        <p className="text-[12.5px] font-medium text-foreground">
          Integration pattern
        </p>
        <PatternCard
          selected={pattern === "rest-api"}
          onSelect={() => onPattern("rest-api")}
          icon={<Database className="h-4 w-4 text-foreground/60" />}
          title="REST API"
          description="Your backend calls Synap's API to read/write entities and documents."
        />
        <PatternCard
          selected={pattern === "hub-protocol"}
          onSelect={() => onPattern("hub-protocol")}
          icon={<Bot className="h-4 w-4 text-foreground/60" />}
          title="Hub Protocol"
          description="Your AI agent uses Hub Protocol ops: memory, proposals, channels."
        />
        <PatternCard
          selected={pattern === "webhook-outbound"}
          onSelect={() => onPattern("webhook-outbound")}
          icon={<Webhook className="h-4 w-4 text-foreground/60" />}
          title="Webhook — Outbound"
          description="Synap notifies your endpoint when things change (entity updates, proposals, etc.)."
        />
        <PatternCard
          selected={pattern === "webhook-inbound"}
          onSelect={() => onPattern("webhook-inbound")}
          icon={<ArrowDownToLine className="h-4 w-4 text-foreground/60" />}
          title="Webhook — Inbound"
          description="Your service sends events into this pod via Hub Protocol."
        />
      </div>
    </>
  );
}

// ─── Step 2a — Key-based ──────────────────────────────────────────────────────

export function Step2Key({
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
    pattern === "hub-protocol" || pattern === "webhook-inbound"
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

// ─── Step 2b — Webhook outbound ───────────────────────────────────────────────

export function Step2WebhookOutbound({
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

export function PatternCard({
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
