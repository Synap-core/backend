"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ReceiverShell } from "../_lib/receiver-shell";
import { Button, CardBody, CardHeader } from "@heroui/react";
import { Bot, Check, X } from "lucide-react";
import { publicPodUrl } from "../../lib/public-pod-url";
import { Outcome, Row } from "../approve-agent/[keyId]/ApproveForm";

interface PendingKey {
  keyId: string;
  status: "pending" | "active" | "rejected" | "not_found" | "forbidden";
  keyName?: string;
  agentType?: string | null;
  agentName?: string | null;
  instanceId?: string | null;
}

type Step =
  | { kind: "loading" }
  | { kind: "ready"; keys: PendingKey[] }
  | { kind: "working"; keys: PendingKey[] }
  | { kind: "approved"; count: number }
  | { kind: "error"; message: string; keys?: PendingKey[] };

interface ApproveBatchFormProps {
  keyIds: string[];
  podHost?: string;
  identity?: string;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Cross-subdomain (pod-admin.<root> → pod.<root>) — send the Kratos cookie.
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error || `Error (${res.status})`
    );
  }
  return data;
}

export function ApproveBatchForm({
  keyIds,
  podHost,
  identity,
}: ApproveBatchFormProps) {
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const podUrl = useMemo(() => publicPodUrl(), []);

  const load = useCallback(async () => {
    if (keyIds.length === 0) {
      setStep({ kind: "error", message: "This link names no agent keys." });
      return;
    }
    setStep({ kind: "loading" });
    try {
      const data = (await postJson(
        `${podUrl}/api/hub/setup/agent/pending/lookup`,
        { keyIds }
      )) as { keys: PendingKey[] };
      setStep({ kind: "ready", keys: data.keys });
    } catch (err) {
      setStep({
        kind: "error",
        message: err instanceof Error ? err.message : "Something went wrong",
      });
    }
  }, [keyIds, podUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending =
    step.kind === "ready" || step.kind === "working"
      ? step.keys.filter((k) => k.status === "pending")
      : [];

  const approveAll = useCallback(async () => {
    if (step.kind !== "ready") return;
    const keys = step.keys;
    setStep({ kind: "working", keys });
    try {
      const data = (await postJson(
        `${podUrl}/api/hub/setup/agent/pending/approve-batch`,
        {
          keyIds: keys
            .filter((k) => k.status === "pending")
            .map((k) => k.keyId),
        }
      )) as { approved: number };
      setStep({ kind: "approved", count: data.approved });
    } catch (err) {
      setStep({
        kind: "error",
        message: err instanceof Error ? err.message : "Something went wrong",
        keys,
      });
    }
  }, [step, podUrl]);

  const busy = step.kind === "working";

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
        {step.kind === "loading" && (
          <p className="text-[13px] text-foreground/65">Loading…</p>
        )}

        {(step.kind === "ready" || step.kind === "working") && (
          <>
            <div className="flex flex-col gap-2.5 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
              {step.keys.map((k) => (
                <Row
                  key={k.keyId}
                  label={k.agentName ?? k.agentType ?? k.keyName ?? "Agent"}
                  value={
                    k.status === "pending"
                      ? (k.instanceId ?? `${k.keyId.slice(0, 8)}…`)
                      : k.status === "active"
                        ? "Already connected"
                        : k.status === "rejected"
                          ? "Rejected"
                          : k.status === "forbidden"
                            ? "Not yours to approve"
                            : "Not found"
                  }
                  mono={k.status === "pending" && !k.instanceId}
                />
              ))}
            </div>
            <Button
              color="primary"
              radius="md"
              size="md"
              className="font-medium"
              isDisabled={busy || pending.length === 0}
              isLoading={busy}
              onPress={approveAll}
              startContent={
                busy ? undefined : <Check className="h-3.5 w-3.5" />
              }
            >
              {pending.length === 0
                ? "Nothing left to approve"
                : `Approve ${pending.length === 1 ? "agent" : `all ${pending.length}`}`}
            </Button>
          </>
        )}

        {step.kind === "approved" && (
          <Outcome
            tone="success"
            icon={<Check className="h-6 w-6" strokeWidth={2.2} />}
            title={
              step.count === 1
                ? "Agent connected"
                : `${step.count} agents connected`
            }
            message="You can close this tab — the CLI will continue automatically."
          />
        )}

        {step.kind === "error" && (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-2.5 rounded-lg bg-danger/10 px-3.5 py-3 ring-1 ring-inset ring-danger/30">
              <X
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger"
                strokeWidth={2.2}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-foreground">
                  Couldn&apos;t process the request
                </p>
                <p className="mt-0.5 text-[12.5px] text-foreground/65">
                  {step.message}
                </p>
              </div>
            </div>
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
