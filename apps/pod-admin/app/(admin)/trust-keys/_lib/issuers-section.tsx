"use client";

/**
 * Trust & Keys → Trusted issuers sub-tab.
 *
 * Procedures used:
 *   • trpc.trustedIssuers.list      — pod-admin only
 *   • trpc.trustedIssuers.approve   — id + allowedScopes (≥1)
 *   • trpc.trustedIssuers.reject    — id + reason (≥1)
 *   • trpc.trustedIssuers.revoke    — id only
 *
 * The backend has no "re-review" mutation — once rejected/revoked an issuer
 * stays in that terminal state. Filter chips simply scope the visible list.
 */

import {
  Button,
  Checkbox,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
  addToast,
  useDisclosure,
} from "@heroui/react";
import {
  Ban,
  Check,
  KeyRound,
  Lock,
  ShieldCheck,
  ShieldQuestion,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import type { StatusKind } from "../../components/status-pill";
import { useFocusRow } from "../../components/use-focus-row";
import { formatRelative } from "./format";

type IssuerStatus = "pending" | "approved" | "rejected" | "revoked";

type IssuerFilter =
  "pending" | "approved" | "rejected" | "revoked" | "built-in";

/** Derived from the generated tRPC contract so this UI cannot submit a scope
 * the Pod does not recognize. */
type TrustedIssuerScope = Parameters<
  ReturnType<typeof trpc.trustedIssuers.approve.useMutation>["mutateAsync"]
>[0]["allowedScopes"][number];

const ISSUER_SCOPES = [
  {
    value: "auth:exchange-user",
    label: "Sign in linked users",
    description: "Exchange this issuer's identity assertion for a Pod session",
  },
  {
    value: "identity:link-user",
    label: "Link Pod identities",
    description:
      "Link an issuer identity after the user proves direct Pod access",
  },
  {
    value: "membership:grant",
    label: "Manage federated membership",
    description:
      "Create or update scoped Pod membership; grant only to a trusted operator",
  },
  {
    value: "source-config:write",
    label: "Configure data sources",
    description:
      "Create source configuration for an already-linked, locally authorized user",
  },
  {
    value: "setup.agent",
    label: "Setup: Agent",
    description: "Provision agent users on this pod",
  },
  {
    value: "hub-protocol.read",
    label: "Hub: Read",
    description: "Read data via Hub Protocol",
  },
  {
    value: "hub-protocol.write",
    label: "Hub: Write",
    description: "Write data via Hub Protocol",
  },
  {
    value: "data.read",
    label: "Data: Read",
    description: "Read entities & documents",
  },
  {
    value: "data.write",
    label: "Data: Write",
    description: "Write entities & documents",
  },
  {
    value: "provision",
    label: "Provision",
    description: "Full pod provisioning",
  },
  {
    value: "tier_update",
    label: "Tier update",
    description: "Update pod tier",
  },
  { value: "sync", label: "Sync", description: "Pod-to-pod sync" },
] as const satisfies readonly {
  value: TrustedIssuerScope;
  label: string;
  description: string;
}[];

const DEFAULT_SCOPES: TrustedIssuerScope[] = [
  "auth:exchange-user",
  "identity:link-user",
];

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
  "pending",
  "approved",
  "rejected",
  "revoked",
  "built-in",
];

