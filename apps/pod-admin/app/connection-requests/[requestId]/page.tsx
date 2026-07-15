"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
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

  const approve = trpc.applicationConnections.approveRequest.useMutation({
    onSuccess: async (data) => {
      // A reviewer may be a different owner/device than the requester. Only
      // the browser that successfully redeemed the native Pod sign-in holds
      // this Pod-Admin-origin marker, so an owner who merely approves stays
      // here rather than being pushed into the external application.
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
      await utils.applicationConnections.getReviewRequest.invalidate({
        requestId,
      });
      if (isRequesterBrowser) {
        // The URL contains only the public request correlation; completion
        // still requires the requester browser's opaque continuation.
        window.setTimeout(() => window.location.assign(data.returnUrl), 900);
      }
    },
    onError: () =>
      setActionError(
        "We couldn’t approve this request. Refresh and try again."
      ),
  });
  const reject = trpc.applicationConnections.rejectRequest.useMutation({
    onSuccess: async () => {
      setActionError(null);
      await utils.applicationConnections.getReviewRequest.invalidate({
        requestId,
      });
    },
    onError: () =>
      setActionError(
        "We couldn’t decline this request. Refresh and try again."
      ),
  });

  if (request.isLoading) return <Loading />;
  if (request.isError || !request.data) {
    return (
      <Frame>
        <Alert color="danger" title="We couldn’t open this connection request">
          It may have expired, already been completed, or this Pod account does
          not have access.
        </Alert>
      </Frame>
    );
  }

  const data = request.data;
  const canViewRequestDetails = data.canReview;
  const isPending =
    !approvedReturnUrl &&
    data.status === "pending" &&
    new Date(data.expiresAt) > new Date();
  const isWorking = approve.isPending || reject.isPending;
  const expiresAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(data.expiresAt));
  const statusLabel =
    data.status === "awaiting_local_auth"
      ? "Awaiting Pod sign-in"
      : data.status.charAt(0).toUpperCase() + data.status.slice(1);

  return (
    <Frame>
      <Card shadow="none" className="border border-foreground/10 bg-content1">
        <CardHeader className="flex-col items-start gap-1 px-6 pb-3 pt-6">
          <div className="flex w-full items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-foreground/50">
                Pod connection request
              </p>
              <h1 className="mt-2 text-xl font-semibold tracking-tight">
                {canViewRequestDetails
                  ? `Review ${data.displayName}`
                  : "Connection request ready"}
              </h1>
            </div>
            <Chip
              color={
                data.status === "approved"
                  ? "success"
                  : data.status === "pending"
                    ? "warning"
                    : "default"
              }
              variant="flat"
              size="sm"
            >
              {statusLabel}
            </Chip>
          </div>
          <p className="max-w-xl text-sm leading-6 text-foreground/65">
            {canViewRequestDetails
              ? "Review the external issuer and exact browser permission before changing this Pod’s trust configuration."
              : "Your local Pod sign-in prepared this request. A Pod owner or administrator must approve the external application; its registration details stay private to reviewers."}
          </p>
        </CardHeader>
        <Divider />
        <CardBody className="gap-5 px-6 py-5">
          {canViewRequestDetails ? (
            <>
              <Detail label="Application client" value={data.clientId} mono />
              <Detail label="Issuer" value={data.issuerUrl} mono />
              <Detail
                label="Browser origin"
                value={data.requestedOrigin}
                mono
              />
              <Detail
                label="Completion callback"
                value={data.requestedCallbackUrl}
                mono
              />
              <Detail
                label="Connection allows"
                value={applicationConnectionCapabilities(data.requestedScopes)}
              />
            </>
          ) : null}
          <Detail label="Request expires" value={expiresAt} />
          {canViewRequestDetails && data.publisherUrl ? (
            <Detail label="Publisher" value={data.publisherUrl} />
          ) : null}
          {canViewRequestDetails ? (
            <Alert
              color="warning"
              variant="flat"
              title="What approval means"
              startContent={<ShieldAlert size={18} />}
            >
              The Pod will register this exact issuer, client, browser origin,
              callback, and capabilities. It does not create membership, grant
              workspace or project access, or bind this reviewer&apos;s Pod
              account to an external identity. After approval, only the locally
              authenticated requester can complete a link between their external
              issuer identity and their existing Pod identity.
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
                : "The requesting browser can now finish the connection. You can stay in Pod Admin; the requester’s app will resume when it checks the request."}
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
          {!isPending && !approvedReturnUrl ? (
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
              description="Required only if you decline, so the requester knows what to change."
              value={reason}
              onValueChange={setReason}
              minRows={2}
              maxRows={4}
            />
          ) : null}
        </CardBody>
        {data.canReview && isPending ? (
          <>
            <Divider />
            <CardFooter className="justify-end gap-2 px-6 py-4">
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
                Approve connection
              </Button>
            </CardFooter>
          </>
        ) : null}
      </Card>
      {approvedReturnUrl ? (
        <div className="mt-4 flex justify-end">
          <Button
            color="primary"
            className="min-h-11"
            endContent={<ExternalLink size={16} />}
            onPress={() => window.location.assign(approvedReturnUrl)}
          >
            Open app in this browser
          </Button>
        </div>
      ) : null}
      <p className="mt-4 flex items-center gap-2 text-xs text-foreground/45">
        <ExternalLink size={13} />
        This Pod-owned review uses your local Pod session only. It does not
        expose a Pod session or external issuer token to the application.
      </p>
    </Frame>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-foreground/50">{label}</p>
      <p
        className={`mt-1 break-all text-sm text-foreground ${mono ? "font-mono text-[12px]" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-5 py-10">
      {children}
    </main>
  );
}

function Loading() {
  return (
    <Frame>
      <div className="flex w-full items-center justify-center gap-3 text-sm text-foreground/60">
        <Spinner size="sm" /> Loading Pod connection request…
      </div>
    </Frame>
  );
}
