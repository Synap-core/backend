"use client";

/**
 * The agent-connect DECISION, shared by `/approve-agent/[keyId]` (the page a
 * `synap connect` session opens) and the console's Review drawer:
 *
 *   `useAgentConnect`      — reads what the pending key would be allowed to
 *                            do and the agent's other connections, and
 *                            decides through the pod's REST door
 *                            (`/setup/agent/pending/:keyId/{approve,reject}`),
 *                            the only door that takes "also disconnect".
 *   `AgentConnectDecision` — "It will be able to", the other connections
 *                            with their "Also disconnect" choice, and the
 *                            Approve / Reject verbs.
 *
 * Each host draws its own frame and its own outcome.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { Check } from "lucide-react";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { publicPodUrl } from "../../../lib/public-pod-url";
import {
  approveLabel,
  viewPendingAccess,
  type PendingAccess,
  type PendingAccessView,
} from "./pending-access";
import { PendingAccessBlock } from "./PendingAccessBlock";
import {
  approveBody,
  approvedOutcome,
  newerRequestHref,
  viewConnections,
  type ConnectionFacts,
  type ConnectionsView,
} from "./other-connections";
import { OtherConnectionsBlock } from "./OtherConnectionsBlock";

/** What the pending key would be allowed to do — read from the pod, never assumed. */
type DetailsRead =
  | { state: "loading" }
  | { state: "ok"; view: PendingAccessView; connections: ConnectionsView }
  | { state: "failed"; message: string };

export type AgentConnectStep =
  | { kind: "idle" }
  | { kind: "working"; action: "approve" | "reject" }
  | { kind: "approved"; outcome: { title: string; rows: string[] } }
  | { kind: "rejected" }
  | { kind: "error"; message: string };

export function useAgentConnect(keyId: string, agentType: string) {
  const [step, setStep] = useState<AgentConnectStep>({ kind: "idle" });
  const podUrl = useMemo(() => publicPodUrl(), []);
  const [details, setDetails] = useState<DetailsRead>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  // The agent's other connections the person chose to switch off too.
  const [chosen, setChosen] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    setDetails({ state: "loading" });
    fetch(`${podUrl}/api/hub/setup/agent/pending/${keyId}/details`, {
      credentials: "include",
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok)
          throw new Error(
            (body as { error?: string }).error || `Error (${res.status})`
          );
        if (live)
          setDetails({
            state: "ok",
            view: viewPendingAccess(body as PendingAccess),
            connections: viewConnections(body as ConnectionFacts),
          });
      })
      .catch((err) => {
        if (live)
          setDetails({
            state: "failed",
            message: err instanceof Error ? err.message : "Couldn't read",
          });
      });
    return () => {
      live = false;
    };
  }, [podUrl, keyId, attempt]);

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
            // Approving disconnects ONLY what the person ticked.
            body:
              action === "approve" && details.state === "ok"
                ? JSON.stringify(approveBody(details.connections, chosen))
                : undefined,
          }
        );
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(
            (detail as { error?: string }).error || `Error (${res.status})`
          );
        }
        setStep(
          action === "approve"
            ? {
                kind: "approved",
                // What this approval did, as the page offered it.
                outcome:
                  details.state === "ok"
                    ? approvedOutcome(details.connections, chosen)
                    : {
                        title: `${resolveServiceName(agentType)} connected`,
                        rows: [],
                      },
              }
            : { kind: "rejected" }
        );
      } catch (err) {
        setStep({
          kind: "error",
          message: err instanceof Error ? err.message : "Something went wrong",
        });
      }
    },
    [keyId, podUrl, details, chosen, agentType]
  );

  return {
    step,
    reset: () => setStep({ kind: "idle" }),
    details,
    retry: () => setAttempt((n) => n + 1),
    chosen,
    setChosen,
    act,
    connections: details.state === "ok" ? details.connections : null,
  };
}

export type AgentConnect = ReturnType<typeof useAgentConnect>;

/** What the key would be allowed to do, the other connections, and the verbs. */
export function AgentConnectDecision({
  agent,
  agentType,
}: {
  agent: AgentConnect;
  agentType: string;
}) {
  const { step, details, connections, chosen } = agent;
  const busy = step.kind === "working";
  const superseded = connections?.superseded === true;
  const disconnectCount = connections
    ? approveBody(connections, chosen).alsoDisconnect.length
    : 0;

  return (
    <>
      <div className="flex flex-col gap-2.5 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
        <p className="text-tiny font-medium uppercase tracking-wide text-foreground/65">
          It will be able to
        </p>
        {details.state === "loading" && (
          <p className="text-small text-foreground/65">Reading…</p>
        )}
        {details.state === "failed" && (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 text-small text-danger"
          >
            <span>Couldn&apos;t read what it asks for: {details.message}</span>
            <Button size="sm" variant="flat" onPress={agent.retry}>
              Retry
            </Button>
          </div>
        )}
        {details.state === "ok" && <PendingAccessBlock view={details.view} />}
      </div>

      {connections && (
        <OtherConnectionsBlock
          view={connections}
          chosen={chosen}
          onChosen={agent.setChosen}
          newerHref={newerRequestHref(connections, agentType)}
          isDisabled={busy}
        />
      )}

      <div className="flex flex-col gap-2.5 min-[400px]:flex-row">
        {/* A superseded request is never offered: its newer one is. */}
        {!superseded && (
          <Button
            color="primary"
            radius="md"
            size="md"
            // Stacked below 400px: full width, never a flex-basis-0
            // sliver of a column.
            className="w-full font-medium min-[400px]:w-auto min-[400px]:flex-1"
            // Never approve blind: wait until what it asks for is read.
            isDisabled={busy || details.state !== "ok"}
            isLoading={busy && step.action === "approve"}
            onPress={() => void agent.act("approve")}
            startContent={
              busy && step.action === "approve" ? undefined : (
                <Check className="h-3.5 w-3.5" />
              )
            }
          >
            {approveLabel(
              details.state === "ok" && details.view.full,
              1,
              disconnectCount
            )}
          </Button>
        )}
        <Button
          variant="flat"
          radius="md"
          size="md"
          className="w-full min-[400px]:w-auto min-[400px]:px-6"
          isDisabled={busy}
          isLoading={busy && step.action === "reject"}
          onPress={() => void agent.act("reject")}
        >
          Reject
        </Button>
      </div>
    </>
  );
}
