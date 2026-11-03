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
import type { AgentWriteMode } from "@synap-core/types/agents";
import { GRANT_PRESETS } from "@synap-core/types/grants";
import { Outcome } from "../approve-agent/[keyId]/ApproveForm";
import { WriteModeChoice } from "../_lib/write-mode-choice";
import {
  AGENT_WRITE_MODE_CHOICES,
  agentRoleSlug,
} from "@synap-core/types/agents";
import {
  COMPUTER_NOUN,
  DEVICE_RUN_AGAIN_COMMAND,
  accessLine,
  askerLine,
  canApprove,
  computerHasSeats,
  computerLine,
  deviceRows,
  deviceTitle,
  formatCode,
  hostedAgentDisplay,
  hostedAgentFacts,
  hostedAgentName,
  reconnectLine,
  rowAgentDisplay,
  statusLabel,
  untouchedAgents,
  type DeviceAgentChoice,
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
    Run{" "}
    <code className="font-mono text-foreground/85">
      {DEVICE_RUN_AGAIN_COMMAND}
    </code>{" "}
    again in your terminal for a new code.
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
  /** How the kept agents' changes land (`AGENT_WRITE_MODE_CHOICES`). */
  agentWriteMode: AgentWriteMode;
  onAgentWriteMode: (v: AgentWriteMode) => void;
  /**
   * Per row (a 0395 pod, which serves `rows`): add / reconnect one agent /
   * skip, with the job of an added agent and, for a reconnect, a permission
   * change only when the person makes one (D6).
   */
  actions?: DeviceAgentChoice[];
  onActions?: (v: DeviceAgentChoice[]) => void;
  busy: "approve" | "deny" | null;
  error: string | null;
  onApprove: () => void;
  onDeny: () => void;
  ago: (iso: string) => string;
}

const NEW = "__new__";

/** The agents section's question: how their changes land. */
export const WRITE_MODE_QUESTION = "How its agents' changes land";

