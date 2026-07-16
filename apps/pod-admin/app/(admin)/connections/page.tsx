"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Card, CardBody, Chip, Spinner } from "@heroui/react";
import { ExternalLink, ShieldCheck, ShieldOff } from "lucide-react";
import { trpc } from "../../../lib/trpc";
import { applicationConnectionCapabilities } from "../../_lib/application-connection-capabilities";

function statusColor(
  status: string
): "success" | "warning" | "danger" | "default" {
  if (status === "approved") return "success";
  if (status === "pending") return "warning";
  if (status === "rejected" || status === "revoked") return "danger";
  return "default";
}

export default function ApplicationConnectionsPage() {
  const connections = trpc.applicationConnections.list.useQuery();
  const utils = trpc.useUtils();
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const revoke = trpc.applicationConnections.revokeConnection.useMutation({
    onSuccess: async () => {
      setRevokeError(null);
      await utils.applicationConnections.list.invalidate();
    },
    onError: () =>
      setRevokeError(
        "We couldn’t revoke this app connection. Refresh and try again."
      ),
  });

  function confirmRevoke(connection: { id: string; displayName: string }) {
    if (
      !window.confirm(
        `Revoke ${connection.displayName}? Those browser origins will immediately lose permission to call this Pod. This does not remove people, revoke trusted issuers, or invalidate direct Pod sign-in sessions.`
      )
    ) {
      return;
    }
    revoke.mutate({ id: connection.id });
  }

  if (connections.isLoading) {
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
  // Backend list already applies effective (expiry-aware) status.
  const pendingRequests = (data?.requests ?? []).filter(
    (request) => request.status === "pending"
  );
  const expiredRequests = (data?.requests ?? []).filter(
    (request) => request.status === "expired"
  );
  const otherRequests = (data?.requests ?? []).filter(
    (request) =>
      request.status !== "pending" &&
      request.status !== "expired" &&
      request.status !== "approved" &&
      request.status !== "completed"
  );
  const activeConnections = (data?.connections ?? []).filter(
    (connection) => connection.status === "approved"
  );
  const revokedConnections = (data?.connections ?? []).filter(
    (connection) => connection.status === "revoked"
  );
  // These records are not created by the current approval flow, but keep an
  // unexpected legacy state visible to an owner rather than silently hiding it.
  const otherConnections = (data?.connections ?? []).filter(
    (connection) =>
      connection.status !== "approved" && connection.status !== "revoked"
  );

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

      <section className="space-y-3" aria-labelledby="pending-requests">
        <div className="flex items-center justify-between">
          <h2
            id="pending-requests"
            className="text-sm font-medium text-foreground"
          >
            Pending requests
          </h2>
          <span className="text-xs text-foreground/50">
            {pendingRequests.length}
          </span>
        </div>
        {pendingRequests.length === 0 ? (
          <EmptyState label="No application requests are waiting for review." />
        ) : (
          pendingRequests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              actionLabel="Review"
            />
          ))
        )}
      </section>

      {expiredRequests.length > 0 ? (
        <section className="mt-9 space-y-3" aria-labelledby="expired-requests">
          <div className="flex items-center justify-between">
            <h2
              id="expired-requests"
              className="text-sm font-medium text-foreground"
            >
              Expired requests
            </h2>
            <span className="text-xs text-foreground/50">
              {expiredRequests.length}
            </span>
          </div>
          <p className="max-w-2xl text-xs leading-5 text-foreground/55">
            These origin-approval handoffs timed out. If this origin is already
            under Approved browser origins, the app only needs Check connection
            — not another request.
          </p>
          {expiredRequests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              actionLabel="View"
              badge="expired"
            />
          ))}
        </section>
      ) : null}

      {otherRequests.length > 0 ? (
        <section className="mt-9 space-y-3" aria-labelledby="other-requests">
          <div className="flex items-center justify-between">
            <h2
              id="other-requests"
              className="text-sm font-medium text-foreground"
            >
              Other requests
            </h2>
            <span className="text-xs text-foreground/50">
              {otherRequests.length}
            </span>
          </div>
          {otherRequests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              actionLabel="View"
              badge={request.status}
            />
          ))}
        </section>
      ) : null}

      <section
        className="mt-9 space-y-3"
        aria-labelledby="approved-connections"
      >
        <div className="flex items-center justify-between gap-3">
          <h2
            id="approved-connections"
            className="text-sm font-medium text-foreground"
          >
            Approved browser origins
          </h2>
          <span className="text-xs text-foreground/50">
            {activeConnections.length}
          </span>
        </div>
        <p className="max-w-2xl text-xs leading-5 text-foreground/55">
          These website addresses may call this Pod from a browser. Each origin
          is exact (scheme + host + port). This is not data access — people
          still need membership. Identity providers are managed under Trust
          &amp; Keys.
        </p>
        {activeConnections.length === 0 ? (
          <EmptyState label="No external browser origins have been allowed yet." />
        ) : (
          activeConnections.map((connection) => (
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

      {revokedConnections.length > 0 ? (
        <section
          className="mt-9 space-y-3"
          aria-labelledby="revoked-connections"
        >
          <div className="flex items-center justify-between gap-3">
            <h2
              id="revoked-connections"
              className="text-sm font-medium text-foreground"
            >
              Revoked connections
            </h2>
            <span className="text-xs text-foreground/50">
              {revokedConnections.length}
            </span>
          </div>
          <p className="max-w-2xl text-xs leading-5 text-foreground/55">
            These origins are no longer allowed to call the Pod. Re-allowing
            them requires a new owner-reviewed request from the app.
          </p>
          {revokedConnections.map((connection) => (
            <ConnectionCard key={connection.id} connection={connection} />
          ))}
        </section>
      ) : null}

      {otherConnections.length > 0 ? (
        <section
          className="mt-9 space-y-3"
          aria-labelledby="inactive-connections"
        >
          <h2
            id="inactive-connections"
            className="text-sm font-medium text-foreground"
          >
            Other connection records
          </h2>
          <p className="max-w-2xl text-xs leading-5 text-foreground/55">
            These records are not active. They remain visible so a Pod owner can
            audit all application registration history.
          </p>
          {otherConnections.map((connection) => (
            <ConnectionCard key={connection.id} connection={connection} />
          ))}
        </section>
      ) : null}
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
                {badge}
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
