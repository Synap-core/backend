"use client";

/**
 * `/device` — the stateful flow: read the waiting computer by its code, hold
 * the person's choices, send the ONE decision. What each state looks like is
 * `DeviceViews`; what each state IS, and what a button sends, is
 * `device-model` (both tested).
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ReceiverShell } from "../_lib/receiver-shell";
import { formatRelative } from "../../lib/format";
import {
  approveDecision,
  decidedRead,
  defaultAgents,
  defaultComputerName,
  defaultReuseId,
  denyDecision,
  deviceReadFromError,
  deviceStage,
  formatCode,
  goneTitle,
  initialDeviceCode,
  isCompleteCode,
  type DeviceDecision,
  type DeviceRead,
  type DeviceRequest,
} from "./device-model";
import {
  ApprovedView,
  DeniedView,
  EnterCodeView,
  FailedView,
  GoneView,
  LoadingView,
  LockedView,
  PendingView,
} from "./DeviceViews";

const ago = (iso: string) => formatRelative(iso);

function toLogin(): void {
  const here = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?return=${encodeURIComponent(here)}`);
}

/** Read the request. A miss and a lock-out are answers; anything else failed. */
async function readDevice(code: string): Promise<DeviceRead> {
  let res: Response;
  try {
    res = await fetch(`/api/device?code=${encodeURIComponent(code)}`, {
      cache: "no-store",
    });
  } catch {
    return deviceReadFromError({});
  }
  const body = (await res.json().catch(() => ({}))) as {
    request?: DeviceRequest;
    error?: string;
  };
  if (res.status === 401) {
    toLogin();
    return { kind: "loading" };
  }
  if (res.ok && body.request) return { kind: "ok", request: body.request };
  return deviceReadFromError({
    status: res.ok ? 502 : res.status,
    message: body.error,
  });
}

/** Send the decision. Returns the pod's refusal, or null when it landed. */
export async function sendDecision(
  decision: DeviceDecision,
  post: typeof fetch = fetch
): Promise<string | null> {
  try {
    const res = await post("/api/device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decision),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `Error (${res.status})`;
  } catch {
    return "Could not reach this pod.";
  }
}

export function DeviceFlow({
  initialCode,
  podHost,
  identity,
}: {
  initialCode: string | null;
  podHost?: string;
  identity?: string;
}) {
  const router = useRouter();
  const [code, setCode] = useState<string | null>(
    initialDeviceCode(initialCode)
  );
  const [draft, setDraft] = useState(formatCode(initialCode ?? ""));
  const [read, setRead] = useState<DeviceRead>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  // The person's choices, seeded from the read.
  const [reuseId, setReuseId] = useState<string | null>(null);
  const [computerName, setComputerName] = useState("");
  const [agents, setAgents] = useState<string[]>([]);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let live = true;
    setRead({ kind: "loading" });
    void readDevice(code).then((r) => {
      if (!live) return;
      setRead(r);
      if (r.kind === "ok") {
        const reuse = defaultReuseId(r.request);
        setReuseId(reuse);
        setComputerName(defaultComputerName(r.request, reuse));
        setAgents(defaultAgents(r.request));
      }
    });
    return () => {
      live = false;
    };
  }, [code, attempt]);

  const enter = useCallback(
    (next: string | null) => {
      setCode(next);
      setError(null);
      setDraft(next ? formatCode(next) : "");
      router.replace(next ? `/device?code=${formatCode(next)}` : "/device");
    },
    [router]
  );

  const decide = useCallback(
    async (kind: "approve" | "deny") => {
      if (read.kind !== "ok" || !code) return;
      const decision =
        kind === "deny"
          ? denyDecision(read.request, code)
          : approveDecision(read.request, code, {
              agents,
              reuseComputerId: reuseId,
              computerName,
            });
      setBusy(kind);
      setError(null);
      const refused = await sendDecision(decision);
      setBusy(null);
      if (refused) {
        setError(refused);
        return;
      }
      setRead(decidedRead(read.request, kind));
    },
    [read, code, agents, reuseId, computerName]
  );

  const stage = deviceStage(code, read);
  const name =
    computerName.trim() || (read.kind === "ok" ? read.request.hostname : "");

  return (
    <ReceiverShell podHost={podHost} identity={identity} width="sm">
      {stage === "enter" && (
        <EnterCodeView
          value={draft}
          onChange={setDraft}
          complete={isCompleteCode(draft)}
          onSubmit={() => enter(draft)}
        />
      )}
      {stage === "loading" && <LoadingView />}
      {stage === "pending" && read.kind === "ok" && code && (
        <PendingView
          request={read.request}
          code={code}
          reuseId={reuseId}
          onReuse={(id) => {
            setReuseId(id);
            setComputerName(defaultComputerName(read.request, id));
          }}
          computerName={computerName}
          onComputerName={setComputerName}
          agents={agents}
          onAgents={setAgents}
          busy={busy}
          error={error}
          onApprove={() => void decide("approve")}
          onDeny={() => void decide("deny")}
          ago={ago}
        />
      )}
      {stage === "approved" && <ApprovedView name={name} />}
      {stage === "denied" && <DeniedView name={name} />}
      {stage === "gone" && (
        <GoneView title={goneTitle(read)} onEnterAnother={() => enter(null)} />
      )}
      {stage === "locked" && read.kind === "locked" && (
        <LockedView message={read.message} />
      )}
      {stage === "failed" && read.kind === "failed" && (
        <FailedView
          message={read.message}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      )}
    </ReceiverShell>
  );
}
