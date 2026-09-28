"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ReceiverShell } from "../_lib/receiver-shell";
import { Button, CardBody, CardHeader, Skeleton } from "@heroui/react";
import { AlertTriangle, Bot, Check, X } from "lucide-react";
import { resolveServiceMark } from "@synap-core/types/service-marks";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { publicPodUrl } from "../../lib/public-pod-url";
import { Outcome, Row } from "../approve-agent/[keyId]/ApproveForm";

type KeyStatus = "pending" | "active" | "rejected" | "not_found" | "forbidden";

interface PendingKey {
  keyId: string;
  status: KeyStatus;
  keyName?: string;
  agentType?: string | null;
  agentName?: string | null;
  instanceId?: string | null;
}

/** `/approve-batch` per-key outcome (setup.ts). */
type BatchOutcome =
  "approved" | "already_active" | "rejected" | "not_found" | "forbidden";

interface KeyResult {
  key: PendingKey;
  /** Status token resolved through the vocabulary door. */
  token: string;
  ok: boolean;
}

type Step =
  | { kind: "loading" }
  | { kind: "load-error"; message: string }
  | { kind: "ready" }
  | { kind: "done"; action: "approve" | "reject"; results: KeyResult[] };

type Busy = null | "approve" | "reject-all" | { rejecting: string };

interface ApproveBatchFormProps {
  keyIds: string[];
  podHost?: string;
  identity?: string;
}

const CLOSE_TAB = "You can close this tab. Your terminal will carry on.";

async function postJson(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Cross-subdomain (pod-admin.<root> → pod.<root>): send the Kratos cookie.
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error || `Error (${res.status})`
    );
  }
  return data;
}

/**
 * Product name for a key's agent: the service registry's name when the agent
 * type is a known service, else the agent's own name, else the humanized type.
 * Never a key id.
 */
function agentLabel(k: PendingKey): string {
  const mark = resolveServiceMark(k.agentType, "mono");
  if (mark.known) return mark.name;
  if (k.agentName) return k.agentName;
  if (k.agentType) return mark.name;
  return "Agent";
}

/** A key's lookup status as a vocabulary token (`active` ⇒ connected). */
function statusToken(status: KeyStatus): string {
  if (status === "active") return "connected";
  if (status === "forbidden") return "unavailable";
  return status;
}

