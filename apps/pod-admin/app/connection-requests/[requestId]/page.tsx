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
import { Check, ExternalLink, ShieldAlert, ShieldCheck, X } from "lucide-react";
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
  const [approvedContinuationUrl, setApprovedContinuationUrl] = useState<
    string | null
  >(null);

  const approve = trpc.applicationConnections.approveRequest.useMutation({
    onSuccess: async (data) => {
      // A reviewer may be a different owner/device than the requester. The
      // callback is offered as a convenience, never claimed as the universal
      // completion path; the requester can also check their saved request.
      setApprovedContinuationUrl(data.continuationUrl);
      setActionError(null);
      await utils.applicationConnections.getReviewRequest.invalidate({
        requestId,
      });
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
    !approvedContinuationUrl &&
    data.status === "pending" &&
    new Date(data.expiresAt) > new Date();
  const isWorking = approve.isPending || reject.isPending;
  const expiresAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(data.expiresAt));

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
                  ? `${data.displayName} wants to connect`
                  : "An application needs approval"}
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
              {data.status}
            </Chip>
          </div>
          <p className="max-w-xl text-sm leading-6 text-foreground/65">
            {canViewRequestDetails
              ? "Review the issuer and exact callback below. Approving lets this app begin a federated sign-in journey from this approved browser origin. It never creates Pod membership or grants data beyond each signed-in person’s existing Pod access."
              : "A Pod owner or administrator must review the application details before it can connect. This page intentionally does not disclose another app’s registration details to ordinary members."}
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
              The Pod will remember this exact issuer, client, origin, and
              callback. That application must present its registered signed
              identifier for future sign-in and identity-link requests. Other
              applications and issuer-only flows keep their own approval
              boundaries. Access after sign-in still depends on the
              person&apos;s linked Pod identity and existing workspace or
              project membership.
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
          {approvedContinuationUrl ? (
            <Alert color="success" title="Connection approved" role="status">
              If you started this request in this browser, continue back to the
              app. Otherwise, the requester can return to their app and choose
              Check connection.
            </Alert>
          ) : null}
          {!data.canReview ? (
            <Alert
              color="primary"
              variant="flat"
              title="A Pod owner must review this request"
            >
              You&apos;re signed in, but only a Pod owner or administrator can
              approve an external application. Share this page with one of them.
            </Alert>
          ) : null}
          {!isPending && !approvedContinuationUrl ? (
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
              description="Optional for approval. Add a concise reason before declining so the requester understands what to change."
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
                className="min-h-10"
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
                className="min-h-10"
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
      {approvedContinuationUrl ? (
        <div className="mt-4 flex justify-end">
          <Button
            color="primary"
            className="min-h-10"
            endContent={<ExternalLink size={16} />}
            onPress={() => window.location.assign(approvedContinuationUrl)}
          >
            Continue to app
          </Button>
        </div>
      ) : null}
      <p className="mt-4 flex items-center gap-2 text-xs text-foreground/45">
        <ExternalLink size={13} />
        This review link is Pod-owned. It does not expose a Pod session or an
        issuer token.
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
