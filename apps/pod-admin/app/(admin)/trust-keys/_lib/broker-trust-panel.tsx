"use client";

/**
 * Trust & Keys → Trusted issuers → connection broker trust.
 *
 * Shows WHY a Control-Plane-brokered pod has no usable relay key, and the one
 * action that fixes it through an existing door:
 *   • issuer not approved / missing `source-config:write` → the Approve modal,
 *     pre-filled with the issuer's scopes plus that one;
 *   • everything else happens outside Pod Admin (pod env, control plane), so it
 *     is stated with instructions and no button.
 * Hidden on a pod that brokers through its own Nango.
 */

import { Button } from "@heroui/react";
import { KeyRound, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  humanizeToken,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import { POD_URL } from "../../../../lib/trpc";
import { StatusPill, type StatusKind } from "../../components/status-pill";
import {
  BROKER_TRUST_QUERY_KEY,
  deriveBrokerTrustState,
  fetchBrokerTrust,
  type BrokerTrustState,
} from "./broker-trust";

/** Display name the pod seeds its built-in Control Plane issuer under. */
const CP_ISSUER_DISPLAY_NAME = "Synap Control Plane";
const SOURCE_CONFIG_WRITE = "source-config:write";

interface IssuerRef {
  id: string;
  displayName: string;
  isBuiltIn: boolean;
  allowedScopes: string[];
}

export function BrokerTrustPanel({
  issuers,
  onApprove,
}: {
  issuers: IssuerRef[];
  /** Opens the existing Approve modal for `issuerId` with `scopes` selected. */
  onApprove: (issuerId: string, scopes: string[]) => void;
}) {
  const query = useQuery({
    queryKey: BROKER_TRUST_QUERY_KEY,
    queryFn: () => fetchBrokerTrust(POD_URL),
    staleTime: 60_000,
    retry: false,
  });

  if (query.isLoading) {
    return (
      <div className="h-11 w-full rounded-lg bg-foreground/[0.04] shimmer-pulse" />
    );
  }

  if (query.isError) {
    return (
      <Shell
        status={{ kind: "unknown", label: "Unknown" }}
        title="Connection broker trust could not be read"
        body={
          query.error instanceof Error
            ? query.error.message
            : String(query.error)
        }
        onRecheck={() => void query.refetch()}
        rechecking={query.isFetching}
      />
    );
  }

  if (!query.data) return null;
  const state = deriveBrokerTrustState(query.data);
  if (state.kind === "not-managed") return null;

  const cpIssuer = issuers.find(
    (i) => i.isBuiltIn && i.displayName === CP_ISSUER_DISPLAY_NAME
  );
  const copy = describe(state);
  const needsApproval =
    state.kind === "issuer-pending" ||
    state.kind === "issuer-closed" ||
    state.kind === "issuer-scope-missing";

  return (
    <Shell
      status={copy.status}
      title={copy.title}
      body={copy.body}
      onRecheck={() => void query.refetch()}
      rechecking={query.isFetching}
      action={
        needsApproval && cpIssuer ? (
          <Button
            size="sm"
            variant="flat"
            color="success"
            radius="md"
            onPress={() =>
              onApprove(
                cpIssuer.id,
                Array.from(
                  new Set([...cpIssuer.allowedScopes, SOURCE_CONFIG_WRITE])
                )
              )
            }
          >
            Review approval
          </Button>
        ) : undefined
      }
    />
  );
}

function describe(state: Exclude<BrokerTrustState, { kind: "not-managed" }>): {
  status: { kind: StatusKind; label: string };
  title: string;
  body: string;
} {
  const down = { kind: "down" as const, label: "Blocked" };
  switch (state.kind) {
    case "ok":
      return {
        status: { kind: "healthy", label: "Connected" },
        title: "Connections are brokered by the Synap Control Plane",
        body: state.validUntil
          ? `Relay key valid until ${new Date(state.validUntil).toLocaleString()}.`
          : "Relay key present.",
      };
    case "issuer-missing":
      return {
        status: down,
        title: "This pod has no Synap Control Plane issuer",
        body: "The control plane cannot deliver this pod's relay key until the pod trusts it. Check CONTROL_PLANE_URL on the pod and restart it — the issuer is added at startup.",
      };
    case "issuer-pending":
      return {
        status: down,
        title: "The Synap Control Plane issuer is waiting for approval",
        body: "Approve it with 'Configure data sources' so the control plane can deliver this pod's relay key.",
      };
    case "issuer-closed":
      return {
        status: down,
        title: `The Synap Control Plane issuer is ${resolveStatusLabel(state.status).toLowerCase()}`,
        body: "Relay-key delivery is refused while it is not approved. Re-approve it with 'Configure data sources' only if you trust this control plane.",
      };
    case "issuer-scope-missing":
      return {
        status: down,
        title: "The Synap Control Plane issuer cannot configure data sources",
        body: "The relay key arrives as a data source, so the issuer needs 'Configure data sources'. Its other scopes stay as they are.",
      };
    case "owner-link-missing":
      return {
        status: down,
        title: "The owner's control plane account is not linked to this pod",
        body: "Relay-key delivery is refused until it is. Link it from the Synap Control Plane while signed in to this pod as the owner — Pod Admin has no link action. Then rotate the relay key from the control plane.",
      };
    case "credential-missing":
      return {
        status: { kind: "stale", label: "Waiting" },
        title: "Trust is in place, but no relay key has been delivered",
        body: "Rotate this pod's relay key from the Synap Control Plane.",
      };
    case "credential-unreadable":
      return {
        status: down,
        title: "This pod's relay key cannot be read",
        body: "A relay key was delivered, but the pod cannot read it from its vault. Rotate the relay key from the Synap Control Plane — it re-delivers a readable one.",
      };
    case "credential-expired":
      return {
        status: down,
        title: "This pod's relay key has expired",
        body: `It expired ${new Date(state.validUntil).toLocaleString()}. Rotate it from the Synap Control Plane.`,
      };
    case "broker-fault":
      return {
        status: down,
        title: "The connection broker is unavailable",
        body: `Reason: ${humanizeToken(state.reason)}.`,
      };
  }
}

function Shell({
  status,
  title,
  body,
  action,
  onRecheck,
  rechecking,
}: {
  status: { kind: StatusKind; label: string };
  title: string;
  body: string;
  action?: React.ReactNode;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg bg-foreground/[0.02] px-3 py-2.5 ring-1 ring-inset ring-foreground/10">
      <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-foreground/55" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] font-medium text-foreground">
            {title}
          </span>
          {status.kind !== "healthy" && (
            <StatusPill kind={status.kind} label={status.label} />
          )}
        </div>
        <p className="text-[11.5px] text-foreground/55">{body}</p>
      </div>
      <div className="flex items-center gap-1.5">
        {action}
        <Button
          size="sm"
          variant="light"
          radius="md"
          isLoading={rechecking}
          onPress={onRecheck}
          startContent={
            rechecking ? undefined : <RefreshCw className="h-3.5 w-3.5" />
          }
        >
          Re-check
        </Button>
      </div>
    </div>
  );
}