export function IssuersSection() {
  const [activeFilters, setActiveFilters] = useState<Set<IssuerFilter>>(
    () => new Set(["pending", "approved"])
  );

  const list = trpc.trustedIssuers.list.useQuery(undefined, {
    staleTime: 60_000,
  });

  // Expired session → login, not a dead "couldn't load" error.
  useEffect(() => {
    if (list.isError) {
      redirectToLoginIfUnauthorized(list.error, "/trust-keys");
    }
  }, [list.isError, list.error]);
  const isAuthRedirecting = list.error?.data?.code === "UNAUTHORIZED";

  // ?focus=<issuerId> from ⌘K or Overview's pending-issuer alert. Receiver
  // is `data-row-id` on the wrapping div around each IssuerRow.
  useFocusRow({ ready: !list.isLoading });

  const utils = trpc.useUtils();

  const approve = trpc.trustedIssuers.approve.useMutation({
    onSuccess: () => {
      void utils.trustedIssuers.list.invalidate();
      addToast({ title: "Issuer approved", color: "success" });
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err, "/trust-keys")) return;
      addToast({
        title: "Approval failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const reject = trpc.trustedIssuers.reject.useMutation({
    onSuccess: () => {
      void utils.trustedIssuers.list.invalidate();
      addToast({ title: "Issuer rejected", color: "default" });
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err, "/trust-keys")) return;
      addToast({
        title: "Reject failed",
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
      if (redirectToLoginIfUnauthorized(err, "/trust-keys")) return;
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
  const filtered = useMemo(() => {
    if (activeFilters.size === 0) return issuers;
    return issuers.filter((issuer) => {
      if (issuer.isBuiltIn) return activeFilters.has("built-in");
      if (activeFilters.has("built-in") && activeFilters.size === 1)
        return false;
      return activeFilters.has(issuer.status as IssuerFilter);
    });
  }, [issuers, activeFilters]);

  const counts = useMemo(() => {
    const c: Record<IssuerFilter, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      revoked: 0,
      "built-in": 0,
    };
    for (const i of issuers) {
      if (i.isBuiltIn) c["built-in"]++;
      else c[i.status as IssuerFilter]++;
    }
    return c;
  }, [issuers]);

  const [approveTarget, setApproveTarget] = useState<IssuerLike | null>(null);
  const [rejectTarget, setRejectTarget] = useState<IssuerLike | null>(null);
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
      <div className="rounded-lg ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02]">
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
                onApprove={() => setApproveTarget(issuer)}
                onReject={() => setRejectTarget(issuer)}
                onRevoke={() => setRevokeTarget(issuer)}
              />
            </div>
          ))
        )}
      </div>

      {/* Modals */}
      {approveTarget && (
        <ApproveModal
          issuer={approveTarget}
          isPending={approve.isPending}
          onClose={() => setApproveTarget(null)}
          onConfirm={async (allowedScopes) => {
            await approve.mutateAsync({ id: approveTarget.id, allowedScopes });
            setApproveTarget(null);
          }}
        />
      )}
      {rejectTarget && (
        <RejectModal
          issuer={rejectTarget}
          isPending={reject.isPending}
          onClose={() => setRejectTarget(null)}
          onConfirm={async (reason) => {
            await reject.mutateAsync({ id: rejectTarget.id, reason });
            setRejectTarget(null);
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
  onApprove,
  onReject,
  onRevoke,
}: {
  issuer: IssuerLike;
  onApprove: () => void;
  onReject: () => void;
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
    <div className="border-b border-foreground/[0.05] last:border-b-0">
      <ResourceRow
        Icon={Icon}
        primary={issuer.displayName}
        secondary={secondary}
        status={{ kind: statusKind, label: statusLabel }}
        actions={
          <div className="flex items-center gap-1.5">
            {issuer.status === "pending" && !issuer.isBuiltIn && (
              <>
                <Button
                  size="sm"
                  variant="flat"
                  color="success"
                  radius="md"
                  onPress={onApprove}
                  startContent={<Check className="h-3.5 w-3.5" />}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="flat"
                  color="danger"
                  radius="md"
                  onPress={onReject}
                  startContent={<X className="h-3.5 w-3.5" />}
                >
                  Reject
                </Button>
              </>
            )}
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

function ApproveModal({
  issuer,
  isPending,
  onClose,
  onConfirm,
}: {
  issuer: IssuerLike;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (scopes: TrustedIssuerScope[]) => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });
  const [selected, setSelected] =
    useState<TrustedIssuerScope[]>(DEFAULT_SCOPES);

  function toggle(s: TrustedIssuerScope) {
    setSelected((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(52, 211, 153, 0.18)" }}
          >
            <ShieldCheck className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="font-medium">Approve {issuer.displayName}</span>
        </ModalHeader>
        <ModalBody className="gap-3 pb-2">
          <p className="font-mono text-[11.5px] text-foreground/55">
            {issuer.issuerUrl}
          </p>
          <div>
            <p className="mb-1 text-[12.5px] font-medium text-foreground">
              Allowed scopes
            </p>
            <p className="mb-2 text-[11.5px] text-foreground/55">
              Pick what this issuer is allowed to do on this pod.
            </p>
            <div className="max-h-72 overflow-y-auto rounded-lg ring-1 ring-inset ring-foreground/10">
              {ISSUER_SCOPES.map((s) => (
                <label
                  key={s.value}
                  className="flex cursor-pointer items-start gap-2 border-b border-foreground/[0.05] px-3 py-2 last:border-0 hover:bg-content2/40"
                >
                  <Checkbox
                    size="sm"
                    isSelected={selected.includes(s.value)}
                    onValueChange={() => toggle(s.value)}
                  />
                  <span className="flex flex-col">
                    <span className="text-[12.5px] font-medium text-foreground">
                      {s.label}
                    </span>
                    <span className="text-[11px] text-foreground/55">
                      {s.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {selected.length === 0 && (
              <p className="mt-2 text-[11.5px] text-status-down">
                Select at least one scope.
              </p>
            )}
          </div>
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
            color="success"
            size="sm"
            radius="md"
            isDisabled={selected.length === 0 || isPending}
            isLoading={isPending}
            onPress={() => void onConfirm(selected)}
          >
            Approve
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function RejectModal({
  issuer,
  isPending,
  onClose,
  onConfirm,
}: {
  issuer: IssuerLike;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });
  const [reason, setReason] = useState("");

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(248, 113, 113, 0.18)" }}
          >
            <X className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="font-medium">Reject {issuer.displayName}</span>
        </ModalHeader>
        <ModalBody className="gap-2 pb-2">
          <p className="font-mono text-[11.5px] text-foreground/55">
            {issuer.issuerUrl}
          </p>
          <Textarea
            placeholder="Why is this connection being rejected?"
            label="Reason"
            value={reason}
            onValueChange={setReason}
            minRows={3}
            size="sm"
          />
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
            isDisabled={!reason.trim() || isPending}
            isLoading={isPending}
            onPress={() => void onConfirm(reason.trim())}
          >
            Reject
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

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

// Suppress unused warning for KeyRound — kept for visual symmetry with overview.
void ShieldQuestion;
void KeyRound;
