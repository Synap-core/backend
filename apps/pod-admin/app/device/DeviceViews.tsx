"use client";

/**
 * `/device` — what each state LOOKS like. Pure props in, markup out: the
 * stateful flow (`DeviceFlow`) owns reads and decisions, so every state here
 * renders in a test without a network or a pod.
 *
 * Built from pod-admin's approval blocks: `ReceiverShell` (pod + signed in
 * as), `Outcome` from `/approve-agent` for terminal answers, and its
 * Approve / secondary button pair. HeroUI primitives + preset tokens only.
 */

import {
  Button,
  CardBody,
  CardHeader,
  Checkbox,
  CheckboxGroup,
  Chip,
  Input,
  Radio,
  RadioGroup,
} from "@heroui/react";
import {
  AlertTriangle,
  Check,
  Clock,
  Laptop,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { GRANT_PRESETS } from "@synap-core/types/grants";
import { Outcome } from "../approve-agent/[keyId]/ApproveForm";
import {
  COMPUTER_NOUN,
  computerLine,
  formatCode,
  hostedAgentName,
  statusLabel,
  type DeviceRequest,
} from "./device-model";

const PAD = "px-5 sm:px-7";

function Header({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <CardHeader className={`flex flex-col items-start gap-3 ${PAD} pt-7 pb-0`}>
      <span
        aria-hidden
        className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20"
      >
        <Laptop className="h-5 w-5" strokeWidth={2} />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-tiny font-semibold uppercase tracking-wide text-foreground/65">
          {eyebrow}
        </p>
        <h1 className="font-heading text-2xl font-medium leading-tight tracking-tight text-foreground">
          {title}
        </h1>
      </div>
    </CardHeader>
  );
}

const RUN_AGAIN = (
  <>
    Run <code className="font-mono text-foreground/85">synap init</code> again
    in your terminal for a new code.
  </>
);

// ── Enter a code ─────────────────────────────────────────────────────────────

export function EnterCodeView({
  value,
  onChange,
  onSubmit,
  complete,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  complete: boolean;
}) {
  return (
    <>
      <Header
        eyebrow={`Connect a ${COMPUTER_NOUN.toLowerCase()}`}
        title="Enter the code from your terminal"
      />
      <CardBody className={`${PAD} pb-7 pt-5`}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (complete) onSubmit();
          }}
        >
          <Input
            aria-label="Code"
            autoFocus
            autoComplete="one-time-code"
            autoCapitalize="characters"
            placeholder="XXXX-XXXX"
            value={value}
            onValueChange={(v) => onChange(formatCode(v).slice(0, 9))}
            classNames={{ input: "font-mono text-lg tracking-[0.2em]" }}
          />
          <Button
            type="submit"
            color="primary"
            size="md"
            className="font-medium"
            isDisabled={!complete}
          >
            Continue
          </Button>
        </form>
      </CardBody>
    </>
  );
}

// ── Pending: the one decision ────────────────────────────────────────────────

export interface PendingViewProps {
  request: DeviceRequest;
  code: string;
  /** `null` = add as a new computer. */
  reuseId: string | null;
  onReuse: (id: string | null) => void;
  computerName: string;
  onComputerName: (v: string) => void;
  agents: string[];
  onAgents: (v: string[]) => void;
  busy: "approve" | "deny" | null;
  error: string | null;
  onApprove: () => void;
  onDeny: () => void;
  ago: (iso: string) => string;
}

const NEW = "__new__";