export function PendingView(p: PendingViewProps) {
  const r = p.request;
  const name = p.computerName.trim() || r.hostname;
  const preset = GRANT_PRESETS.find((g) => g.name === r.accessName);
  // A 0395 pod serves `rows`: the decision is per agent, by evidence.
  const perRow = Boolean(r.rows && p.actions && p.onActions);
  const actions = p.actions ?? [];
  const adds = actions.filter((a) => a.action === "add");
  return (
    <>
      <Header
        eyebrow={`Connect a ${COMPUTER_NOUN.toLowerCase()}`}
        title={
          perRow
            ? deviceTitle(r, p.reuseId, p.computerName, actions)
            : `Connect ${name}?`
        }
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
            {perRow && askerLine(r, p.reuseId)
              ? ` · ${askerLine(r, p.reuseId)}`
              : ""}
          </p>

          {perRow && r.reusableComputers.length > 0 && (
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
                  description={`Already connected · ${(c.agents ?? []).length} agent${(c.agents ?? []).length === 1 ? "" : "s"}`}
                >
                  {c.name}
                </Radio>
              ))}
              <Radio value={NEW}>
                Add as a new {COMPUTER_NOUN.toLowerCase()}
              </Radio>
            </RadioGroup>
          )}

          {!perRow && r.reusableComputers.length > 0 && (
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
                  description={reconnectLine(c, p.ago)}
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

        {perRow && (
          <AgentRows
            request={r}
            reuseId={p.reuseId}
            computerName={name}
            actions={actions}
            onActions={p.onActions!}
            isDisabled={p.busy !== null}
            ago={p.ago}
          />
        )}

        {/* OMIT when the terminal asked for no agent. */}
        {!perRow && r.agents.length > 0 && (
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

        {/* OMIT when no agent is kept (or added): the choice is about them. */}
        {(perRow ? adds.length > 0 : p.agents.length > 0) && (
          <section className="flex flex-col gap-2">
            <p className="text-tiny font-medium uppercase tracking-wide text-foreground/65">
              {perRow ? ADDED_WRITE_MODE_QUESTION : WRITE_MODE_QUESTION}
            </p>
            <WriteModeChoice
              label={perRow ? ADDED_WRITE_MODE_QUESTION : WRITE_MODE_QUESTION}
              value={p.agentWriteMode}
              onChange={p.onAgentWriteMode}
              isDisabled={p.busy !== null}
            />
          </section>
        )}

        <p className="flex items-start gap-1.5 text-small text-foreground/85">
          <ShieldCheck
            aria-hidden
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/65"
          />
          <span>{accessLine(r, name)}</span>
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
            isDisabled={p.busy !== null || !canApprove(p.computerName)}
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

/** The question over the write mode when agents are added (0395). */
export const ADDED_WRITE_MODE_QUESTION = "How the added agents' changes land";

/** "Nothing else on devbox changes." — the reassurance under the rows. */
export function nothingElseLine(computerName: string): string {
  return `Nothing else on ${computerName} changes.`;
}

const modeLabel = (mode: AgentWriteMode | null | undefined) =>
  AGENT_WRITE_MODE_CHOICES.find((c) => c.mode === mode)?.label ?? null;

/**
 * 0395: the agents of the computer, one decision per row. What is already
 * there and stays as it is; then each agent asked for — add it (with a job),
 * reconnect ONE agent of the same engine and job, or leave it out.
 */
function AgentRows({
  request: r,
  reuseId,
  computerName,
  actions,
  onActions,
  isDisabled,
  ago,
}: {
  request: DeviceRequest;
  reuseId: string | null;
  computerName: string;
  actions: DeviceAgentChoice[];
  onActions: (v: DeviceAgentChoice[]) => void;
  isDisabled: boolean;
  ago: (iso: string) => string;
}) {
  const computer = r.reusableComputers.find((c) => c.id === reuseId);
  const showSeat = computerHasSeats(computer, r.seat);
  const kept = untouchedAgents(r, reuseId, actions);
  const rows = deviceRows(r);
  const set = (i: number, patch: Partial<DeviceAgentChoice>) =>
    onActions(actions.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  return (
    <>
      {/* OMIT on a new computer: nothing is there yet. */}
      {computer && kept.length > 0 && (
        <section className="flex flex-col gap-2" data-testid="device-kept">
          <p className="text-tiny font-medium uppercase tracking-wide text-foreground/65">
            On {computerName} now, these stay as they are
          </p>
          <ul className="flex flex-col gap-1">
            {kept.map((a) => (
              <li key={a.id} className="text-small text-foreground/85">
                {hostedAgentDisplay(a, computerName, showSeat)}
                <span className="text-foreground/65">
                  {" "}
                  · {hostedAgentFacts(a, ago)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {rows.length > 0 && (
        <section className="flex flex-col gap-3" data-testid="device-rows">
          <p className="text-tiny font-medium uppercase tracking-wide text-foreground/65">
            {r.seat ? `For OS user "${r.seat}"` : `Agents it will set up`}
          </p>
          {actions.map((a, i) => {
            const candidates = (computer?.agents ?? []).filter(
              (h) =>
                h.agentType === a.agentType &&
                (h.role ?? null) === (rows[i]?.role ?? null)
            );
            const target = candidates.find((h) => h.id === a.agentId);
            const current = modeLabel(target?.writeMode);
            return (
              <div
                key={a.rowKey}
                className="flex flex-col gap-2 rounded-lg px-3 py-2.5 ring-1 ring-inset ring-foreground/10"
              >
                <Checkbox
                  size="sm"
                  isSelected={a.action !== "skip"}
                  isDisabled={isDisabled}
                  onValueChange={(on) =>
                    set(i, {
                      action: on
                        ? candidates.length > 0 && a.agentId
                          ? "reconnect"
                          : "add"
                        : "skip",
                    })
                  }
                >
                  {a.action === "reconnect" && target
                    ? `Reconnect ${hostedAgentDisplay(target, computerName, showSeat)}`
                    : `Add ${rowAgentDisplay(a, computerName, r.seat, showSeat)}`}
                </Checkbox>

                {a.action !== "skip" && candidates.length > 0 && (
                  <RadioGroup
                    aria-label="Add or reconnect"
                    size="sm"
                    value={
                      a.action === "reconnect" && a.agentId ? a.agentId : NEW
                    }
                    isDisabled={isDisabled}
                    onValueChange={(v) =>
                      set(
                        i,
                        v === NEW
                          ? {
                              action: "add",
                              agentId: null,
                              writeMode: undefined,
                            }
                          : {
                              action: "reconnect",
                              agentId: v,
                              writeMode: undefined,
                            }
                      )
                    }
                  >
                    <Radio
                      value={NEW}
                      description="Its own key; the others keep theirs."
                    >
                      Add a new agent
                    </Radio>
                    {candidates.map((h) => (
                      <Radio
                        key={h.id}
                        value={h.id}
                        description={`${hostedAgentFacts(h, ago)} → new key; it stops until this terminal finishes.`}
                      >
                        Reconnect{" "}
                        {hostedAgentDisplay(h, computerName, showSeat)}
                      </Radio>
                    ))}
                  </RadioGroup>
                )}

                {a.action === "add" && (
                  <Input
                    size="sm"
                    label="Job (optional)"
                    placeholder="e.g. CRM worker"
                    value={a.roleLabel ?? ""}
                    isDisabled={isDisabled}
                    maxLength={80}
                    onValueChange={(v) => {
                      const slug = agentRoleSlug(v);
                      set(i, {
                        role: slug || null,
                        roleLabel: slug ? v : null,
                      });
                    }}
                  />
                )}

                {a.action === "reconnect" && target && (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-small text-foreground/85">
                      {a.writeMode
                        ? "Its changes will land as you choose below."
                        : `Keeps its permission${current ? `: ${current}` : ""}.`}
                    </p>
                    {a.writeMode ? (
                      <WriteModeChoice
                        label={`How ${hostedAgentDisplay(target, computerName, false)}'s changes land`}
                        value={a.writeMode}
                        onChange={(m) => set(i, { writeMode: m })}
                        isDisabled={isDisabled}
                      />
                    ) : (
                      <Button
                        size="sm"
                        variant="light"
                        className="self-start"
                        isDisabled={isDisabled}
                        onPress={() =>
                          set(i, {
                            writeMode: target.writeMode ?? "pod-default",
                          })
                        }
                      >
                        Change its permission…
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {computer && (
            <p className="text-small text-foreground/65">
              {nothingElseLine(computerName)}
            </p>
          )}
        </section>
      )}
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