/** An approve-batch outcome as a vocabulary token. */
function outcomeToken(outcome: BatchOutcome | undefined): string {
  if (!outcome) return "failed";
  if (outcome === "already_active") return "connected";
  if (outcome === "forbidden") return "unavailable";
  return outcome;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

export function ApproveBatchForm({
  keyIds,
  podHost,
  identity,
}: ApproveBatchFormProps) {
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [keys, setKeys] = useState<PendingKey[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const podUrl = useMemo(() => publicPodUrl(), []);

  const load = useCallback(async () => {
    if (keyIds.length === 0) {
      setStep({ kind: "load-error", message: "This link names no agents." });
      return;
    }
    setStep({ kind: "loading" });
    setActionError(null);
    try {
      const data = (await postJson(
        `${podUrl}/api/hub/setup/agent/pending/lookup`,
        { keyIds }
      )) as { keys: PendingKey[] };
      setKeys(data.keys);
      setStep({ kind: "ready" });
    } catch (err) {
      setStep({ kind: "load-error", message: errorMessage(err) });
    }
  }, [keyIds, podUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = keys.filter((k) => k.status === "pending");
  const allConnected =
    keys.length > 0 && keys.every((k) => k.status === "active");

  const approveAll = useCallback(async () => {
    const targets = keys.filter((k) => k.status === "pending");
    if (targets.length === 0) return;
    setBusy("approve");
    setActionError(null);
    try {
      const data = (await postJson(
        `${podUrl}/api/hub/setup/agent/pending/approve-batch`,
        { keyIds: targets.map((k) => k.keyId) }
      )) as {
        approved: number;
        results: Array<{ keyId: string; outcome: BatchOutcome }>;
      };
      const byId = new Map(data.results.map((r) => [r.keyId, r.outcome]));
      setStep({
        kind: "done",
        action: "approve",
        results: targets.map((key) => {
          const outcome = byId.get(key.keyId);
          return {
            key,
            token: outcomeToken(outcome),
            ok: outcome === "approved" || outcome === "already_active",
          };
        }),
      });
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [keys, podUrl]);

  const rejectOne = useCallback(
    async (key: PendingKey): Promise<boolean> => {
      try {
        await postJson(
          `${podUrl}/api/hub/setup/agent/pending/${key.keyId}/reject`
        );
        return true;
      } catch (err) {
        setActionError(`${agentLabel(key)}: ${errorMessage(err)}`);
        return false;
      }
    },
    [podUrl]
  );

  const rejectRow = useCallback(
    async (key: PendingKey) => {
      setBusy({ rejecting: key.keyId });
      setActionError(null);
      const ok = await rejectOne(key);
      if (ok) {
        setKeys((prev) =>
          prev.map((k) =>
            k.keyId === key.keyId ? { ...k, status: "rejected" } : k
          )
        );
      }
      setBusy(null);
    },
    [rejectOne]
  );

  const rejectAll = useCallback(async () => {
    const targets = keys.filter((k) => k.status === "pending");
    if (targets.length === 0) return;
    setBusy("reject-all");
    setActionError(null);
    const results: KeyResult[] = [];
    for (const key of targets) {
      const ok = await rejectOne(key);
      results.push({ key, token: ok ? "rejected" : "failed", ok });
    }
    setStep({ kind: "done", action: "reject", results });
    setBusy(null);
  }, [keys, rejectOne]);

  const isBusy = busy !== null;

  return (
    <ReceiverShell podHost={podHost} identity={identity} width="sm">
      <CardHeader className="flex flex-col items-start gap-3 px-7 pt-7 pb-0">
        <span
          aria-hidden
          className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-inset ring-primary/20 text-primary"
        >
          <Bot className="h-5 w-5" strokeWidth={2} />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/65">
            Agent access request
          </p>
          <h1 className="font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
            Connect your agents
          </h1>
          <p className="text-[13px] leading-relaxed text-foreground/65">
            <code className="font-mono text-foreground/80">synap init</code>{" "}
            wants to connect these agents to your pod. They can read it and make
            changes under your trust rules.
          </p>
        </div>
      </CardHeader>

      <CardBody className="flex flex-col gap-5 px-7 pb-7 pt-5">
        {step.kind === "loading" && <KeyListSkeleton count={keyIds.length} />}

        {step.kind === "ready" && allConnected && (
          <Outcome
            tone="success"
            icon={<Check className="h-6 w-6" strokeWidth={2.2} />}
            title="Already connected"
            message={CLOSE_TAB}
          />
        )}

        {step.kind === "ready" && !allConnected && (
          <>
            <div className="flex flex-col gap-2 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
              {keys.map((k) => (
                <div key={k.keyId} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Row
                      label={agentLabel(k)}
                      value={
                        k.status === "pending"
                          ? (k.instanceId ?? "Waiting for you")
                          : resolveStatusLabel(statusToken(k.status))
                      }
                    />
                  </div>
                  {k.status === "pending" && (
                    <Button
                      size="sm"
                      variant="light"
                      radius="md"
                      className="min-w-0 px-2 text-foreground/65"
                      aria-label={`Reject ${agentLabel(k)}`}
                      isDisabled={isBusy}
                      isLoading={
                        typeof busy === "object" &&
                        busy !== null &&
                        busy.rejecting === k.keyId
                      }
                      onPress={() => void rejectRow(k)}
                    >
                      Reject
                    </Button>
                  )}
                </div>
              ))}
            </div>

            {actionError && <Notice title={actionError} />}

            <div className="flex gap-2.5">
              <Button
                color="primary"
                radius="md"
                size="md"
                className="flex-1 font-medium"
                isDisabled={isBusy || pending.length === 0}
                isLoading={busy === "approve"}
                onPress={() => void approveAll()}
                startContent={
                  busy === "approve" ? undefined : (
                    <Check className="h-3.5 w-3.5" />
                  )
                }
              >
                {pending.length === 0
                  ? "Nothing left to approve"
                  : pending.length === 1
                    ? "Approve agent"
                    : `Approve all ${pending.length}`}
              </Button>
              {pending.length > 1 && (
                <Button
                  variant="flat"
                  radius="md"
                  size="md"
                  isDisabled={isBusy}
                  isLoading={busy === "reject-all"}
                  onPress={() => void rejectAll()}
                >
                  Reject all
                </Button>
              )}
            </div>
          </>
        )}

        {step.kind === "done" && <DoneOutcome step={step} />}

        {step.kind === "load-error" && (
          <div className="flex flex-col gap-4">
            <Notice title="Couldn't load this request" detail={step.message} />
            {keyIds.length > 0 && (
              <Button
                color="primary"
                radius="md"
                size="md"
                className="font-medium"
                onPress={() => void load()}
              >
                Try again
              </Button>
            )}
          </div>
        )}
      </CardBody>
    </ReceiverShell>
  );
}

function DoneOutcome({ step }: { step: Extract<Step, { kind: "done" }> }) {
  const okCount = step.results.filter((r) => r.ok).length;
  const total = step.results.length;
  const allOk = okCount === total;
  const noneOk = okCount === 0;

  const title =
    step.action === "approve"
      ? allOk
        ? total === 1
          ? "Agent connected"
          : `${total} agents connected`
        : noneOk
          ? "No agents were connected"
          : `${okCount} of ${total} agents connected`
      : allOk
        ? total === 1
          ? "Agent rejected"
          : `${total} agents rejected`
        : `${okCount} of ${total} agents rejected`;

  const tone = allOk
    ? step.action === "approve"
      ? "success"
      : "muted"
    : noneOk
      ? "danger"
      : "warning";

  return (
    <div className="flex flex-col gap-3">
      <Outcome
        tone={tone}
        icon={
          allOk ? (
            step.action === "approve" ? (
              <Check className="h-6 w-6" strokeWidth={2.2} />
            ) : (
              <X className="h-6 w-6" strokeWidth={2.2} />
            )
          ) : (
            <AlertTriangle className="h-6 w-6" strokeWidth={2.2} />
          )
        }
        title={title}
        message={allOk ? CLOSE_TAB : "Reload this page to try the rest again."}
      />
      <div className="flex flex-col gap-2 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
        {step.results.map((r) => (
          <Row
            key={r.key.keyId}
            label={agentLabel(r.key)}
            value={resolveStatusLabel(r.token)}
          />
        ))}
      </div>
    </div>
  );
}

function Notice({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg bg-danger/10 px-3.5 py-3 ring-1 ring-inset ring-danger/30"
    >
      <X
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger"
        strokeWidth={2.2}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        {detail && (
          <p className="mt-0.5 text-[12.5px] text-foreground/65">{detail}</p>
        )}
      </div>
    </div>
  );
}

function KeyListSkeleton({ count }: { count: number }) {
  return (
    <div
      aria-busy
      aria-label="Loading agents"
      className="flex flex-col gap-3 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10"
    >
      {Array.from({ length: Math.max(1, Math.min(count, 4)) }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <Skeleton className="h-3 w-1/3 rounded-md" />
          <Skeleton className="h-3 w-1/4 rounded-md" />
        </div>
      ))}
    </div>
  );
}