export function PendingView(p: PendingViewProps) {
  const r = p.request;
  const name = p.computerName.trim() || r.hostname;
  const preset = GRANT_PRESETS.find((g) => g.name === r.accessName);
  return (
    <>
      <Header
        eyebrow={`Connect a ${COMPUTER_NOUN.toLowerCase()}`}
        title={`Connect ${name}?`}
      />
      <CardBody className={`flex flex-col gap-5 ${PAD} pb-7 pt-5`}>
        {/* The device binding: the person compares, the pod already matched. */}
        <div className="flex flex-col gap-1 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
          <p className="text-small text-foreground/65">
            Check your terminal shows
          </p>
          <p
            data-testid="device-code"
            className="font-mono text-2xl font-semibold tracking-[0.2em] text-foreground"
          >
            {formatCode(p.code)}
          </p>
        </div>

        <section className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-tiny font-medium uppercase tracking-wide text-foreground/65">
              {COMPUTER_NOUN}
            </p>
            <Chip
              size="sm"
              variant="flat"
              startContent={<Clock className="ml-1 h-3 w-3" />}
            >
              {statusLabel(r.status)} · expires {p.ago(r.expiresAt)}
            </Chip>
          </div>
          <p className="text-small text-foreground/85">
            {computerLine(r, p.ago)}
          </p>

          {r.reusableComputers.length > 0 && (
            <RadioGroup
              aria-label={COMPUTER_NOUN}
              size="sm"
              value={p.reuseId ?? NEW}
              onValueChange={(v) => p.onReuse(v === NEW ? null : v)}
            >
              {r.reusableComputers.map((c) => (
                <Radio
                  key={c.id}
                  value={c.id}
                  description="Keeps its agents, history and rules"
                >
                  Reconnect {c.name}
                </Radio>
              ))}
              <Radio value={NEW}>
                Add as a new {COMPUTER_NOUN.toLowerCase()}
              </Radio>
            </RadioGroup>
          )}

          <Input
            size="sm"
            label="Name"
            value={p.computerName}
            onValueChange={p.onComputerName}
            isInvalid={!p.computerName.trim()}
            maxLength={80}
          />
        </section>

        {/* OMIT when the terminal asked for no agent. */}
        {r.agents.length > 0 && (
          <section className="flex flex-col gap-2">
            <p className="text-tiny font-medium uppercase tracking-wide text-foreground/65">
              Agents it will set up
            </p>
            <CheckboxGroup
              aria-label="Agents it will set up"
              size="sm"
              value={p.agents}
              onValueChange={p.onAgents}
            >
              {r.agents.map((a) => (
                <Checkbox key={a.agentType} value={a.agentType}>
                  {hostedAgentName(a, name)}
                </Checkbox>
              ))}
            </CheckboxGroup>
          </section>
        )}

        <p className="flex items-start gap-1.5 text-small text-foreground/85">
          <ShieldCheck
            aria-hidden
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/65"
          />
          <span>
            {name} gets its own access: it reads your data and proposes changes
            — every change waits for your approval. Key valid {r.keyTtlDays}{" "}
            days.
          </span>
        </p>

        {p.error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-danger/10 px-3.5 py-3 text-small text-foreground ring-1 ring-inset ring-danger/30"
          >
            <AlertTriangle
              aria-hidden
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger"
            />
            <span>{p.error}</span>
          </div>
        )}

        <div className="flex flex-col gap-2.5 sm:flex-row">
          <Button
            color="primary"
            size="md"
            className="flex-1 font-medium"
            isDisabled={p.busy !== null || !p.computerName.trim()}
            isLoading={p.busy === "approve"}
            startContent={
              p.busy === "approve" ? undefined : (
                <Check className="h-3.5 w-3.5" />
              )
            }
            onPress={p.onApprove}
          >
            Approve
          </Button>
          <Button
            variant="flat"
            size="sm"
            className="h-10 flex-1 sm:flex-none"
            isDisabled={p.busy !== null}
            isLoading={p.busy === "deny"}
            onPress={p.onDeny}
          >
            This wasn&apos;t me
          </Button>
        </div>

        <details className="text-tiny text-foreground/65">
          <summary className="cursor-pointer select-none">Details</summary>
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 pt-2">
            <Detail label="Access">
              {r.accessName}
              {preset ? ` — ${preset.description}` : ""}
            </Detail>
            <Detail label="Key lifetime">
              {r.keyTtlDays} days, renewed by your terminal
            </Detail>
            <Detail label="Requested from">
              {r.requesterIp ?? "Unknown address"}
            </Detail>
            <Detail label="Client">
              {[r.clientName, r.userAgent].filter(Boolean).join(" · ")}
            </Detail>
            <Detail label="Requested">
              {new Date(r.createdAt).toLocaleString()}
            </Detail>
            <Detail label="Expires">
              {new Date(r.expiresAt).toLocaleString()}
            </Detail>
          </dl>
        </details>
      </CardBody>
    </>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-foreground/65">{label}</dt>
      <dd className="min-w-0 break-words text-foreground/80">{children}</dd>
    </>
  );
}

// ── Terminal answers ─────────────────────────────────────────────────────────

export function ApprovedView({ name }: { name: string }) {
  return (
    <CardBody className={`${PAD} py-7`}>
      <Outcome
        tone="success"
        icon={<Check className="h-6 w-6" strokeWidth={2.2} />}
        title="Return to your terminal"
        message={`${name} is connected. Your terminal finishes setting it up — you can close this tab.`}
      />
    </CardBody>
  );
}

export function DeniedView({ name }: { name: string }) {
  return (
    <CardBody className={`${PAD} py-7`}>
      <Outcome
        tone="muted"
        icon={<X className="h-6 w-6" strokeWidth={2.2} />}
        title={statusLabel("denied")}
        message={`${name} was not connected and got no access. You can close this tab.`}
      />
    </CardBody>
  );
}

/** EXPLAIN: expired, already used, or no such code — and the way out. */
export function GoneView({
  title,
  onEnterAnother,
}: {
  title: string;
  onEnterAnother: () => void;
}) {
  return (
    <CardBody
      className={`flex flex-col items-center gap-3 ${PAD} py-7 text-center`}
    >
      <span
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-full bg-warning/10 text-warning ring-1 ring-inset ring-warning/30"
      >
        <Clock className="h-6 w-6" strokeWidth={2.2} />
      </span>
      <p className="text-medium font-medium text-foreground">{title}</p>
      <p className="max-w-[20rem] text-small text-foreground/65">
        Codes last 10 minutes and work once. {RUN_AGAIN}
      </p>
      <Button size="sm" variant="flat" onPress={onEnterAnother}>
        Enter another code
      </Button>
    </CardBody>
  );
}

/** EXPLAIN: too many wrong codes — the pod paused lookups for this person. */
export function LockedView({ message }: { message: string }) {
  return (
    <CardBody className={`${PAD} py-7`}>
      <Outcome
        tone="warning"
        icon={<AlertTriangle className="h-6 w-6" strokeWidth={2.2} />}
        title="Too many wrong codes"
        message={message}
      />
    </CardBody>
  );
}

/** The read FAILED — never a calm empty page. The recovery is in the failed state. */
export function FailedView({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <CardBody className={`${PAD} py-7`}>
      <div
        role="alert"
        className="flex items-center justify-between gap-3 rounded-lg bg-danger/10 px-3.5 py-3 text-small ring-1 ring-inset ring-danger/30"
      >
        <span className="text-foreground">
          Couldn&apos;t read this request: {message}
        </span>
        <Button size="sm" variant="flat" onPress={onRetry}>
          Retry
        </Button>
      </div>
    </CardBody>
  );
}

export function LoadingView() {
  return (
    <CardBody className={`${PAD} py-7`}>
      <p className="text-small text-foreground/65">Reading…</p>
    </CardBody>
  );
}
