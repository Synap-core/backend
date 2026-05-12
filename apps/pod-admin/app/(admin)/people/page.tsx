"use client";

/**
 * People tab — pod users, agents, and pending signups.
 *
 * Three independent SectionCards:
 *   1. Pod admins         — humans who own/admin the pod-admin workspace.
 *   2. Workspace members  — every human across every workspace, deduped.
 *   3. Agent users        — non-human (`userType="agent"`) identities.
 *
 * Each section pulls its own query and renders independently — one slow
 * call doesn't block the others. Rows use the shared `ResourceRow`; the
 * actions column lives in a HeroUI Popover so the destructive options
 * stay one click off the surface.
 *
 * Workspace members open a Drawer showing per-workspace breakdown — the
 * Pod Admin app intentionally never edits workspace internals (Studio
 * owns those surfaces). Every "Open in Studio" link deep-links there.
 *
 * Stubs are clearly marked. Where the underlying tRPC procedure doesn't
 * exist yet, we render a disabled action with a tooltip and a TODO
 * comment pointing at the gap.
 */

import {
  addToast,
  Avatar,
  Button,
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectItem,
  Spinner,
  Tooltip,
  useDisclosure,
} from "@heroui/react";
import {
  Bot,
  Check,
  CircleUser,
  Clock,
  Copy,
  Mail,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import { trpc } from "../../../lib/trpc";
import { useOperatorEmail } from "../components/admin-shell";
import { DetailDrawer } from "../components/detail-drawer";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import { StatusPill, type StatusKind } from "../components/status-pill";
import { useFocusRow } from "../components/use-focus-row";
import { formatRelative, studioDeepLinkForWorkspace } from "./_lib/helpers";

// ─── Page shell ─────────────────────────────────────────────────────

export default function PeoplePage() {
  return (
    <Suspense fallback={<PeopleFallback />}>
      <PeopleInner />
    </Suspense>
  );
}

function PeopleFallback() {
  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          People
        </h1>
      </header>
      <div className="h-9 w-full max-w-md rounded-md bg-foreground/[0.05] shimmer-pulse" />
    </div>
  );
}

function PeopleInner() {
  const inviteDisclosure = useDisclosure();
  // Read once at the page level so all sections can react to the same
  // focus param (member rows + agent rows live in different sub-cards).
  useFocusRow({ ready: true });

  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
            People
          </h1>
          <p className="text-[13px] text-foreground/55">
            Pod users, agents, and pending signups.
          </p>
        </div>
        <Button
          color="primary"
          variant="solid"
          radius="md"
          size="sm"
          startContent={<Plus className="h-3.5 w-3.5" />}
          onPress={inviteDisclosure.onOpen}
        >
          Add people
        </Button>
      </header>

      <div className="flex flex-col gap-4">
        <PodAdminsSection />
        <WorkspaceMembersSection />
        <AgentUsersSection />
        <PendingInvitesSection />
      </div>

      <AddPeopleModal
        isOpen={inviteDisclosure.isOpen}
        onClose={inviteDisclosure.onClose}
      />
    </div>
  );
}

// ─── 1. Pod admins ──────────────────────────────────────────────────

/**
 * Pod admins are humans whose membership in the `pod-admin` (operational)
 * workspace has role `owner` or `admin`. We surface them here so the
 * operator has a single place to see who can sign into this surface.
 *
 * The list is derived client-side from `workspaces.adminListAll` +
 * `workspaces.listMembers(pod-admin)`. There is no dedicated procedure
 * yet — TODO(phase-C): add `users.listPodAdmins` so we can drop two
 * round-trips.
 */
