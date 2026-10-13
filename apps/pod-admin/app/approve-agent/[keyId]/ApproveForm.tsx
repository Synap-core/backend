"use client";

import { ReceiverShell } from "../../_lib/receiver-shell";
import { Button, CardBody, CardHeader } from "@heroui/react";
import { Bot, Check, Laptop, X } from "lucide-react";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { AgentConnectDecision, useAgentConnect } from "./AgentConnectDecision";

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
  const agent = useAgentConnect(keyId, agentType);
  const { step, connections } = agent;
  const agentName = resolveServiceName(agentType);

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
          <p className="text-tiny font-semibold uppercase tracking-wide text-foreground/65">
            Agent access request
          </p>
          <h1 className="font-heading text-2xl font-medium leading-tight tracking-tight text-foreground">
            {step.kind === "approved"
              ? step.outcome.title
              : `Approve ${connections?.title ?? agentName}`}
          </h1>
          {step.kind !== "approved" && connections?.requested ? (
            <p className="text-tiny text-foreground/65">
              {connections.requested}
            </p>
          ) : null}
          {step.kind !== "approved" && (
            <p className="text-small leading-relaxed text-foreground/65">
              A{" "}
              <code className="font-mono text-foreground/80">
                synap connect
              </code>{" "}
              session wants to register{" "}
              <span className="font-medium text-foreground">{agentName}</span>{" "}
              as an agent on your pod.
            </p>
          )}
        </div>
      </CardHeader>

      <CardBody className="flex flex-col gap-5 px-7 pb-7 pt-5">
        {(step.kind === "idle" || step.kind === "working") && (
          <AgentConnectDecision agent={agent} agentType={agentType} />
        )}

        {step.kind === "approved" && (
          <div className="flex flex-col gap-3">
            <Outcome
              tone="success"
              icon={<Check className="h-6 w-6" strokeWidth={2.2} />}
              title="Approved"
              message="You can close this tab. Your terminal will carry on."
            />
            {step.outcome.rows.length > 0 && (
              <div className="flex flex-col gap-2 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
                {step.outcome.rows.map((row) => (
                  <p
                    key={row}
                    className="flex items-center gap-1.5 text-small text-foreground/85"
                  >
                    <Laptop
                      aria-hidden
                      className="h-3.5 w-3.5 shrink-0 text-foreground/65"
                    />
                    <span className="min-w-0 truncate" title={row}>
                      {row}
                    </span>
                  </p>
                ))}
              </div>
            )}
          </div>
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
                <p className="text-small font-medium text-foreground">
                  Couldn&apos;t process the request
                </p>
                <p className="mt-0.5 text-small text-foreground/65">
                  {step.message}
                </p>
              </div>
            </div>
            <Button
              color="primary"
              radius="md"
              size="md"
              className="font-medium"
              onPress={agent.reset}
            >
              Try again
            </Button>
          </div>
        )}
      </CardBody>
    </ReceiverShell>
  );
}

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-small">
      <span className="text-foreground/65">{label}</span>
      <span className="text-foreground/85">{value}</span>
    </div>
  );
}

export function Outcome({
  tone,
  icon,
  title,
  message,
}: {
  tone: "success" | "muted" | "warning" | "danger";
  icon: React.ReactNode;
  title: string;
  message: string;
}) {
  const ring =
    tone === "success"
      ? "bg-success/10 ring-success/20 text-success"
      : tone === "warning"
        ? "bg-warning/10 ring-warning/30 text-warning"
        : tone === "danger"
          ? "bg-danger/10 ring-danger/30 text-danger"
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
        <p className="text-medium font-medium text-foreground">{title}</p>
        <p className="max-w-[18rem] text-small text-foreground/65">{message}</p>
      </div>
    </div>
  );
}
