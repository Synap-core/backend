"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, CardBody, Chip, Spinner } from "@heroui/react";
import {
  ChevronDown,
  ExternalLink,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { ConfirmModal } from "../components/confirm-modal";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { applicationConnectionCapabilities } from "../../_lib/application-connection-capabilities";

function statusColor(
  status: string
): "success" | "warning" | "danger" | "default" {
  if (status === "approved") return "success";
  if (status === "pending") return "warning";
  if (status === "rejected" || status === "revoked") return "danger";
  return "default";
}

/**
 * Human label for a connection-request status.
 *
 * The status WORD comes from the SSOT, because the other half of this same
 * flow — `/connection-requests/[requestId]` — already resolves these through
 * `resolveStatusLabel`. Until 2026-09-06 this switch spelled `pending` as
 * "needs review" and `rejected` as "declined" while that page said "Pending"
 * and "Rejected": two words for one status, in the two halves of one flow,
 * which is exactly what `.claude/rules/vocabulary.md` exists to stop.
 *
 * Two entries keep local phrasing on purpose, because they carry information
 * the status alone does not:
 *   • `awaiting_local_auth` names WHAT is being waited on, not a lifecycle
 *     state — the reader has to know the app must finish the handshake.
 *   • `approved` here is approved-but-not-yet-complete. Flattening it to
 *     "Approved" would tell the operator the flow finished when it has not.
 * Both append to the SSOT word rather than replacing it, so the vocabulary
 * still governs the status and only the nuance is local.
 */
function requestStateLabel(status: string): string {
  if (status === "awaiting_local_auth") return "waiting for the app";
  if (status === "approved") return `${resolveStatusLabel(status)} · finishing`;
  return resolveStatusLabel(status);
}

export default function ApplicationConnectionsPage() {
  const connections = trpc.applicationConnections.list.useQuery();
  const utils = trpc.useUtils();
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<{
    id: string;
    displayName: string;
  } | null>(null);
  const revoke = trpc.applicationConnections.revokeConnection.useMutation({
    onSuccess: async () => {
      setRevokeError(null);
      setPendingRevoke(null);
      await utils.applicationConnections.list.invalidate();
    },
    onError: () => {
      setPendingRevoke(null);
      setRevokeError(
        "We couldn't revoke this app connection. Refresh and try again."
      );
    },
  });

  /* Was a native `window.confirm`. The consequence copy below is the reason
     this needed a real modal: it has to say what revoking does AND what it
     pointedly does not, and an OS dialog renders that as one grey wall. */
  function confirmRevoke(connection: { id: string; displayName: string }) {
    setPendingRevoke(connection);
  }

  // Expired session → login, not a dead "couldn't load" error.
  useEffect(() => {
    if (connections.isError) {
      redirectToLoginIfUnauthorized(connections.error, "/connections");
    }
  }, [connections.isError, connections.error]);
  const isAuthRedirecting = connections.error?.data?.code === "UNAUTHORIZED";

  if (connections.isLoading || isAuthRedirecting) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner label="Loading application connections" />
      </div>
    );
  }
  if (connections.isError) {
    return (
      <div className="px-6 py-6" role="alert">
        <p className="text-sm text-danger">
          Couldn&apos;t load application connections. Try again.
        </p>
        <Button
          size="sm"
          variant="flat"
          className="mt-3 min-h-10"
          isLoading={connections.isFetching}
          onPress={() => void connections.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  const data = connections.data;
  const requests = data?.requests ?? [];
  const conns = data?.connections ?? [];
  // Ordered by what the owner cares about most, top to bottom:
  // 1. what's working, 2. what needs YOU now, 3. what's mid-flight, then the
  // archive (terminal/historical) collapsed at the bottom.
  const approvedOrigins = conns.filter((c) => c.status === "approved");
  const needsReview = requests.filter((r) => r.status === "pending");
  // The app started a handoff but the person hasn't finished signing in / the
  // app hasn't completed. Not owner-actionable — shown for visibility only.
  const inProgress = requests.filter(
    (r) =>
      r.status === "awaiting_local_auth" ||
      r.status === "approved" ||
      r.status === "completing"
  );
  // Archive: timed-out / declined / already-done requests + non-active
  // connection records. Kept for audit but tucked away.
  const archivedRequests = requests.filter(
    (r) =>
      r.status === "expired" ||
      r.status === "rejected" ||
      r.status === "completed"
  );
  const archivedConnections = conns.filter((c) => c.status !== "approved");
  const archiveCount = archivedRequests.length + archivedConnections.length;

  return (
    <div className="max-w-[1100px] px-6 py-6">
      <header className="mb-6 max-w-2xl">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          Apps &amp; Connections
        </h1>
        <p className="mt-1 text-[13px] leading-5 text-foreground/60">
          Allowlist which browser website addresses (origins) may call this Pod.
          By default no external site can reach the Pod API. Approving an origin
          is transport only — it does not grant data access or membership, and
          it is separate from Trusted issuers (who may sign identity tokens)
          under Trust &amp; Keys.
        </p>
        {revokeError ? (
          <p className="mt-3 text-sm text-danger" role="alert">
            {revokeError}
          </p>
        ) : null}
      </header>

      {/* 1 — What's working: approved browser origins, first. */}
      <section className="space-y-3" aria-labelledby="approved-connections">
        <div className="flex items-center justify-between gap-3">
          <h2
            id="approved-connections"
            className="text-sm font-medium text-foreground"
          >
            Approved browser origins
          </h2>
          <span className="text-xs text-foreground/50">
            {approvedOrigins.length}
          </span>
        </div>
        <p className="max-w-2xl text-xs leading-5 text-foreground/55">
          These website addresses may call this Pod from a browser. Each origin
          is exact (scheme + host + port). This is not data access — people
          still need membership. Identity providers are managed under Trust
          &amp; Keys.
        </p>
        {approvedOrigins.length === 0 ? (
          <EmptyState label="No external browser origins have been allowed yet." />
        ) : (
          approvedOrigins.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              onRevoke={() => confirmRevoke(connection)}
              isRevoking={
                revoke.isPending && revoke.variables?.id === connection.id
              }
            />
          ))
        )}
      </section>

      {/* 2 — What needs YOU now: pending requests to review & approve. */}
      {needsReview.length > 0 ? (
        <section className="mt-9 space-y-3" aria-labelledby="needs-review">
          <div className="flex items-center justify-between">
            <h2
              id="needs-review"
              className="text-sm font-medium text-foreground"
            >
              Needs your review
            </h2>
            <span className="text-xs text-foreground/50">
              {needsReview.length}
            </span>
          </div>
          <p className="max-w-2xl text-xs leading-5 text-foreground/55">
            An app is waiting for you to allow its website. Review the request,
            then approve or decline.
          </p>
          {needsReview.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              actionLabel="Review &amp; approve"
            />
          ))}
        </section>
      ) : null}

      {/* 3 — Mid-flight: app started but hasn't finished. Not owner-actionable. */}
      {inProgress.length > 0 ? (
        <section className="mt-9 space-y-3" aria-labelledby="in-progress">
          <div className="flex items-center justify-between">
            <h2
              id="in-progress"
              className="text-sm font-medium text-foreground"
            >
              In progress
            </h2>
            <span className="text-xs text-foreground/50">
              {inProgress.length}
            </span>
          </div>
          <p className="max-w-2xl text-xs leading-5 text-foreground/55">
            These apps started connecting but haven’t finished. There’s nothing
            to approve yet — finish from the app, and it’ll move up to “Needs
            your review” once it’s waiting on you.
          </p>
          {inProgress.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              actionLabel="View"
              badge={request.status}
            />
          ))}
        </section>
      ) : null}

      {/* 4 — Archive: terminal / historical, collapsed at the bottom. */}
      {archiveCount > 0 ? (
        <section className="mt-9 space-y-3" aria-labelledby="archive">
          <button
            type="button"
            onClick={() => setShowArchive((v) => !v)}
            aria-expanded={showArchive}
            className="flex w-full items-center justify-between gap-2 py-1 text-left"
          >
            <span
              id="archive"
              className="text-sm font-medium text-foreground/70"
            >
              Expired &amp; declined
            </span>
            <span className="flex items-center gap-2 text-xs text-foreground/50">
              {archiveCount}
              <ChevronDown
                size={15}
                className={
                  showArchive
                    ? "rotate-180 transition-transform"
                    : "transition-transform"
                }
              />
            </span>
          </button>
          {showArchive ? (
            <div className="space-y-3">
              <p className="max-w-2xl text-xs leading-5 text-foreground/55">
                Timed-out or declined requests and revoked origins, kept for
                audit. If an origin here is already approved above, the app just
                needs Check connection — not a new request.
              </p>
              {archivedRequests.map((request) => (
                <RequestRow
                  key={request.id}
                  request={request}
                  actionLabel="View"
                  badge={request.status}
                />
              ))}
              {archivedConnections.map((connection) => (
                <ConnectionCard key={connection.id} connection={connection} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <ConfirmModal
        isOpen={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        /* Deliberately does NOT close here. Closing in onConfirm unmounted the
           modal before the mutation resolved, so `isPending` could never
           render and the user got no sign the click landed on a network
           round-trip — on the one action the modal exists to slow down. The
           mutation's own onSuccess/onError closes it. */
        onConfirm={() => {
          if (!pendingRevoke) return;
          revoke.mutate({ id: pendingRevoke.id });
        }}
        title={`Revoke ${pendingRevoke?.displayName ?? "this app"}?`}
        consequence={
          <>
            <p>
              Its browser origins immediately lose permission to call this Pod.
            </p>
            <p className="mt-2 text-foreground/50">
              This does not remove people, revoke trusted issuers, or invalidate
              direct Pod sign-in sessions.
            </p>
          </>
        }
        confirmLabel="Revoke access"
        isPending={revoke.isPending}
      />
    </div>
  );
}

// The owner surface intentionally renders only durable connection-ledger
// fields; request secrets and personal Pod session details never belong here.
type ApplicationConnection = {
  id: string;
  clientId: string;
  displayName: string;
  publisherUrl: string | null;
  issuerUrl: string;
  allowedOrigins: string[];
  allowedCallbackUrls: string[];
  allowedScopes: string[];
  status: "pending" | "approved" | "rejected" | "revoked";
};

function ConnectionCard({
  connection,
  isRevoking = false,
  onRevoke,
}: {
  connection: ApplicationConnection;
  isRevoking?: boolean;
  onRevoke?: () => void;
}) {
  const canRevoke = connection.status === "approved" && onRevoke;
  return (
    <Card shadow="none" className="border border-foreground/10 bg-content1">
      <CardBody className="gap-5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">
              {connection.displayName}
            </p>
            {connection.publisherUrl ? (
              <a
                className="mt-1 block break-all text-xs text-primary underline-offset-2 hover:underline"
                href={connection.publisherUrl}
                target="_blank"
                rel="noreferrer"
              >
                {connection.publisherUrl}
              </a>
            ) : null}
          </div>
          <Chip size="sm" color={statusColor(connection.status)} variant="flat">
            {connection.status}
          </Chip>
        </div>

        <dl className="grid gap-4 md:grid-cols-2">
          <ConnectionList
            label="Allowed browser origins"
            values={connection.allowedOrigins}
          />
          <ConnectionList
            label="Allowed return URLs"
            values={connection.allowedCallbackUrls}
          />
          <ConnectionDetail label="App id" value={connection.clientId} />
          <ConnectionDetail
            label="Registered via (bootstrap only)"
            value={connection.issuerUrl}
          />
          <ConnectionDetail
            className="md:col-span-2"
            label="Optional capabilities noted at approval"
            value={applicationConnectionCapabilities(connection.allowedScopes)}
          />
        </dl>

        {canRevoke ? (
          <div className="pt-1">
            <Button
              color="danger"
              size="sm"
              className="min-h-10"
              variant="flat"
              startContent={<ShieldOff size={14} />}
              isLoading={isRevoking}
              onPress={onRevoke}
            >
              Revoke origins
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function ConnectionDetail({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium text-foreground/50">{label}</dt>
      <dd className="mt-1 break-all font-mono text-[12px] leading-5 text-foreground/75">
        {value}
      </dd>
    </div>
  );
}

function ConnectionList({
  label,
  values,
}: {
  label: string;
  values: string[];
}) {
  return (
    <div>
      <dt className="text-xs font-medium text-foreground/50">{label}</dt>
      <dd className="mt-1">
        <ul className="space-y-1.5">
          {values.map((value) => (
            <li
              key={value}
              className="break-all font-mono text-[12px] leading-5 text-foreground/75"
            >
              {value}
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-dashed border-foreground/15 px-4 py-5 text-sm text-foreground/55">
      <ShieldCheck size={17} className="shrink-0" />
      {label}
    </div>
  );
}

function RequestRow({
  request,
  actionLabel,
  badge,
}: {
  request: {
    id: string;
    displayName: string;
    issuerUrl: string;
    requestedOrigin: string;
    status: string;
  };
  actionLabel: string;
  badge?: string;
}) {
  return (
    <Card shadow="none" className="border border-foreground/10 bg-content1">
      <CardBody className="flex flex-row items-center justify-between gap-4 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">
              {request.displayName}
            </p>
            {badge ? (
              <Chip size="sm" variant="flat" color={statusColor(badge)}>
                {requestStateLabel(badge)}
              </Chip>
            ) : null}
          </div>
          <p className="mt-1 truncate font-mono text-xs text-foreground/55">
            {request.issuerUrl} · {request.requestedOrigin}
          </p>
        </div>
        <Button
          as={Link}
          href={`/connection-requests/${request.id}`}
          size="sm"
          className="min-h-10"
          variant="flat"
          endContent={<ExternalLink size={14} />}
        >
          {actionLabel}
        </Button>
      </CardBody>
    </Card>
  );
}
