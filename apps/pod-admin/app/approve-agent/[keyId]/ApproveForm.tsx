"use client";

import { useCallback, useMemo, useState } from "react";
import { ReceiverShell } from "../../_lib/receiver-shell";
import { Button, CardBody, CardHeader } from "@heroui/react";
import { Bot, Check, ShieldCheck, X } from "lucide-react";
import { publicPodUrl } from "../../../lib/public-pod-url";

const SCOPES = [
  "hub-protocol.read",
  "hub-protocol.write",
  "mcp.read",
  "mcp.write",
];

type Step =
  | { kind: "idle" }
  | { kind: "working"; action: "approve" | "reject" }
  | { kind: "approved" }
  | { kind: "rejected" }
  | { kind: "error"; message: string };

interface ApproveFormProps {
  podHost?: string;
  identity?: string;
  keyId: string;
  agentType: string;
}

export function ApproveForm({
  keyId,
  agentType,
  podHost,
  identity,
}: ApproveFormProps) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const podUrl = useMemo(() => publicPodUrl(), []);

  const act = useCallback(
    async (action: "approve" | "reject") => {
      setStep({ kind: "working", action });
      try {
        const res = await fetch(
          `${podUrl}/api/hub/setup/agent/pending/${keyId}/${action}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Cross-subdomain (pod-admin.<root> → pod.<root>) — send the
            // parent-domain Kratos cookie so resolveKratosSession() passes.
            credentials: "include",
          }
        );
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(
            (detail as { error?: string }).error || `Error (${res.status})`
          );
        }
        setStep({ kind: action === "approve" ? "approved" : "rejected" });
      } catch (err) {
        setStep({
          kind: "error",
          message: err instanceof Error ? err.message : "Something went wrong",
        });
      }
    },
    [keyId]
  );

  const busy = step.kind === "working";

  return (
    <ReceiverShell podHost={podHost} identity={identity} width="sm">
      <CardHeader className="flex flex-col items-start gap-3 px-7 pt-7 pb-0">
        <span
          aria-hidden
          className="
              flex h-11 w-11 items-center justify-center
              rounded-lg
              bg-primary/10 ring-1 ring-inset ring-primary/20
              text-primary
            "
        >
          <Bot className="h-5 w-5" strokeWidth={2} />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/45">
            Agent access request
          </p>
          <h1 className="font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
            Approve {agentType}
          </h1>
          <p className="text-[13px] leading-relaxed text-foreground/65">
            A{" "}
            <code className="font-mono text-foreground/80">synap connect</code>{" "}
            session wants to register{" "}
            <span className="font-medium text-foreground">{agentType}</span> as
            an agent on your pod.
          </p>
        </div>
      </CardHeader>

      <CardBody className="flex flex-col gap-5 px-7 pb-7 pt-5">
        {(step.kind === "idle" || step.kind === "working") && (
          <>
            <div className="flex flex-col gap-2.5 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
              <Row label="Surface" value={agentType} />
              <Row label="Key ID" value={`${keyId.slice(0, 8)}…`} mono />
              <div className="pt-1.5">
                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/45">
                  <ShieldCheck className="h-3 w-3" /> Scopes granted
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {SCOPES.map((s) => (
                    <span
                      key={s}
                      className="rounded-md bg-foreground/[0.05] px-2 py-0.5 font-mono text-[11px] text-foreground/70 ring-1 ring-inset ring-foreground/10"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-2.5">
              <Button
                color="primary"
                radius="md"
                size="md"
                className="flex-1 font-medium"
                isDisabled={busy}
                isLoading={busy && step.action === "approve"}
                onPress={() => act("approve")}
                startContent={
                  busy && step.action === "approve" ? undefined : (
                    <Check className="h-3.5 w-3.5" />
                  )
                }
              >
                Approve
              </Button>
              <Button
                variant="flat"
                radius="md"
                size="md"
                className="flex-1"
                isDisabled={busy}
                isLoading={busy && step.action === "reject"}
                onPress={() => act("reject")}
              >
                Reject
              </Button>
            </div>
          </>
        )}

        {step.kind === "approved" && (
          <Outcome
            tone="success"
            icon={<Check className="h-6 w-6" strokeWidth={2.2} />}
            title="Approved"
            message="You can close this tab — the CLI will continue automatically."
          />
        )}

        {step.kind === "rejected" && (
          <Outcome
            tone="muted"
            icon={<X className="h-6 w-6" strokeWidth={2.2} />}
            title="Rejected"
            message="The agent key was revoked. You can close this tab."
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
            <Button
              color="primary"
              radius="md"
              size="md"
              className="font-medium"
              onPress={() => setStep({ kind: "idle" })}
            >
              Try again
            </Button>
          </div>
        )}
      </CardBody>
    </ReceiverShell>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-[13px]">
      <span className="text-foreground/45">{label}</span>
      <span
        className={`text-foreground/85 ${mono ? "font-mono text-[12px]" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function Outcome({
  tone,
  icon,
  title,
  message,
}: {
  tone: "success" | "muted";
  icon: React.ReactNode;
  title: string;
  message: string;
}) {
  const ring =
    tone === "success"
      ? "bg-success/10 ring-success/20 text-success"
      : "bg-foreground/[0.06] ring-foreground/15 text-foreground/60";
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <span
        aria-hidden
        className={`flex h-12 w-12 items-center justify-center rounded-full ring-1 ring-inset ${ring}`}
      >
        {icon}
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-[14px] font-medium text-foreground">{title}</p>
        <p className="max-w-[18rem] text-[12.5px] text-foreground/65">
          {message}
        </p>
      </div>
    </div>
  );
}
