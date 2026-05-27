"use client";

/**
 * Integration guide bodies — Step 3 of the Add Connection modal.
 * Extracted to keep add-connection-modal.tsx under 500 lines.
 */

import { Snippet } from "@heroui/react";
import { Check, ShieldAlert } from "lucide-react";
import { useState } from "react";

// ─── Shared primitives ────────────────────────────────────────────────────────

export function SaveOnceBanner() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5">
      <ShieldAlert
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500"
        aria-hidden
      />
      <p className="text-[11.5px] text-foreground/70">
        This key will only be shown once. Copy it now before closing.
      </p>
    </div>
  );
}

export function LabeledSnippet({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] uppercase tracking-wider text-foreground/45">
        {label}
      </p>
      <Snippet
        symbol=""
        size="sm"
        className="overflow-hidden font-mono"
        classNames={{ base: "bg-foreground/[0.05]" }}
      >
        {value}
      </Snippet>
    </div>
  );
}

export function Collapsible({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1 text-[12px] font-medium text-foreground/55 hover:text-foreground transition-colors text-left"
      >
        <span>{open ? "▾" : "▸"}</span>
        {label}
      </button>
      {open && children}
    </div>
  );
}

// ─── Guide payloads ───────────────────────────────────────────────────────────

export interface CreatedKey {
  plaintext: string;
  scopes: string[];
}

export interface CreatedWebhook {
  url: string;
  events: string[];
  secret: string;
}

// ─── REST API guide ───────────────────────────────────────────────────────────

export function RestGuide({
  podUrl,
  createdKey,
}: {
  podUrl: string;
  createdKey: CreatedKey;
}) {
  const [open, setOpen] = useState(false);
  const curl = `curl -X POST ${podUrl}/trpc/entities.list \\
  -H "Authorization: Bearer ${createdKey.plaintext}" \\
  -H "Content-Type: application/json" \\
  -d '{}'`;

  return (
    <div className="flex flex-col gap-3">
      <SaveOnceBanner />
      <LabeledSnippet label="API key" value={createdKey.plaintext} />
      <LabeledSnippet label="Base URL" value={`${podUrl}/trpc`} />
      <p className="text-[11.5px] text-foreground/55">
        Scopes granted:{" "}
        <span className="font-mono">{createdKey.scopes.join(", ")}</span>
      </p>
      <Collapsible
        open={open}
        onToggle={() => setOpen((v) => !v)}
        label="How to use"
      >
        <pre className="overflow-x-auto rounded-md border border-foreground/[0.06] bg-foreground/[0.03] px-3 py-2.5 font-mono text-[10.5px] text-foreground/70 whitespace-pre-wrap break-all">
          {curl}
        </pre>
      </Collapsible>
    </div>
  );
}

// ─── Hub Protocol guide ───────────────────────────────────────────────────────

export function HubGuide({
  podUrl,
  createdKey,
}: {
  podUrl: string;
  createdKey: CreatedKey;
}) {
  const [open, setOpen] = useState(false);
  const curl = `curl -X POST ${podUrl}/api/hub/memory \\
  -H "Authorization: Bearer ${createdKey.plaintext}" \\
  -H "Content-Type: application/json" \\
  -d '{"content":"...","tags":[]}'`;

  return (
    <div className="flex flex-col gap-3">
      <SaveOnceBanner />
      <LabeledSnippet label="API key" value={createdKey.plaintext} />
      <LabeledSnippet label="Hub base URL" value={`${podUrl}/api/hub`} />
      <p className="text-[11.5px] text-foreground/55">
        Full API reference:{" "}
        <code className="font-mono text-[11px]">
          {podUrl}/api/hub/openapi.json
        </code>
      </p>
      <Collapsible
        open={open}
        onToggle={() => setOpen((v) => !v)}
        label="How to use"
      >
        <pre className="overflow-x-auto rounded-md border border-foreground/[0.06] bg-foreground/[0.03] px-3 py-2.5 font-mono text-[10.5px] text-foreground/70 whitespace-pre-wrap break-all">
          {curl}
        </pre>
      </Collapsible>
    </div>
  );
}

// ─── Webhook guide ────────────────────────────────────────────────────────────

export function WebhookGuide({
  createdWebhook,
}: {
  createdWebhook: CreatedWebhook;
}) {
  const [open, setOpen] = useState(false);
  const sigSnippet = `import crypto from 'crypto';
const sig = req.headers['x-synap-signature'];
const expected = crypto
  .createHmac('sha256', YOUR_WEBHOOK_SECRET)
  .update(JSON.stringify(req.body))
  .digest('hex');
if (sig !== expected) throw new Error('Invalid signature');`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-md border border-success/20 bg-success/[0.06] px-3 py-2.5">
        <Check
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success"
          aria-hidden
        />
        <p className="text-[11.5px] text-foreground/70">
          Subscription created successfully.
        </p>
      </div>
      <LabeledSnippet label="Endpoint" value={createdWebhook.url} />
      <div className="flex flex-col gap-1">
        <p className="text-[11px] uppercase tracking-wider text-foreground/45">
          Subscribed events
        </p>
        <div className="flex flex-wrap gap-1">
          {createdWebhook.events.map((e) => (
            <span
              key={e}
              className="rounded-full bg-foreground/[0.06] px-2 py-0.5 font-mono text-[10px] text-foreground/55"
            >
              {e}
            </span>
          ))}
        </div>
      </div>
      <p className="text-[11.5px] text-foreground/55">
        Payload schema:{" "}
        <code className="font-mono text-[11px]">
          {"{ event, workspaceId, payload, timestamp }"}
        </code>
      </p>
      <Collapsible
        open={open}
        onToggle={() => setOpen((v) => !v)}
        label="Verifying signatures"
      >
        <pre className="overflow-x-auto rounded-md border border-foreground/[0.06] bg-foreground/[0.03] px-3 py-2.5 font-mono text-[10.5px] text-foreground/70 whitespace-pre-wrap break-all">
          {sigSnippet}
        </pre>
      </Collapsible>
    </div>
  );
}