function PodAdminsSection() {
  const workspacesQuery = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
  });

  // Find the pod-admin workspace by `settings.systemSlug === "pod-admin"`
  // — the same gate the backend uses to identify it.
  const podAdminWorkspaceId = useMemo(() => {
    if (!workspacesQuery.data) return undefined;
    for (const ws of workspacesQuery.data) {
      const settings = (ws.settings ?? {}) as Record<string, unknown>;
      if (settings.systemSlug === "pod-admin") return ws.id;
    }
    return undefined;
  }, [workspacesQuery.data]);

  const membersQuery = trpc.workspaces.listMembers.useQuery(
    { workspaceId: podAdminWorkspaceId ?? "" },
    {
      enabled: !!podAdminWorkspaceId,
      staleTime: 60_000,
    }
  );

  const isLoading =
    workspacesQuery.isLoading ||
    (!!podAdminWorkspaceId && membersQuery.isLoading);
  const isError = workspacesQuery.isError || membersQuery.isError;

  const admins = useMemo(() => {
    if (!membersQuery.data) return [];
    return membersQuery.data
      .filter(
        (m) =>
          m.user?.userType === "human" &&
          (m.role === "owner" || m.role === "admin")
      )
      .map((m) => ({
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        avatarUrl: m.user.avatarUrl,
        role: m.role,
        joinedAt: m.joinedAt,
      }));
  }, [membersQuery.data]);

  return (
    <SectionCard
      title="Pod admins"
      hint="Humans with sign-in to this admin surface"
      actions={
        admins.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/55">
            {admins.length} {admins.length === 1 ? "admin" : "admins"}
          </span>
        ) : null
      }
    >
      {isLoading ? (
        <ResourceRowSkeleton count={2} />
      ) : isError ? (
        <ResourceRowError message="Couldn't load pod admins." />
      ) : admins.length === 0 ? (
        <ResourceRowEmpty message="No pod admins yet — invite one above." />
      ) : (
        <div className="-mx-2">
          {admins.map((admin) => (
            <div
              key={admin.id}
              data-row-id={admin.id}
              className="rounded-md transition-shadow"
            >
              <ResourceRow
                Icon={ShieldCheck}
                primary={admin.name ?? admin.email}
                secondary={`${admin.email} · ${admin.role}`}
                status={{ kind: "healthy", label: admin.role }}
                actions={
                  <PodAdminActions
                    userId={admin.id}
                    email={admin.email}
                    isAdmin={admin.role === "owner" || admin.role === "admin"}
                    adminCount={admins.length}
                  />
                }
              />
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function PodAdminActions({
  userId,
  email,
  isAdmin,
  adminCount,
}: {
  userId: string;
  email: string;
  isAdmin: boolean;
  adminCount: number;
}) {
  const utils = trpc.useUtils();
  const operatorEmail = useOperatorEmail();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const resetMutation = trpc.system.resetUserPassword.useMutation({
    onSuccess: () => {
      void utils.system.listUsers.invalidate();
    },
  });

  const deleteMutation = trpc.system.deleteUser.useMutation({
    onSuccess: () => {
      void utils.workspaces.adminListAll.invalidate();
      void utils.workspaces.listPodMembers.invalidate();
      void utils.system.listUsers.invalidate();
      addToast({
        title: "User removed",
        description: `${email} has been deleted.`,
        color: "default",
      });
      setConfirmRemove(false);
    },
    onError: (err) => {
      addToast({
        title: "Remove failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  // Disable Remove for self-delete and "last pod admin" cases. Demote
  // remains stubbed (no backed procedure yet).
  const isSelf = !!operatorEmail && operatorEmail === email;
  const isLastAdmin = isAdmin && adminCount <= 1;
  const removeDisabledReason = isSelf
    ? "You can't remove yourself."
    : isLastAdmin
      ? "Pod must have at least one admin."
      : null;

  return (
    <>
      <Popover placement="bottom-end">
        <PopoverTrigger>
          <Button
            isIconOnly
            variant="light"
            size="sm"
            radius="full"
            aria-label={`Actions for ${email}`}
            className="text-foreground/40 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="min-w-[200px] max-w-[260px] p-1">
          <div className="flex w-full flex-col">
            <Button
              variant="light"
              size="sm"
              radius="sm"
              isDisabled={resetMutation.isPending}
              className="justify-start text-[12.5px]"
              onPress={() => resetMutation.mutate({ mode: "single", userId })}
            >
              {resetMutation.isPending ? "Resetting…" : "Reset password"}
            </Button>
            <Tooltip content="Pending: workspaces.demoteMember">
              <span className="block">
                <Button
                  variant="light"
                  size="sm"
                  radius="sm"
                  isDisabled
                  className="w-full justify-start text-[12.5px] text-warning"
                >
                  Demote
                </Button>
              </span>
            </Tooltip>
            {removeDisabledReason ? (
              <Tooltip content={removeDisabledReason}>
                <span className="block">
                  <Button
                    variant="light"
                    size="sm"
                    radius="sm"
                    isDisabled
                    className="w-full justify-start text-[12.5px] text-danger"
                  >
                    Remove
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button
                variant="light"
                size="sm"
                radius="sm"
                className="w-full justify-start text-[12.5px] text-danger"
                onPress={() => setConfirmRemove(true)}
              >
                Remove
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {confirmRemove ? (
        <ConfirmRemoveUserModal
          email={email}
          isPending={deleteMutation.isPending}
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => deleteMutation.mutate({ userId })}
        />
      ) : null}
    </>
  );
}

function ConfirmRemoveUserModal({
  email,
  isPending,
  onCancel,
  onConfirm,
}: {
  email: string;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose: onCancel,
  });

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1 border-b border-foreground/[0.06] px-6 py-4">
          <h2 className="text-[15px] font-medium text-foreground">
            Remove {email}?
          </h2>
        </ModalHeader>
        <ModalBody className="gap-2 px-6 py-4">
          <p className="text-[12.5px] text-foreground/85">
            Permanently delete user? This deletes their workspace memberships,
            agent users, and API keys.
          </p>
          <p className="text-[11.5px] text-foreground/55">
            This cannot be undone.
          </p>
        </ModalBody>
        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          <Button
            variant="flat"
            radius="md"
            size="sm"
            onPress={onCancel}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            color="danger"
            variant="solid"
            radius="md"
            size="sm"
            isLoading={isPending}
            onPress={onConfirm}
          >
            Remove user
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── 2. Workspace members ───────────────────────────────────────────

type PodMember = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  primaryRole: "owner" | "admin" | "editor" | "viewer";
  workspaceCount: number;
  workspaces: Array<{
    id: string;
    name: string;
    role: string;
    joinedAt: Date | string;
  }>;
};

/**
 * Workspace members surfaces every human across the pod, deduplicated by
 * userId, with the highest role they hold across any workspace.
 */
function WorkspaceMembersSection() {
  const query = trpc.workspaces.listPodMembers.useQuery(undefined, {
    staleTime: 60_000,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const drawer = useDisclosure();

  const members = query.data ?? [];
  const grouped = useMemo(() => groupByPrimaryRole(members), [members]);

  const selected =
    selectedId != null
      ? (members.find((m) => m.id === selectedId) ?? null)
      : null;

  return (
    <SectionCard
      title="Workspace members"
      hint="Every human with at least one workspace membership"
      actions={
        members.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/55">
            {members.length} {members.length === 1 ? "member" : "members"}
          </span>
        ) : null
      }
    >
      {query.isLoading ? (
        <ResourceRowSkeleton count={3} />
      ) : query.isError ? (
        <ResourceRowError message="Couldn't load workspace members." />
      ) : members.length === 0 ? (
        <ResourceRowEmpty message="No workspace members yet." />
      ) : (
        <div className="flex flex-col gap-3">
          {(["owner", "admin", "editor", "viewer"] as const).map((role) => {
            const bucket = grouped[role];
            if (!bucket || bucket.length === 0) return null;
            return (
              <div key={role} className="flex flex-col">
                <div className="px-3 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wider text-foreground/40">
                  {role}s · {bucket.length}
                </div>
                <div className="-mx-2">
                  {bucket.map((m) => (
                    <div
                      key={m.id}
                      data-row-id={m.id}
                      className="rounded-md transition-shadow"
                    >
                      <ResourceRow
                        Icon={CircleUser}
                        primary={m.name ?? m.email}
                        secondary={`${m.email} · in ${m.workspaceCount} ${
                          m.workspaceCount === 1 ? "workspace" : "workspaces"
                        }`}
                        status={{
                          kind: rolePillKind(m.primaryRole),
                          label: m.primaryRole,
                        }}
                        onSelect={() => {
                          setSelectedId(m.id);
                          drawer.onOpen();
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <MemberDrawer
        member={selected}
        isOpen={drawer.isOpen}
        onClose={drawer.onClose}
      />
    </SectionCard>
  );
}

function MemberDrawer({
  member,
  isOpen,
  onClose,
}: {
  member: PodMember | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  return (
    <DetailDrawer
      isOpen={isOpen}
      onClose={onClose}
      title={member?.name ?? member?.email ?? "—"}
      subtitle={
        member ? <span className="font-mono">{member.email}</span> : undefined
      }
      headerAccessory={
        <Avatar
          src={member?.avatarUrl ?? undefined}
          name={member?.name ?? member?.email ?? "?"}
          size="md"
          radius="md"
          classNames={{ base: "shrink-0" }}
        />
      }
      footer={
        <>
          <Button variant="flat" radius="md" size="sm" onPress={onClose}>
            Close
          </Button>
          {member && member.workspaces[0] ? (
            <Button
              as="a"
              href={studioDeepLinkForWorkspace(member.workspaces[0].id)}
              target="_blank"
              rel="noopener noreferrer"
              color="primary"
              variant="solid"
              radius="md"
              size="sm"
            >
              Open in Studio
            </Button>
          ) : null}
        </>
      }
    >
      {member ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-foreground/45">
              Primary role
            </span>
            <StatusPill
              kind={rolePillKind(member.primaryRole)}
              label={member.primaryRole}
            />
          </div>
          <div>
            <h4 className="mb-2 text-[12px] font-medium text-foreground">
              Workspaces
            </h4>
            <div className="flex flex-col gap-1.5">
              {member.workspaces.map((ws) => (
                <div
                  key={ws.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-foreground/[0.06] bg-foreground/[0.02] px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[12.5px] font-medium text-foreground">
                      {ws.name || ws.id.slice(0, 8)}
                    </span>
                    <span className="truncate font-mono text-[10.5px] text-foreground/40">
                      {ws.id}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[11px] text-foreground/55">
                      {ws.role}
                    </span>
                    <span className="tabular text-[11px] text-foreground/40">
                      {formatRelative(new Date(ws.joinedAt))}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </DetailDrawer>
  );
}

function groupByPrimaryRole(
  members: PodMember[]
): Record<"owner" | "admin" | "editor" | "viewer", PodMember[]> {
  const out: Record<"owner" | "admin" | "editor" | "viewer", PodMember[]> = {
    owner: [],
    admin: [],
    editor: [],
    viewer: [],
  };
  for (const m of members) {
    if (m.primaryRole in out) out[m.primaryRole].push(m);
  }
  return out;
}

function rolePillKind(role: string): StatusKind {
  if (role === "owner") return "healthy";
  if (role === "admin") return "stale";
  if (role === "editor") return "unknown";
  return "unknown";
}

// ─── 3. Agent users ─────────────────────────────────────────────────

/**
 * Agent users are non-human identities (`userType: "agent"`). They exist
 * pod-wide even though each is bound to one workspace — that's why they
 * surface here, not in Studio's per-workspace settings.
 *
 * Discovery uses `system.listUsers` filtered to `type: "agent"`. The
 * dedicated `agentUsers.list` procedure requires a workspaceId and isn't
 * usable for a pod-wide roster.
 */
function AgentUsersSection() {
  const query = trpc.system.listUsers.useQuery(
    { type: "agent", limit: 200 },
    { staleTime: 60_000 }
  );

  return (
    <SectionCard
      title="Agent users"
      hint="Pod-level identities owned by AI agents (workspace-scoped)"
      actions={
        query.data && query.data.users.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/55">
            {query.data.users.length} agent
            {query.data.users.length === 1 ? "" : "s"}
          </span>
        ) : null
      }
    >
      {query.isLoading ? (
        <ResourceRowSkeleton count={2} />
      ) : query.isError ? (
        <ResourceRowError message="Couldn't load agent users." />
      ) : !query.data || query.data.users.length === 0 ? (
        <ResourceRowEmpty message="No agent users yet." />
      ) : (
        <div className="-mx-2">
          {query.data.users.map((agent) => {
            const meta = (agent.agentMetadata ?? {}) as {
              agentType?: string;
              description?: string;
            };
            const created = agent.createdAt
              ? formatRelative(new Date(agent.createdAt))
              : "—";
            // Active status: heuristic — workspaceMembershipCount > 0
            // means the agent is reachable in at least one workspace.
            // A real "key was used recently" hook would need
            // apiKeys.adminListAll + lastUsedAt.
            // TODO(phase-C): join apiKeys.lastUsedAt for an accurate
            // "active" badge.
            const isActive = agent.workspaceMembershipCount > 0;
            return (
              <div
                key={agent.id}
                data-row-id={agent.id}
                className="rounded-md transition-shadow"
              >
                <ResourceRow
                  Icon={Bot}
                  primary={agent.name ?? agent.email}
                  secondary={`${meta.agentType ?? "agent"} · ${
                    agent.workspaceMembershipCount
                  } workspace${agent.workspaceMembershipCount === 1 ? "" : "s"} · created ${created}`}
                  status={
                    isActive
                      ? { kind: "healthy", label: "active" }
                      : { kind: "unknown", label: "idle" }
                  }
                  actions={<AgentUserActions userId={agent.id} />}
                />
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function AgentUserActions({ userId }: { userId: string }) {
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState<null | "revoke" | "remove">(null);

  const revokeMutation = trpc.apiKeys.adminRevokeAllForUser.useMutation({
    onSuccess: (res) => {
      void utils.system.listUsers.invalidate();
      void utils.apiKeys.adminListAll.invalidate();
      addToast({
        title: "Keys revoked",
        description: `${res.revokedCount} key${
          res.revokedCount === 1 ? "" : "s"
        } revoked.`,
        color: "default",
      });
      setConfirm(null);
    },
    onError: (err) => {
      addToast({
        title: "Revoke failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const removeMutation = trpc.agentUsers.removeByUserId.useMutation({
    onSuccess: (res) => {
      void utils.system.listUsers.invalidate();
      void utils.apiKeys.adminListAll.invalidate();
      addToast({
        title: "Agent removed",
        description: `Removed ${res.removedCount} membership${
          res.removedCount === 1 ? "" : "s"
        } and revoked ${res.revokedKeyCount} key${
          res.revokedKeyCount === 1 ? "" : "s"
        }.`,
        color: "default",
      });
      setConfirm(null);
    },
    onError: (err) => {
      addToast({
        title: "Remove failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  return (
    <>
      <Popover placement="bottom-end">
        <PopoverTrigger>
          <Button
            isIconOnly
            variant="light"
            size="sm"
            radius="full"
            aria-label="Agent actions"
            className="text-foreground/40 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="min-w-[200px] max-w-[260px] p-1">
          <div className="flex w-full flex-col">
            <Button
              variant="light"
              size="sm"
              radius="sm"
              className="w-full justify-start text-[12.5px]"
              onPress={() => setConfirm("revoke")}
            >
              Revoke keys
            </Button>
            <Button
              variant="light"
              size="sm"
              radius="sm"
              className="w-full justify-start text-[12.5px] text-danger"
              onPress={() => setConfirm("remove")}
            >
              Remove
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {confirm === "revoke" ? (
        <ConfirmAgentActionModal
          title="Revoke API keys"
          message="Revoke all API keys for this agent? Existing connections using those keys will fail immediately."
          confirmLabel="Revoke keys"
          isPending={revokeMutation.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => revokeMutation.mutate({ userId })}
        />
      ) : null}
      {confirm === "remove" ? (
        <ConfirmAgentActionModal
          title="Remove agent"
          message="Remove this agent and revoke all its keys? This drops every workspace membership and cannot be undone."
          confirmLabel="Remove agent"
          isPending={removeMutation.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => removeMutation.mutate({ userId })}
        />
      ) : null}
    </>
  );
}

function ConfirmAgentActionModal({
  title,
  message,
  confirmLabel,
  isPending,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose: onCancel,
  });

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1 border-b border-foreground/[0.06] px-6 py-4">
          <h2 className="text-[15px] font-medium text-foreground">{title}</h2>
        </ModalHeader>
        <ModalBody className="gap-2 px-6 py-4">
          <p className="text-[12.5px] text-foreground/85">{message}</p>
        </ModalBody>
        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          <Button
            variant="flat"
            radius="md"
            size="sm"
            onPress={onCancel}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            color="danger"
            variant="solid"
            radius="md"
            size="sm"
            isLoading={isPending}
            onPress={onConfirm}
          >
            {confirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── Add people modal ────────────────────────────────────────────────

const ROLE_OPTIONS: Array<{
  key: "admin" | "editor" | "viewer";
  label: string;
  hint: string;
}> = [
  {
    key: "admin",
    label: "Admin",
    hint: "Full access, can sign in to Pod Admin",
  },
  { key: "editor", label: "Editor", hint: "Can read and write content" },
  { key: "viewer", label: "Viewer", hint: "Read-only access" },
];

type InviteResultItem = {
  token: string;
  emailSent: boolean;
  workspaceName?: string;
};

function AddPeopleModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "editor" | "viewer">("editor");
  const [scope, setScope] = useState<"pod" | "workspaces">("pod");
  const [selectedWs, setSelectedWs] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<InviteResultItem[] | null>(null);
  const [sending, setSending] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const utils = trpc.useUtils();
  const wsQuery = trpc.workspaces.adminListAll.useQuery(undefined, {
    enabled: isOpen && scope === "workspaces",
    staleTime: 60_000,
  });
  const userWorkspaces = useMemo(
    () =>
      (wsQuery.data ?? []).filter((ws) => {
        const s = (ws.settings ?? {}) as Record<string, unknown>;
        return s.systemSlug !== "pod-admin";
      }),
    [wsQuery.data]
  );

  const createInvite = trpc.workspaces.createInvite.useMutation();

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  async function handleSubmit() {
    const trimEmail = email.trim();
    if (!trimEmail) return;
    if (scope === "workspaces" && selectedWs.size === 0) {
      setError("Select at least one workspace.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      if (scope === "pod") {
        const data = await createInvite.mutateAsync({
          type: "pod",
          email: trimEmail,
          role,
        });
        setResults([{ token: data.token, emailSent: data.emailSent }]);
      } else {
        const items: InviteResultItem[] = [];
        for (const wsId of Array.from(selectedWs)) {
          const ws = userWorkspaces.find((w) => w.id === wsId);
          const data = await createInvite.mutateAsync({
            type: "workspace",
            workspaceId: wsId,
            email: trimEmail,
            role,
          });
          items.push({
            token: data.token,
            emailSent: data.emailSent,
            workspaceName: ws?.name,
          });
        }
        setResults(items);
      }
      void utils.workspaces.listInvites.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create invite");
    } finally {
      setSending(false);
    }
  }

  function handleCopy(url: string, idx: number) {
    void navigator.clipboard.writeText(url).then(() => {
      setCopiedIdx(idx);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedIdx(null), 2000);
    });
  }

  function handleClose() {
    setEmail("");
    setRole("editor");
    setScope("pod");
    setSelectedWs(new Set());
    setError(null);
    setResults(null);
    setSending(false);
    onClose();
  }

  const canSubmit =
    !!email.trim() && !sending && (scope === "pod" || selectedWs.size > 0);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      placement="center"
      size="md"
      backdrop="blur"
      isDismissable={!sending}
    >
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1 border-b border-foreground/[0.06] px-6 py-4">
          <h2 className="text-[15px] font-medium text-foreground">
            Add people
          </h2>
          <p className="text-[12px] text-foreground/55">
            {results
              ? "Share these invite links with the recipient."
              : "Invite links are valid for 7 days."}
          </p>
        </ModalHeader>

        <ModalBody className="gap-4 px-6 py-4">
          {results ? (
            /* ── Success state ── */
            <div className="flex flex-col gap-2">
              {results.map((r, i) => {
                const url = `${origin}/invite/${r.token}`;
                return (
                  <div key={r.token} className="flex flex-col gap-1.5">
                    {r.workspaceName ? (
                      <span className="text-[11px] font-medium text-foreground/55">
                        {r.workspaceName}
                      </span>
                    ) : null}
                    <div
                      className={`rounded-md px-3 py-1.5 text-[11.5px] ring-1 ring-inset ${r.emailSent ? "bg-status-healthy/10 text-status-healthy ring-status-healthy/20" : "bg-foreground/[0.04] text-foreground/60 ring-foreground/10"}`}
                    >
                      {r.emailSent
                        ? "Email sent — link is a backup."
                        : "No email service — share this link directly."}
                    </div>
                    <div className="flex items-center gap-2 rounded-md bg-foreground/[0.04] px-3 py-2 ring-1 ring-inset ring-foreground/10">
                      <span className="flex-1 truncate font-mono text-[11px] text-foreground/65">
                        {url}
                      </span>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="flat"
                        radius="md"
                        onPress={() => handleCopy(url, i)}
                        aria-label="Copy"
                      >
                        {copiedIdx === i ? (
                          <Check className="h-3.5 w-3.5 text-status-healthy" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* ── Form state ── */
            <>
              <Input
                label="Email"
                labelPlacement="outside"
                type="email"
                placeholder="colleague@example.com"
                value={email}
                onValueChange={setEmail}
                radius="md"
                variant="flat"
                startContent={
                  <Mail className="h-3.5 w-3.5 text-foreground/40" />
                }
                isDisabled={sending}
              />

              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-foreground/70">
                  Role
                </span>
                <div className="flex gap-2">
                  {ROLE_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setRole(opt.key)}
                      disabled={sending}
                      className={`flex-1 rounded-md border px-3 py-2 text-left transition-colors ${role === opt.key ? "border-primary/60 bg-primary/10 text-primary" : "border-foreground/10 bg-foreground/[0.03] text-foreground/70 hover:border-foreground/20"}`}
                    >
                      <div className="text-[12px] font-medium">{opt.label}</div>
                      <div className="mt-0.5 text-[10.5px] opacity-70">
                        {opt.hint}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-foreground/70">
                  Access scope
                </span>
                <div className="flex gap-1 rounded-md bg-foreground/[0.04] p-1">
                  {(["pod", "workspaces"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setScope(s)}
                      disabled={sending}
                      className={`flex-1 rounded py-1.5 text-[12px] font-medium transition-colors ${scope === s ? "bg-foreground/[0.08] text-foreground" : "text-foreground/50 hover:text-foreground/70"}`}
                    >
                      {s === "pod" ? "Pod-wide" : "Specific workspaces"}
                    </button>
                  ))}
                </div>
                {scope === "pod" && (
                  <p className="text-[11.5px] text-foreground/45">
                    Person joins all existing workspaces. Admins can also sign
                    in to this Pod Admin surface.
                  </p>
                )}
              </div>

              {scope === "workspaces" && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-foreground/70">
                    Workspaces
                  </span>
                  {wsQuery.isLoading ? (
                    <div className="h-20 rounded-md bg-foreground/[0.04] shimmer-pulse" />
                  ) : userWorkspaces.length === 0 ? (
                    <p className="text-[12px] text-foreground/45">
                      No workspaces found.
                    </p>
                  ) : (
                    <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md bg-foreground/[0.03] p-2 ring-1 ring-inset ring-foreground/10">
                      {userWorkspaces.map((ws) => (
                        <Checkbox
                          key={ws.id}
                          size="sm"
                          isSelected={selectedWs.has(ws.id)}
                          onValueChange={(checked) => {
                            setSelectedWs((prev) => {
                              const next = new Set(prev);
                              if (checked) next.add(ws.id);
                              else next.delete(ws.id);
                              return next;
                            });
                          }}
                          classNames={{
                            label: "text-[12px] text-foreground/80",
                          }}
                        >
                          {ws.name}
                        </Checkbox>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {error ? (
                <div className="rounded-md bg-status-down/10 px-3 py-2 text-[12px] text-status-down ring-1 ring-inset ring-status-down/20">
                  {error}
                </div>
              ) : null}
            </>
          )}
        </ModalBody>

        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          <Button
            variant="flat"
            radius="md"
            size="sm"
            onPress={handleClose}
            isDisabled={sending}
          >
            {results ? "Done" : "Cancel"}
          </Button>
          {!results ? (
            <Button
              color="primary"
              variant="solid"
              radius="md"
              size="sm"
              onPress={() => void handleSubmit()}
              isDisabled={!canSubmit}
              startContent={sending ? <Spinner size="sm" /> : null}
            >
              {sending ? "Sending…" : "Send invite"}
            </Button>
          ) : null}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── Pending invites section ─────────────────────────────────────────

function PendingInvitesSection() {
  const invitesQuery = trpc.workspaces.listInvites.useQuery(
    { type: "pod" },
    { staleTime: 30_000 }
  );

  const revokeMutation = trpc.workspaces.revokeInvite.useMutation({
    onSuccess: () => {
      void invitesQuery.refetch();
      addToast({ title: "Invite revoked", color: "default" });
    },
    onError: (e) => {
      addToast({
        title: "Revoke failed",
        description: e.message,
        color: "danger",
      });
    },
  });

  const pending = invitesQuery.data ?? [];

  if (!invitesQuery.isLoading && pending.length === 0) return null;

  return (
    <SectionCard
      title="Pending invites"
      hint="Sent but not yet accepted"
      actions={
        pending.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/55">
            {pending.length} pending
          </span>
        ) : null
      }
    >
      {invitesQuery.isLoading ? (
        <ResourceRowSkeleton count={1} />
      ) : invitesQuery.isError ? (
        <ResourceRowError message="Couldn't load pending invites." />
      ) : (
        <div className="-mx-2">
          {pending.map((inv) => (
            <ResourceRow
              key={inv.id}
              Icon={Clock}
              primary={inv.email}
              secondary={`${inv.role} · expires ${formatRelative(inv.expiresAt)}`}
              status={{ kind: "degraded" as StatusKind, label: "pending" }}
              actions={
                <Button
                  size="sm"
                  variant="flat"
                  radius="md"
                  color="danger"
                  isLoading={
                    revokeMutation.isPending &&
                    revokeMutation.variables?.id === inv.id
                  }
                  onPress={() => revokeMutation.mutate({ id: inv.id })}
                >
                  Revoke
                </Button>
              }
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// Suppress unused-import warnings for icons referenced by lookup only.
void (Users as LucideIcon);
