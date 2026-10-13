"use client";

import { useEffect, useRef, useState } from "react";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { useParams, useRouter } from "next/navigation";
import {
  Alert,
  Button,
  CardBody,
  CardFooter,
  CardHeader,
  Chip,
  Divider,
  Spinner,
  Textarea,
} from "@heroui/react";
import { Check, ExternalLink, X } from "lucide-react";
import { ReceiverShell } from "../../_lib/receiver-shell";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import {
  ConnectionRequestDetails,
  matchesApprovedConnection,
  useConnectionRequest,
} from "./ConnectionRequestDecision";

interface ConnectionRequestReviewProps {
  /** The pod being asked for access. Anchors the page against phishing. */
  podHost?: string;
  /** Who the reader is signed in as, when known. */
  identity?: string;
}

export function ConnectionRequestReview({
  podHost,
  identity,
}: ConnectionRequestReviewProps) {
  const params = useParams<{ requestId: string }>();
  const requestId = params.requestId;
  const router = useRouter();
  const [approvedReturnUrl, setApprovedReturnUrl] = useState<string | null>(
    null
  );
  const [autoReturning, setAutoReturning] = useState(false);
  const [declined, setDeclined] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const review = useConnectionRequest(requestId, {
    onApproved: (data) => {
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
      if (isRequesterBrowser) {
        window.setTimeout(() => window.location.assign(data.returnUrl), 900);
      } else {
        // Owner reviewing from App origins: return to the inventory
        // after a short success beat so the page does not feel stuck.
        window.setTimeout(() => router.push("/origins"), 1_200);
      }
    },
    onRejected: () => {
      setDeclined(true);
      window.setTimeout(() => router.push("/origins"), 900);
    },
  });
  const { request } = review;

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
    // `closeReview` is stable enough for this page; the listener binds once.
  }, []);

  function closeReview() {
    router.push("/origins");
  }

  // Expired session → login (bring them back to this exact review), not a dead
  // "we couldn't open this request" error.
  useEffect(() => {
    if (request.isError) {
      redirectToLoginIfUnauthorized(request.error);
    }
  }, [request.isError, request.error, requestId]);
  const isAuthRedirecting = request.error?.data?.code === "UNAUTHORIZED";

  if (request.isLoading || isAuthRedirecting) return <Loading />;
  if (request.isError || !request.data) {
    return (
      // `sm`: nothing to read here, only one way out.
      <ReceiverShell podHost={podHost} identity={identity} width="sm">
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
              Back to App origins
            </Button>
          </div>
        </CardBody>
      </ReceiverShell>
    );
  }

  const data = request.data;
  const canViewRequestDetails = data.canReview;
  const isPending =
    !approvedReturnUrl && !declined && data.status === "pending";
  const isExpired = data.status === "expired";
  const matchingApproved = matchesApprovedConnection(data);
  const isWorking = review.isWorking;
  const statusLabel =
    data.status === "awaiting_local_auth"
      ? // Deliberately local: this is not the status's NAME, it is an
        // instruction to the reader about what the pod is waiting for. The
        // vocabulary rule keeps sentences like this out of the SSOT.
        "Awaiting Pod sign-in"
      : resolveStatusLabel(data.status);
  const chipColor =
    data.status === "approved" || matchingApproved
      ? "success"
      : data.status === "pending"
        ? "warning"
        : data.status === "rejected" || data.status === "expired"
          ? "danger"
          : "default";

  return (
    // `md`: this card renders an OBJECT with fields the reader must actually
    // read — origin, return URL, app id, issuer — before deciding.
    <ReceiverShell
      podHost={podHost}
      identity={identity}
      width="md"
      footer={
        <p className="text-xs text-foreground/65">
          This Pod-owned review uses your local Pod session only. It does not
          expose a Pod session or external issuer token to the application.
          Press Esc to close.
        </p>
      }
    >
      <CardHeader className="flex-col items-start gap-1 px-6 pb-3 pt-5">
        <div className="flex w-full items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-foreground/65">
              Browser origin request
            </p>
            <h1
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
        <ConnectionRequestDetails data={data} isPending={isPending} />

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

        {review.actionError ? (
          <Alert
            color="danger"
            title="Action couldn’t be completed"
            role="alert"
          >
            {review.actionError}
          </Alert>
        ) : null}

        {approvedReturnUrl ? (
          <Alert color="success" title="Connection approved" role="status">
            {autoReturning
              ? "Returning to the requesting app now so it can finish the connection."
              : "Approved. Returning to App origins. The requester’s browser can finish with Check connection."}
          </Alert>
        ) : null}

        {declined ? (
          <Alert color="default" title="Request declined" role="status">
            Returning to App origins.
          </Alert>
        ) : null}

        {!data.canReview ? (
          <Alert
            color="primary"
            variant="flat"
            title="A Pod owner or administrator must review this request"
          >
            You&apos;re signed in to the Pod, but only a Pod owner or
            administrator can approve an external application. Ask one to review
            it from Pod Console. Keep the requesting app available; it can
            resume after approval without sharing your Pod credentials.
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
            value={review.reason}
            onValueChange={review.setReason}
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
              isLoading={review.rejecting}
              isDisabled={isWorking || !review.canDecline}
              onPress={() => review.reject()}
            >
              Decline
            </Button>
            <Button
              color="primary"
              className="min-h-11"
              startContent={<Check size={16} />}
              isLoading={review.approving}
              isDisabled={isWorking}
              onPress={() => review.approve()}
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
    </ReceiverShell>
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
