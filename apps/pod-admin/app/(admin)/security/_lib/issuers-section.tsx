"use client";

/**
 * Trust & Keys → Trusted issuers sub-tab.
 *
 * Procedures used:
 *   • trpc.trustedIssuers.list      — pod-admin only
 *   • trpc.trustedIssuers.approve   — id + allowedScopes (≥1); here only for
 *                                     the broker panel's scope fix
 *   • trpc.trustedIssuers.revoke    — id only
 *
 * PENDING issuers are not decided here: approve / reject live in Review, the
 * one attention door. This list shows them as a single "N waiting → Review"
 * line, never as rows with their own Approve buttons.
 *
 * The backend has no "re-review" mutation — once rejected/revoked an issuer
 * stays in that terminal state. Filter chips simply scope the visible list.
 */

import {
  Button,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  addToast,
  useDisclosure,
} from "@heroui/react";
import Link from "next/link";
import { ArrowRight, Ban, Lock, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { pendingIssuerHref } from "../../../../lib/console-nav";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import type { StatusKind } from "../../components/status-pill";
import { useFocusRow } from "../../components/use-focus-row";
import { formatRelative } from "../../../../lib/format";
import { BROKER_TRUST_QUERY_KEY } from "./broker-trust";
import { BrokerTrustPanel } from "./broker-trust-panel";
import {
  IssuerApproveModal,
  knownIssuerScopes,
  type TrustedIssuerScope,
} from "../../review/_lib/issuer-review";

type IssuerStatus = "pending" | "approved" | "rejected" | "revoked";

type IssuerFilter = "approved" | "rejected" | "revoked" | "built-in";

interface IssuerLike {
  id: string;
  displayName: string;
  issuerUrl: string;
  status: IssuerStatus;
  allowedScopes: string[];
  isBuiltIn: boolean;
  createdAt: Date | string;
  firstContactedAt?: Date | string | null;
}

const STATUS_TO_KIND: Record<IssuerStatus, StatusKind> = {
  pending: "stale",
  approved: "healthy",
  rejected: "unknown",
  revoked: "down",
};

/**
 * Filter chip labels. Four of the five chips ARE the `issuers.status` domain
 * values, so they resolve through the vocabulary SSOT rather than a local
 * table — otherwise this map forks from the row's own status label the moment
 * either side changes. `built-in` is the exception: it is not a status but a
 * property of the issuer, so it stays product copy here.
 */
function filterLabel(filter: IssuerFilter): string {
  return filter === "built-in" ? "Built-in" : resolveStatusLabel(filter);
}

const FILTER_ORDER: IssuerFilter[] = [
  "approved",
  "rejected",
  "revoked",
  "built-in",
];

export function IssuersSection() {
  const [activeFilters, setActiveFilters] = useState<Set<IssuerFilter>>(
    () => new Set(["approved"])
  );

  const list = trpc.trustedIssuers.list.useQuery(undefined, {
    staleTime: 60_000,
  });

  // Expired session → login, not a dead "couldn't load" error.
  useEffect(() => {
    if (list.isError) {
      redirectToLoginIfUnauthorized(list.error);
    }
  }, [list.isError, list.error]);
  const isAuthRedirecting = list.error?.data?.code === "UNAUTHORIZED";

  // ?focus=<issuerId> from ⌘K or a Review deep link. Receiver is
  // `data-row-id` on the wrapping div around each IssuerRow.
  useFocusRow({ ready: !list.isLoading });

  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  const approve = trpc.trustedIssuers.approve.useMutation({
    onSuccess: () => {
      void utils.trustedIssuers.list.invalidate();
      void queryClient.invalidateQueries({ queryKey: BROKER_TRUST_QUERY_KEY });
      addToast({ title: "Issuer approved", color: "success" });
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Approval failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const revoke = trpc.trustedIssuers.revoke.useMutation({
    onSuccess: () => {
      void utils.trustedIssuers.list.invalidate();
      addToast({ title: "Access revoked", color: "default" });
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Revoke failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const issuers = useMemo<IssuerLike[]>(
    () => (list.data as IssuerLike[] | undefined) ?? [],
    [list.data]
  );

  // Apply filter chips.  "built-in" is a special filter that returns ONLY
  // built-in issuers (regardless of status).  The other four filter by
  // status and exclude built-ins so they don't double-count.
  // Pending issuers are Review's: never listed here, only counted.
  const decided = useMemo(
    () => issuers.filter((i) => i.isBuiltIn || i.status !== "pending"),
    [issuers]
  );
  const pendingCount = issuers.length - decided.length;

  const filtered = useMemo(() => {
    if (activeFilters.size === 0) return decided;
    return decided.filter((issuer) => {
      if (issuer.isBuiltIn) return activeFilters.has("built-in");
      if (activeFilters.has("built-in") && activeFilters.size === 1)
        return false;
      return activeFilters.has(issuer.status as IssuerFilter);
    });
  }, [decided, activeFilters]);

  const counts = useMemo(() => {
    const c: Record<IssuerFilter, number> = {
      approved: 0,
      rejected: 0,
      revoked: 0,
      "built-in": 0,
    };
    for (const i of decided) {
      if (i.isBuiltIn) c["built-in"]++;
      else c[i.status as IssuerFilter]++;
    }
    return c;
  }, [decided]);

  const [approveTarget, setApproveTarget] = useState<IssuerLike | null>(null);
  const [approveScopes, setApproveScopes] = useState<
    TrustedIssuerScope[] | undefined
  >(undefined);
  const [revokeTarget, setRevokeTarget] = useState<IssuerLike | null>(null);

  function toggleFilter(f: IssuerFilter) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <BrokerTrustPanel
        issuers={issuers}
        onApprove={(issuerId, scopes) => {
          const issuer = issuers.find((i) => i.id === issuerId);
          if (!issuer) return;
          setApproveScopes(knownIssuerScopes(scopes));
          setApproveTarget(issuer);
        }}
      />

      {pendingCount > 0 && (
        <Link
          href={pendingIssuerHref()}
          className="flex min-h-10 items-center justify-between gap-3 rounded-lg bg-status-stale/10 px-3 py-2 text-[12.5px] text-foreground ring-1 ring-inset ring-status-stale/30 transition-colors hover:bg-status-stale/15"
        >
          <span>
            {pendingCount} {pendingCount === 1 ? "issuer is" : "issuers are"}{" "}
            waiting for your approval
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 font-medium">
            Review
            <ArrowRight className="h-3.5 w-3.5" />
          </span>
        </Link>
      )}

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTER_ORDER.map((f) => {
          const active = activeFilters.has(f);
          return (
            <button
              key={f}
              type="button"
              onClick={() => toggleFilter(f)}
              className={[
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1",
                "text-[12px] font-medium tracking-tight transition-colors",
                active
                  ? "bg-foreground/[0.08] text-foreground ring-1 ring-inset ring-foreground/15"
                  : "text-foreground/55 hover:bg-content2/50 hover:text-foreground",
              ].join(" ")}
            >
              {filterLabel(f)}
              <span className="tabular text-[11px] text-foreground/45">
                {counts[f]}
              </span>
            </button>
          );
        })}
        {activeFilters.size > 0 && (
          <button
            type="button"
            onClick={() => setActiveFilters(new Set())}
            className="text-[11.5px] text-foreground/45 hover:text-foreground/70 transition-colors"
          >
            Show all
          </button>
        )}
      </div>

      {/* List */}
      <div className="divide-y divide-foreground/[0.05] rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
        {list.isLoading || isAuthRedirecting ? (
          <ResourceRowSkeleton count={3} />
        ) : list.isError ? (
          <ResourceRowError
            message="Couldn't load trusted issuers."
            onRetry={() => void list.refetch()}
          />
        ) : filtered.length === 0 ? (
          <ResourceRowEmpty message="No trusted issuers match this filter." />
        ) : (
          filtered.map((issuer) => (
            <div
              key={issuer.id}
              data-row-id={issuer.id}
              className="rounded-md transition-shadow"
            >
              <IssuerRow
                issuer={issuer}
                onRevoke={() => setRevokeTarget(issuer)}
              />
            </div>
          ))
        )}
      </div>

      {/* Modals */}
      {approveTarget && (
        <IssuerApproveModal
          issuer={approveTarget}
          initialScopes={approveScopes}
          isPending={approve.isPending}
          onClose={() => {
            setApproveTarget(null);
            setApproveScopes(undefined);
          }}
          onConfirm={async (allowedScopes) => {
            await approve.mutateAsync({ id: approveTarget.id, allowedScopes });
            setApproveTarget(null);
            setApproveScopes(undefined);
          }}
        />
      )}
      {revokeTarget && (
        <RevokeModal
          issuer={revokeTarget}
          isPending={revoke.isPending}
          onClose={() => setRevokeTarget(null)}
          onConfirm={async () => {
            await revoke.mutateAsync({ id: revokeTarget.id });
            setRevokeTarget(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

function IssuerRow({
  issuer,
  onRevoke,
}: {
  issuer: IssuerLike;
  onRevoke: () => void;
}) {
  const Icon = issuer.isBuiltIn ? Lock : ShieldCheck;
  const statusKind: StatusKind = issuer.isBuiltIn
    ? "healthy"
    : STATUS_TO_KIND[issuer.status];
  // `issuer.status` is a lifecycle status on a DB row, so its label comes from
  // the vocabulary SSOT — never a local map, never a hand-rolled capitalise.
  // "Built-in" is not a status: it is a property of the issuer overriding the
  // status display, so it stays product copy.
  const statusLabel = issuer.isBuiltIn
    ? "Built-in"
    : resolveStatusLabel(issuer.status);

  const secondary = [
    issuer.issuerUrl,
    `added ${formatRelative(issuer.firstContactedAt ?? issuer.createdAt)}`,
  ].join(" · ");

  return (
    <div>
      <ResourceRow
        Icon={Icon}
        primary={issuer.displayName}
        secondary={secondary}
        status={{ kind: statusKind, label: statusLabel }}
        actions={
          <div className="flex items-center gap-1.5">
            {issuer.status === "approved" && !issuer.isBuiltIn && (
              <Button
                size="sm"
                variant="flat"
                color="danger"
                radius="md"
                onPress={onRevoke}
                startContent={<Ban className="h-3.5 w-3.5" />}
              >
                Revoke
              </Button>
            )}
            {issuer.isBuiltIn && (
              <span className="inline-flex items-center gap-1 px-2 text-[11px] text-foreground/45">
                <Lock className="h-3 w-3" />
                System
              </span>
            )}
          </div>
        }
      />
      {issuer.allowedScopes.length > 0 && (
        <div className="-mt-1 flex flex-wrap gap-1 px-3 pb-2">
          {issuer.allowedScopes.map((s) => (
            <Chip
              key={s}
              size="sm"
              radius="sm"
              variant="flat"
              className="bg-foreground/[0.06] text-[11px] text-foreground/65"
            >
              {s}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Modals ────────────────────────────────────────────────────────────────

function RevokeModal({
  issuer,
  isPending,
  onClose,
  onConfirm,
}: {
  issuer: IssuerLike;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(248, 113, 113, 0.18)" }}
          >
            <Ban className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="font-medium">Revoke access</span>
        </ModalHeader>
        <ModalBody className="gap-2 pb-2">
          <p className="text-[12.5px] text-foreground/85">
            Revoke access for{" "}
            <span className="font-medium">{issuer.displayName}</span>?
          </p>
          <p className="text-[11.5px] text-foreground/55">
            Signed JWTs from this issuer will no longer be accepted. Linked
            integration keys will be revoked at the same time. This cannot be
            undone without re-approving.
          </p>
        </ModalBody>
        <ModalFooter>
          <Button
            variant="light"
            size="sm"
            radius="md"
            onPress={onClose}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            color="danger"
            size="sm"
            radius="md"
            isLoading={isPending}
            onPress={() => void onConfirm()}
          >
            Revoke access
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
