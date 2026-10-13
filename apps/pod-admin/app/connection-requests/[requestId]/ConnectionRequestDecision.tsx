"use client";

/**
 * The app connection-request DECISION, shared by the
 * `/connection-requests/[requestId]` receiver and the console's Review drawer:
 *
 *   `useConnectionRequest`     — the request, Allow / Decline, the decline
 *                                reason and any action error. What happens
 *                                AFTER a decision is the host's: the receiver
 *                                sends a requester's browser back to its app
 *                                (`returnUrl`); the drawer only closes.
 *   `ConnectionRequestDetails` — the fields a reviewer must read before
 *                                deciding, and what approval means.
 */

import { useState } from "react";
import { Alert } from "@heroui/react";
import { ShieldAlert } from "lucide-react";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { applicationConnectionCapabilities } from "../../_lib/application-connection-capabilities";

export function useConnectionRequest(
  requestId: string,
  handlers: {
    onApproved: (result: { returnUrl: string }) => void | Promise<void>;
    onRejected: () => void | Promise<void>;
  }
) {
  const utils = trpc.useUtils();
  const request = trpc.applicationConnections.getReviewRequest.useQuery(
    { requestId },
    { enabled: Boolean(requestId), retry: false }
  );
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  async function refresh() {
    await Promise.all([
      utils.applicationConnections.getReviewRequest.invalidate({ requestId }),
      utils.applicationConnections.list.invalidate(),
      utils.signals.invalidate(),
    ]);
  }

  const approve = trpc.applicationConnections.approveRequest.useMutation({
    onSuccess: async (data) => {
      setActionError(null);
      await refresh();
      await handlers.onApproved(data);
    },
    onError: (error) => {
      if (redirectToLoginIfUnauthorized(error)) return;
      setActionError(
        error.message ||
          "We couldn’t approve this request. Refresh and try again."
      );
    },
  });
  const reject = trpc.applicationConnections.rejectRequest.useMutation({
    onSuccess: async () => {
      setActionError(null);
      await refresh();
      await handlers.onRejected();
    },
    onError: (error) => {
      if (redirectToLoginIfUnauthorized(error)) return;
      setActionError(
        error.message ||
          "We couldn’t decline this request. Refresh and try again."
      );
    },
  });

  return {
    request,
    approve: () => approve.mutate({ requestId }),
    /** Decline with `why`, or with the reason typed into this hook's field. */
    reject: (why: string = reason) =>
      reject.mutate({ requestId, reason: why.trim() }),
    approving: approve.isPending,
    rejecting: reject.isPending,
    isWorking: approve.isPending || reject.isPending,
    reason,
    setReason,
    /** A decline needs a reason the requester can act on (≥ 3 characters). */
    canDecline: reason.trim().length >= 3,
    actionError,
  };
}

export type ConnectionRequestData = NonNullable<
  ReturnType<typeof useConnectionRequest>["request"]["data"]
>;

/** The origin is already allowed for this app (owners only). */
export function matchesApprovedConnection(data: ConnectionRequestData) {
  return Boolean(
    (data as { matchingApprovedConnection?: boolean })
      .matchingApprovedConnection
  );
}

/** "12 Oct 2026, 17:46" — when the request's handoff lease ends. */
export function requestExpiry(data: ConnectionRequestData): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(data.expiresAt));
}

/**
 * What the reviewer must read before deciding — origin, return URL, app id,
 * issuer — and, while the request is pending, what approving means. A member
 * who may not review sees only when it expires.
 */
export function ConnectionRequestDetails({
  data,
  isPending,
}: {
  data: ConnectionRequestData;
  isPending: boolean;
}) {
  const expiresAt = requestExpiry(data);
  if (!data.canReview)
    return <Detail label="Request expires" value={expiresAt} />;
  return (
    <>
      <dl className="grid gap-4 sm:grid-cols-2">
        <Detail
          label="Browser origin (required decision)"
          value={data.requestedOrigin}
          mono
        />
        <Detail label="Return URL" value={data.requestedCallbackUrl} mono />
        <Detail label="App id" value={data.clientId} mono />
        <Detail
          label="Identity provider (separate Trust plane)"
          value={data.issuerUrl}
          mono
        />
        <Detail
          className="sm:col-span-2"
          label="Notes at registration"
          value={applicationConnectionCapabilities(data.requestedScopes)}
        />
        <Detail label="Request expires" value={expiresAt} />
        {data.publisherUrl ? (
          <Detail label="Publisher" value={data.publisherUrl} />
        ) : null}
      </dl>
      {isPending ? (
        <Alert
          color="warning"
          variant="flat"
          title="What approval means"
          startContent={<ShieldAlert size={18} />}
        >
          Approving adds this browser origin to the Pod allowlist so the site
          may call the Pod API (CORS). It does not create membership or grant
          workspace access. The identity provider listed above is managed under
          Trust &amp; Keys; approving here may also ensure that provider is
          registered so sign-in tokens can be verified.
        </Alert>
      ) : null}
    </>
  );
}

function Detail({
  label,
  value,
  mono = false,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium text-foreground/65">{label}</dt>
      <dd
        className={`mt-1 break-all text-sm text-foreground ${mono ? "font-mono text-[12px] leading-5" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}
