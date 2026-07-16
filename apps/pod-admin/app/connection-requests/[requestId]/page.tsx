"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Chip,
  Divider,
  Spinner,
  Textarea,
} from "@heroui/react";
import { Check, ExternalLink, ShieldAlert, X } from "lucide-react";
import { trpc } from "../../../lib/trpc";
import { applicationConnectionCapabilities } from "../../_lib/application-connection-capabilities";

export default function ConnectionRequestPage() {
  const params = useParams<{ requestId: string }>();
  const requestId = params.requestId;
  const router = useRouter();
  const utils = trpc.useUtils();
  const request = trpc.applicationConnections.getReviewRequest.useQuery(
    { requestId },
    { enabled: Boolean(requestId), retry: false }
  );
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [approvedReturnUrl, setApprovedReturnUrl] = useState<string | null>(
    null
  );
  const [autoReturning, setAutoReturning] = useState(false);
  const [declined, setDeclined] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!request.isLoading && request.data) {
      headingRef.current?.focus();
    }
  }, [request.data, request.isLoading, requestId]);

  // Esc closes the review surface (treat as a dismissible card, not a trap).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeReview();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeReview is stable enough for this page
  }, []);

  function closeReview() {
    router.push("/connections");
  }

  const approve = trpc.applicationConnections.approveRequest.useMutation({
    onSuccess: async (data) => {
      let isRequesterBrowser = false;
      try {
        isRequesterBrowser =
          window.sessionStorage.getItem(
            `application-connection-requester:${requestId}`
          ) === "1";
      } catch {
        // Safe default: never auto-navigate when browser storage is blocked.
      }
      setApprovedReturnUrl(data.returnUrl);
      setAutoReturning(isRequesterBrowser);
      setActionError(null);
      await Promise.all([
        utils.applicationConnections.getReviewRequest.invalidate({
          requestId,
        }),
        utils.applicationConnections.list.invalidate(),
      ]);
      if (isRequesterBrowser) {
        window.setTimeout(() => window.location.assign(data.returnUrl), 900);
      } else if (!isRequesterBrowser) {
        // Owner reviewing from Apps & Connections: return to the inventory
        // after a short success beat so the page does not feel stuck.
        window.setTimeout(() => router.push("/connections"), 1_200);
      }
    },
    onError: (error) =>
      setActionError(
        error.message ||
          "We couldn’t approve this request. Refresh and try again."
      ),
  });
  const reject = trpc.applicationConnections.rejectRequest.useMutation({
    onSuccess: async () => {
      setActionError(null);
      setDeclined(true);
      await Promise.all([
        utils.applicationConnections.getReviewRequest.invalidate({
          requestId,
        }),
        utils.applicationConnections.list.invalidate(),
      ]);
      window.setTimeout(() => router.push("/connections"), 900);
    },
    onError: (error) =>
      setActionError(
        error.message ||
          "We couldn’t decline this request. Refresh and try again."
      ),
  });

  if (request.isLoading) return <Loading />;
  if (request.isError || !request.data) {
    return (
      <Frame onDismiss={closeReview}>
        <Card
          shadow="none"
          className="w-full max-w-3xl border border-foreground/10 bg-content1"
        >
          <CardBody className="gap-4 p-6">
            <Alert
              color="danger"
              title="We couldn’t open this connection request"
            >
              It may have expired, already been completed, or this Pod account
              does not have access.
            </Alert>
            <div className="flex justify-end">
              <Button variant="flat" className="min-h-11" onPress={closeReview}>
                Back to Apps &amp; Connections
              </Button>
            </div>
          </CardBody>
        </Card>
      </Frame>
    );
  }

  const data = request.data;
  const canViewRequestDetails = data.canReview;
  const isPending =
    !approvedReturnUrl && !declined && data.status === "pending";
  const isExpired = data.status === "expired";
  const matchingApproved = Boolean(
    (data as { matchingApprovedConnection?: boolean })
      .matchingApprovedConnection
  );
  const isWorking = approve.isPending || reject.isPending;
  const expiresAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(data.expiresAt));
  const statusLabel =
    data.status === "awaiting_local_auth"
      ? "Awaiting Pod sign-in"
      : data.status.charAt(0).toUpperCase() + data.status.slice(1);
  const chipColor =
    data.status === "approved" || matchingApproved
      ? "success"
      : data.status === "pending"
        ? "warning"
        : data.status === "rejected" || data.status === "expired"
          ? "danger"
          : "default";

  return (
    <Frame onDismiss={closeReview}>
      <Card
        shadow="none"
        className="w-full max-w-3xl border border-foreground/10 bg-content1"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-request-title"
      >
        <CardHeader className="flex-col items-start gap-1 px-6 pb-3 pt-5">
          <div className="flex w-full items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-foreground/50">
                Browser origin request
              </p>
              <h1
                id="connection-request-title"
                ref={headingRef}
                tabIndex={-1}
                className="mt-1.5 text-xl font-semibold tracking-tight outline-none"
              >
                {canViewRequestDetails
                  ? `Allow ${data.displayName}?`
                  : "Origin request ready"}
              </h1>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Chip color={chipColor} variant="flat" size="sm">
                {matchingApproved && data.status !== "approved"
                  ? "Origin already allowed"
                  : statusLabel}
              </Chip>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                aria-label="Close review"
                className="min-h-9 min-w-9"
                onPress={closeReview}
              >
                <X size={16} />
              </Button>
            </div>
          </div>
          <p className="max-w-2xl text-sm leading-6 text-foreground/65">
            {canViewRequestDetails
              ? "Decide whether this exact website address may call this Pod. This is CORS / transport admission only — not membership, and not the same as Trust & Keys (JWT issuers)."
              : "Your local Pod sign-in prepared this request. A Pod owner must allow this browser origin; details stay private to reviewers."}
          </p>
        </CardHeader>
        <Divider />
        <CardBody className="gap-4 px-6 py-4">
          {canViewRequestDetails ? (
            <dl className="grid gap-4 sm:grid-cols-2">
              <Detail
                label="Browser origin (required decision)"
                value={data.requestedOrigin}
                mono
              />
              <Detail
                label="Return URL"
                value={data.requestedCallbackUrl}
                mono
              />
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
          ) : (
            <Detail label="Request expires" value={expiresAt} />
          )}

          {canViewRequestDetails && isPending ? (
            <Alert
              color="warning"
              variant="flat"
              title="What approval means"
              startContent={<ShieldAlert size={18} />}
            >
              Approving adds this browser origin to the Pod allowlist so the
              site may call the Pod API (CORS). It does not create membership or
              grant workspace access. The identity provider listed above is
              managed under Trust &amp; Keys; approving here may also ensure
              that provider is registered so sign-in tokens can be verified.
            </Alert>
          ) : null}

          {matchingApproved && !isPending && data.status !== "approved" ? (
            <Alert
              color="success"
              variant="flat"
              title="This browser origin is already allowed"
              role="status"
            >
              This origin is already on the allowlist for this app. Ask the
              requester to return to the application and choose{" "}
              <strong>Check connection</strong> — no new origin approval is
              required.
            </Alert>
          ) : null}

          {actionError ? (
            <Alert
              color="danger"
              title="Action couldn’t be completed"
              role="alert"
            >
              {actionError}
            </Alert>
          ) : null}

          {approvedReturnUrl ? (
            <Alert color="success" title="Connection approved" role="status">
              {autoReturning
                ? "Returning to the requesting app now so it can finish the connection."
                : "Approved. Returning to Apps & Connections. The requester’s browser can finish with Check connection."}
            </Alert>
          ) : null}

          {declined ? (
            <Alert color="default" title="Request declined" role="status">
              Returning to Apps &amp; Connections.
            </Alert>
          ) : null}

          {!data.canReview ? (
            <Alert
              color="primary"
              variant="flat"
              title="A Pod owner or administrator must review this request"
            >
              You&apos;re signed in to the Pod, but only a Pod owner or
              administrator can approve an external application. Ask one to
              review it from Pod Admin. Keep the requesting app available; it
              can resume after approval without sharing your Pod credentials.
            </Alert>
          ) : null}

          {isExpired && !matchingApproved && !approvedReturnUrl ? (
            <Alert color="default" variant="flat" title="This request expired">
              Approval requests are short-lived. Ask the application to start a
              fresh connection request, then review that new entry here.
            </Alert>
          ) : null}

          {!isPending &&
          !approvedReturnUrl &&
          !declined &&
          !isExpired &&
          data.status !== "approved" &&
          !matchingApproved ? (
            <Alert
              color="default"
              variant="flat"
              title="This request is no longer awaiting approval"
            >
              {data.decisionReason ||
                "Create a new request from the application if you still need to connect."}
            </Alert>
          ) : null}

          {data.canReview && isPending ? (
            <Textarea
              label="Reason if declining"
              description="Required only if you decline (at least 3 characters), so the requester knows what to change."
              value={reason}
              onValueChange={setReason}
              minRows={2}
              maxRows={3}
              isDisabled={isWorking}
            />
          ) : null}
        </CardBody>
        <Divider />
        <CardFooter className="flex flex-wrap justify-end gap-2 px-6 py-4">
          <Button
            variant="flat"
            className="min-h-11"
            isDisabled={isWorking}
            onPress={closeReview}
          >
            Close
          </Button>
          {data.canReview && isPending ? (
            <>
              <Button
                color="danger"
                variant="flat"
                className="min-h-11"
                startContent={<X size={16} />}
                isLoading={reject.isPending}
                isDisabled={isWorking || reason.trim().length < 3}
                onPress={() =>
                  reject.mutate({ requestId, reason: reason.trim() })
                }
              >
                Decline
              </Button>
              <Button
                color="primary"
                className="min-h-11"
                startContent={<Check size={16} />}
                isLoading={approve.isPending}
                isDisabled={isWorking}
                onPress={() => approve.mutate({ requestId })}
              >
                Allow this origin
              </Button>
            </>
          ) : null}
          {approvedReturnUrl && autoReturning ? (
            <Button
              color="primary"
              className="min-h-11"
              endContent={<ExternalLink size={16} />}
              onPress={() => window.location.assign(approvedReturnUrl)}
            >
              Open app in this browser
            </Button>
          ) : null}
        </CardFooter>
      </Card>
      <p className="mt-3 max-w-3xl text-center text-xs text-foreground/45">
        This Pod-owned review uses your local Pod session only. It does not
        expose a Pod session or external issuer token to the application. Click
        outside the card or press Esc to close.
      </p>
    </Frame>
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
      <dt className="text-xs font-medium text-foreground/50">{label}</dt>
      <dd
        className={`mt-1 break-all text-sm text-foreground ${mono ? "font-mono text-[12px] leading-5" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

function Frame({
  children,
  onDismiss,
}: {
  children: React.ReactNode;
  onDismiss: () => void;
}) {
  return (
    <main className="relative flex min-h-screen w-full items-center justify-center px-4 py-8">
      {/* Backdrop — outside click closes the review surface */}
      <button
        type="button"
        aria-label="Close connection request review"
        className="absolute inset-0 cursor-default bg-background/80"
        onClick={onDismiss}
      />
      <div className="relative z-10 flex w-full max-w-3xl flex-col items-center">
        {children}
      </div>
    </main>
  );
}

function Loading() {
  return (
    <main className="flex min-h-screen w-full items-center justify-center px-5 py-10">
      <div className="flex items-center justify-center gap-3 text-sm text-foreground/60">
        <Spinner size="sm" /> Loading Pod connection request…
      </div>
    </main>
  );
}
