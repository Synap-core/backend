import { useState } from "react";
import {
  Button,
  Checkbox,
  Chip,
  Modal,
  TextArea,
  Text,
  Tooltip,
  useOverlayState,
} from "@heroui/react";
import {
  IconShieldCheck,
  IconAlertTriangle,
  IconCheck,
  IconX,
  IconBan,
  IconLock,
  IconRefresh,
  IconLink,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { spacing } from "../../theme/tokens";

// ─── Scope definitions ───────────────────────────────────────────────────────

const ISSUER_SCOPES: { value: string; label: string; description: string }[] = [
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
];

const DEFAULT_SCOPES = [
  "setup.agent",
  "hub-protocol.read",
  "hub-protocol.write",
];

// ─── Types ────────────────────────────────────────────────────────────────────

type IssuerStatus = "pending" | "approved" | "rejected" | "revoked";

interface TrustedIssuer {
  id: string;
  displayName: string;
  issuerUrl: string;
  status: IssuerStatus;
  allowedScopes: string[];
  isBuiltIn: boolean;
  createdAt: Date | string;
  firstContactedAt?: Date | string | null;
}

type IntegrationType = "raycast" | "cli" | "openclaw" | "custom";

type TrustedIssuersTrpc = {
  trustedIssuers: {
    list: {
      useQuery: () => {
        data: TrustedIssuer[] | undefined;
        isLoading: boolean;
        refetch: () => Promise<unknown>;
      };
    };
    approve: {
      useMutation: () => {
        isPending: boolean;
        mutateAsync: (input: {
          id: string;
          allowedScopes: string[];
        }) => Promise<unknown>;
      };
    };
    reject: {
      useMutation: (opts: {
        onSuccess: () => void;
        onError: (err: unknown) => void;
      }) => {
        isPending: boolean;
        mutate: (input: { id: string; reason: string }) => void;
      };
    };
    revoke: {
      useMutation: (opts: {
        onSuccess: () => void;
        onError: (err: unknown) => void;
      }) => { isPending: boolean; mutate: (input: { id: string }) => void };
    };
  };
  apiKeys: {
    connectIntegration: {
      useMutation: () => {
        mutateAsync: (input: { integration: IntegrationType }) => Promise<{
          apiKey: string;
          podUrl: string;
          workspaceId: string | null;
        }>;
      };
    };
  };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ALLOWED_REDIRECT_PREFIXES = ["raycast://extensions/synap-core/synap/"];

function isAllowedRedirectUri(uri: string): boolean {
  return ALLOWED_REDIRECT_PREFIXES.some((prefix) => uri.startsWith(prefix));
}

function buildDeeplink(
  redirectUri: string,
  apiKey: string,
  podUrl: string,
  workspaceId: string | null
): string {
  const context = JSON.stringify({ apiKey, podUrl, workspaceId });
  return `${redirectUri}?context=${encodeURIComponent(context)}`;
}

function buildErrorDeeplink(
  redirectUri: string,
  code: "issuer_rejected" | "issuer_revoked" | "issuer_not_approved",
  message: string
): string {
  const context = JSON.stringify({ error: true, code, message });
  return `${redirectUri}?context=${encodeURIComponent(context)}`;
}

const STATUS_CONFIG: Record<
  IssuerStatus,
  { color: "warning" | "success" | "danger" | "default"; label: string }
> = {
  pending: { color: "warning", label: "Pending" },
  approved: { color: "success", label: "Approved" },
  rejected: { color: "danger", label: "Rejected" },
  revoked: { color: "default", label: "Revoked" },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScopeBadges({ scopes, max = 4 }: { scopes: string[]; max?: number }) {
  const visible = scopes.slice(0, max);
  const overflow = scopes.length - max;
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((s) => (
        <Chip key={s} size="sm" variant="soft" color="accent">
          {s}
        </Chip>
      ))}
      {overflow > 0 && (
        <Chip size="sm" variant="soft" color="default">
          +{overflow}
        </Chip>
      )}
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="mb-3 border-b border-divider pb-2 text-small font-semibold uppercase tracking-wide text-default-500">
      {title}
    </h2>
  );
}

// ─── Pending approval card ────────────────────────────────────────────────────

function PendingApprovalCard({
  issuer,
  onApprove,
  onReject,
}: {
  issuer: TrustedIssuer;
  onApprove: (issuer: TrustedIssuer) => void;
  onReject: (issuer: TrustedIssuer) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-warning-200 bg-warning-50 p-4 shadow-md dark:border-warning-700/50 dark:bg-warning-950/30 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-1 gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning-100 text-warning-600 dark:bg-warning-900/40 dark:text-warning-400">
          <IconAlertTriangle size={18} />
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-warning-900 dark:text-warning-100">
            Connection request pending
          </p>
          <p className="mt-0.5 text-small text-warning-700 dark:text-warning-300">
            <span className="font-mono font-medium">{issuer.issuerUrl}</span>{" "}
            wants to connect to this data pod.
          </p>
          {issuer.displayName && issuer.displayName !== issuer.issuerUrl && (
            <p className="mt-0.5 text-xs text-warning-600 dark:text-warning-400">
              Registered as:{" "}
              <span className="font-medium">{issuer.displayName}</span>
            </p>
          )}
          <p className="mt-1.5 text-xs text-warning-500 dark:text-warning-500">
            First contacted:{" "}
            {formatDateTime(issuer.firstContactedAt ?? issuer.createdAt)}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2 sm:self-center">
        <Button size="sm" variant="primary" onPress={() => onApprove(issuer)}>
          <span className="inline-flex items-center gap-1.5">
            <IconCheck size={14} />
            Approve
          </span>
        </Button>
        <Button size="sm" variant="danger" onPress={() => onReject(issuer)}>
          <span className="inline-flex items-center gap-1.5">
            <IconX size={14} />
            Reject
          </span>
        </Button>
      </div>
    </div>
  );
}

// ─── Approve modal ────────────────────────────────────────────────────────────

function ApproveModal({
  issuer,
  onClose,
  onConfirm,
  isPending,
}: {
  issuer: TrustedIssuer;
  onClose: () => void;
  onConfirm: (scopes: string[]) => void;
  isPending: boolean;
}) {
  const overlay = useOverlayState({
    isOpen: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });
  const [selectedScopes, setSelectedScopes] =
    useState<string[]>(DEFAULT_SCOPES);

  function toggleScope(value: string) {
    setSelectedScopes((prev) =>
      prev.includes(value) ? prev.filter((s) => s !== value) : [...prev, value]
    );
  }

  return (
    <Modal state={overlay}>
      <Modal.Backdrop isDismissable>
        <Modal.Container size="md" placement="center">
          <Modal.Dialog>
            <Modal.Header className="border-b border-divider px-5 py-4">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-success-100 text-success-600 dark:bg-success-900/30 dark:text-success-400">
                  <IconCheck size={16} />
                </span>
                <Modal.Heading
                  id="approve-modal-title"
                  className="text-base font-semibold"
                >
                  Approve connection from{" "}
                  <span className="text-primary">{issuer.displayName}</span>
                </Modal.Heading>
              </div>
              <Modal.CloseTrigger className="absolute right-3 top-3" />
            </Modal.Header>
            <Modal.Body className="px-5 py-4">
              <Text className="mt-1.5 text-xs text-default-500">
                <span className="font-mono">{issuer.issuerUrl}</span>
              </Text>
              <label className="mb-2 block text-small font-medium">
                Allowed scopes
              </label>
              <p className="mb-3 text-xs text-default-500">
                Select which operations this issuer is allowed to perform on
                this pod.
              </p>
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-divider p-2">
                {ISSUER_SCOPES.map((s) => (
                  <div
                    key={s.value}
                    className="rounded-lg px-2 py-2 hover:bg-default-100"
                  >
                    <Checkbox
                      isSelected={selectedScopes.includes(s.value)}
                      onChange={() => toggleScope(s.value)}
                    >
                      <span className="block text-small font-medium">
                        {s.label}
                      </span>
                      <span className="block text-xs text-default-500">
                        {s.description}
                      </span>
                    </Checkbox>
                  </div>
                ))}
              </div>
              {selectedScopes.length === 0 && (
                <p className="mt-2 text-xs text-danger-500">
                  Select at least one scope to approve.
                </p>
              )}
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2 border-t border-divider px-5 py-4">
              <Button variant="ghost" size="sm" onPress={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                isDisabled={selectedScopes.length === 0 || isPending}
                onPress={() => onConfirm(selectedScopes)}
              >
                {isPending ? "Approving…" : "Approve & allow access"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

// ─── Reject modal ─────────────────────────────────────────────────────────────

function RejectModal({
  issuer,
  onClose,
  onConfirm,
  isPending,
}: {
  issuer: TrustedIssuer;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  isPending: boolean;
}) {
  const overlay = useOverlayState({
    isOpen: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });
  const [reason, setReason] = useState("");

  return (
    <Modal state={overlay}>
      <Modal.Backdrop isDismissable>
        <Modal.Container size="md" placement="center">
          <Modal.Dialog>
            <Modal.Header className="border-b border-divider px-5 py-4">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-danger-100 text-danger-600 dark:bg-danger-900/30 dark:text-danger-400">
                  <IconX size={16} />
                </span>
                <Modal.Heading
                  id="reject-modal-title"
                  className="text-base font-semibold"
                >
                  Reject connection from{" "}
                  <span className="text-danger">{issuer.displayName}</span>
                </Modal.Heading>
              </div>
              <Modal.CloseTrigger className="absolute right-3 top-3" />
            </Modal.Header>
            <Modal.Body className="px-5 py-4">
              <p className="text-xs text-default-500">
                <span className="font-mono">{issuer.issuerUrl}</span>
              </p>
              <label className="mb-1.5 block text-small font-medium">
                Reason <span className="text-danger">*</span>
              </label>
              <TextArea
                className="w-full"
                rows={3}
                placeholder="Why is this connection being rejected?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2 border-t border-divider px-5 py-4">
              <Button variant="ghost" size="sm" onPress={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                isDisabled={!reason.trim() || isPending}
                onPress={() => onConfirm(reason.trim())}
              >
                {isPending ? "Rejecting…" : "Reject"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

// ─── Revoke modal ─────────────────────────────────────────────────────────────

function RevokeModal({
  issuer,
  onClose,
  onConfirm,
  isPending,
}: {
  issuer: TrustedIssuer;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  const overlay = useOverlayState({
    isOpen: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });
  return (
    <Modal state={overlay}>
      <Modal.Backdrop isDismissable>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header className="border-b border-divider px-5 py-4">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-default-100 text-default-600">
                  <IconBan size={16} />
                </span>
                <Modal.Heading
                  id="revoke-modal-title"
                  className="text-base font-semibold"
                >
                  Revoke access
                </Modal.Heading>
              </div>
              <Modal.CloseTrigger className="absolute right-3 top-3" />
            </Modal.Header>
            <Modal.Body className="px-5 py-4 text-small text-default-600">
              <p>
                Revoke access for{" "}
                <span className="font-semibold">{issuer.displayName}</span>?
              </p>
              <p className="mt-1 text-xs text-default-500">
                Signed JWTs from this issuer will no longer be accepted. This
                cannot be undone without re-approving.
              </p>
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2 border-t border-divider px-5 py-4">
              <Button variant="ghost" size="sm" onPress={onClose}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                isDisabled={isPending}
                onPress={onConfirm}
              >
                {isPending ? "Revoking…" : "Revoke access"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TrustedIssuersPage() {
  const trpcClient = trpc as unknown as TrustedIssuersTrpc;
  const [approveTarget, setApproveTarget] = useState<TrustedIssuer | null>(
    null
  );
  const [rejectTarget, setRejectTarget] = useState<TrustedIssuer | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<TrustedIssuer | null>(null);
  const [isRedirectingBack, setIsRedirectingBack] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const redirectUri = params.get("redirect_uri") ?? "";
  const integration = (params.get("integration") ??
    "custom") as IntegrationType;
  const issuerUrlFilter = params.get("issuer_url") ?? "";

  const {
    data: issuers,
    isLoading,
    refetch,
  } = trpcClient.trustedIssuers.list.useQuery();

  const approveMutation = trpcClient.trustedIssuers.approve.useMutation();

  const rejectMutation = trpcClient.trustedIssuers.reject.useMutation({
    onSuccess: () => {
      refetch();
      setRejectTarget(null);
      showSuccessNotification({ message: "Issuer rejected" });
    },
    onError: (err) =>
      showErrorNotification({
        message: err instanceof Error ? err.message : "Failed to reject issuer",
      }),
  });

  const revokeMutation = trpcClient.trustedIssuers.revoke.useMutation({
    onSuccess: () => {
      refetch();
      setRevokeTarget(null);
      showSuccessNotification({ message: "Access revoked" });
    },
    onError: (err) =>
      showErrorNotification({
        message: err instanceof Error ? err.message : "Failed to revoke issuer",
      }),
  });

  const connectMutation = trpcClient.apiKeys.connectIntegration.useMutation();

  const allIssuers: TrustedIssuer[] = issuers ?? [];
  const pendingIssuers = allIssuers.filter((i) => i.status === "pending");
  const otherIssuers = allIssuers.filter((i) => i.status !== "pending");
  const redirectIssuer = issuerUrlFilter
    ? allIssuers.find((issuer) => issuer.issuerUrl === issuerUrlFilter)
    : null;

  async function handleApproveConfirm(scopes: string[]) {
    if (!approveTarget) return;
    try {
      await approveMutation.mutateAsync({
        id: approveTarget.id,
        allowedScopes: scopes,
      });
      await refetch();
      const shouldAutoReturn =
        !!redirectUri &&
        isAllowedRedirectUri(redirectUri) &&
        (!issuerUrlFilter || approveTarget.issuerUrl === issuerUrlFilter);

      if (shouldAutoReturn) {
        setIsRedirectingBack(true);
        const connection = await connectMutation.mutateAsync({ integration });
        const deeplink = buildDeeplink(
          redirectUri,
          connection.apiKey,
          connection.podUrl,
          connection.workspaceId
        );
        showSuccessNotification({
          message: "Issuer approved. Redirecting back to integration…",
        });
        window.location.href = deeplink;
        return;
      }

      setApproveTarget(null);
      showSuccessNotification({ message: "Issuer approved successfully" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Approval failed";
      showErrorNotification({ message });
    } finally {
      setIsRedirectingBack(false);
    }
  }

  function handleRejectConfirm(reason: string) {
    if (!rejectTarget) return;
    const isRedirectPath =
      !!redirectUri &&
      isAllowedRedirectUri(redirectUri) &&
      (!issuerUrlFilter || rejectTarget.issuerUrl === issuerUrlFilter);
    rejectMutation.mutate({ id: rejectTarget.id, reason });
    if (isRedirectPath) {
      const deeplink = buildErrorDeeplink(
        redirectUri,
        "issuer_rejected",
        "This pod admin rejected the issuer connection request."
      );
      window.location.href = deeplink;
    }
  }

  function handleRevokeConfirm() {
    if (!revokeTarget) return;
    revokeMutation.mutate({ id: revokeTarget.id });
  }

  return (
    <div className="p-8" style={{ padding: spacing[8] }}>
      {/* Page header */}
      <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <IconShieldCheck size={22} className="text-secondary" />
            <h1 className="text-2xl font-bold text-foreground">
              Trusted issuers
            </h1>
          </div>
          <p className="max-w-xl text-small text-default-500">
            External services that can act on this pod by presenting a signed
            JWT. Approve connection requests and manage allowed scopes.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onPress={() => refetch()}
        >
          <span className="inline-flex items-center gap-1.5">
            <IconRefresh size={15} />
            Refresh
          </span>
        </Button>
      </div>

      {/* Pending approval cards */}
      {!!redirectUri && isAllowedRedirectUri(redirectUri) && (
        <div className="mb-4 rounded-xl border border-primary-200 bg-primary-50 p-3 text-xs text-primary-800 dark:border-primary-700/40 dark:bg-primary-950/30 dark:text-primary-300">
          Approving the requested issuer will complete the{" "}
          <strong>{integration}</strong> connection and return you to your
          integration app.
        </div>
      )}
      {!!redirectIssuer &&
        (redirectIssuer.status === "rejected" ||
          redirectIssuer.status === "revoked") &&
        !!redirectUri &&
        isAllowedRedirectUri(redirectUri) && (
          <div className="mb-4 rounded-xl border border-danger-200 bg-danger-50 p-3 text-xs text-danger-800 dark:border-danger-700/40 dark:bg-danger-950/30 dark:text-danger-300">
            This issuer is <strong>{redirectIssuer.status}</strong>.{" "}
            <Button
              variant="ghost"
              size="sm"
              className="ml-1 h-auto p-0 align-baseline underline"
              onPress={() => {
                const deeplink = buildErrorDeeplink(
                  redirectUri,
                  redirectIssuer.status === "revoked"
                    ? "issuer_revoked"
                    : "issuer_rejected",
                  `The issuer is ${redirectIssuer.status} on this pod.`
                );
                window.location.href = deeplink;
              }}
            >
              Return to integration with error
            </Button>
          </div>
        )}
      {pendingIssuers.length > 0 && (
        <div className="mb-8 flex flex-col gap-3">
          <SectionHeader
            title={`Pending approval (${pendingIssuers.length})`}
          />
          {pendingIssuers.map((issuer) => (
            <PendingApprovalCard
              key={issuer.id}
              issuer={issuer}
              onApprove={setApproveTarget}
              onReject={setRejectTarget}
            />
          ))}
        </div>
      )}

      {/* All issuers table */}
      {isLoading ? (
        <div className="flex justify-center py-16 text-default-400">
          Loading…
        </div>
      ) : allIssuers.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center text-default-400">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-default-100">
            <IconLink size={22} className="text-default-400" />
          </span>
          <div>
            <p className="text-small font-medium">No trusted issuers yet</p>
            <p className="mt-0.5 text-xs text-default-400">
              External services will appear here once they initiate a connection
              request.
            </p>
          </div>
        </div>
      ) : (
        <div>
          {otherIssuers.length > 0 && (
            <>
              <SectionHeader title="All issuers" />
              <div className="overflow-x-auto rounded-2xl border border-divider">
                <table className="w-full min-w-[800px] text-left text-small">
                  <thead className="border-b border-divider bg-default-100 text-xs uppercase text-default-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">Issuer</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Allowed scopes</th>
                      <th className="px-4 py-3 font-medium">Added</th>
                      <th className="px-4 py-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {otherIssuers.map((issuer) => {
                      const statusCfg = STATUS_CONFIG[issuer.status];

                      return (
                        <tr
                          key={issuer.id}
                          className="border-b border-divider last:border-0"
                        >
                          {/* Issuer name + URL */}
                          <td className="px-4 py-3">
                            <div className="flex items-start gap-2">
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-default-100 text-default-500">
                                <IconShieldCheck size={15} />
                              </span>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-medium text-foreground">
                                    {issuer.displayName}
                                  </span>
                                  {issuer.isBuiltIn && (
                                    <Chip
                                      size="sm"
                                      variant="soft"
                                      color="accent"
                                    >
                                      Built-in
                                    </Chip>
                                  )}
                                </div>
                                <span className="block truncate font-mono text-xs text-default-500">
                                  {issuer.issuerUrl}
                                </span>
                              </div>
                            </div>
                          </td>

                          {/* Status */}
                          <td className="px-4 py-3">
                            <Chip
                              size="sm"
                              variant="soft"
                              color={statusCfg.color}
                            >
                              {statusCfg.label}
                            </Chip>
                          </td>

                          {/* Scopes */}
                          <td className="px-4 py-3">
                            {issuer.allowedScopes.length > 0 ? (
                              <ScopeBadges scopes={issuer.allowedScopes} />
                            ) : (
                              <span className="text-xs text-default-400">
                                —
                              </span>
                            )}
                          </td>

                          {/* Created date */}
                          <td className="px-4 py-3 text-xs text-default-500">
                            {formatDate(issuer.createdAt)}
                          </td>

                          {/* Actions */}
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              {issuer.status === "pending" && (
                                <>
                                  <Button
                                    size="sm"
                                    variant="primary"
                                    onPress={() => setApproveTarget(issuer)}
                                  >
                                    <span className="inline-flex items-center gap-1">
                                      <IconCheck size={13} />
                                      Approve
                                    </span>
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="danger-soft"
                                    onPress={() => setRejectTarget(issuer)}
                                  >
                                    <span className="inline-flex items-center gap-1">
                                      <IconX size={13} />
                                      Reject
                                    </span>
                                  </Button>
                                </>
                              )}
                              {issuer.status === "approved" &&
                                (issuer.isBuiltIn ? (
                                  <Tooltip>
                                    <Tooltip.Trigger>
                                      <span>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          isDisabled
                                          aria-label="Cannot revoke built-in issuer"
                                        >
                                          <span className="inline-flex items-center gap-1 text-default-400">
                                            <IconLock size={13} />
                                            Cannot revoke
                                          </span>
                                        </Button>
                                      </span>
                                    </Tooltip.Trigger>
                                    <Tooltip.Content>
                                      Built-in issuers cannot be revoked
                                    </Tooltip.Content>
                                  </Tooltip>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="danger-soft"
                                    onPress={() => setRevokeTarget(issuer)}
                                  >
                                    <span className="inline-flex items-center gap-1">
                                      <IconBan size={13} />
                                      Revoke
                                    </span>
                                  </Button>
                                ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* Approve modal */}
      {approveTarget ? (
        <ApproveModal
          issuer={approveTarget}
          onClose={() => setApproveTarget(null)}
          onConfirm={handleApproveConfirm}
          isPending={approveMutation.isPending || isRedirectingBack}
        />
      ) : null}

      {/* Reject modal */}
      {rejectTarget ? (
        <RejectModal
          issuer={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onConfirm={handleRejectConfirm}
          isPending={rejectMutation.isPending}
        />
      ) : null}

      {/* Revoke modal */}
      {revokeTarget ? (
        <RevokeModal
          issuer={revokeTarget}
          onClose={() => setRevokeTarget(null)}
          onConfirm={handleRevokeConfirm}
          isPending={revokeMutation.isPending}
        />
      ) : null}
    </div>
  );
}
