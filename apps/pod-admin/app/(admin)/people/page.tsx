"use client";

/**
 * People tab — pod users, agents, and pending signups.
 *
 * Three independent SectionCards:
 *   1. Pod admins         — humans who own/admin the pod-admin workspace.
 *   2. Workspace members  — every human across every workspace, deduped.
 *   3. Agent users        — non-human (`userType="agent"`) identities.
 *
 * `listPodMembers` is lifted to the page level so both PodAdminsSection
 * and WorkspaceMembersSection share the same data + a single UserDetailDrawer.
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
  ExternalLink,
  KeyRound,
  Mail,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  Trash2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { useOperatorEmail } from "../components/admin-shell";
import { ConfirmModal } from "../components/confirm-modal";
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
import { formatExpiresAt, formatRelative } from "./_lib/helpers";
import { openIn } from "../../../lib/open-in";
import { ExitFallback } from "../../../lib/exit-link";

/**
 * The exit from a membership row to that workspace in the desktop app.
 *
 * The row carries only the LINK. The "get the app" fallback is rendered once
 * beneath the list instead of inside every row — `open-in.ts` says so in as
 * many words, and someone in six workspaces should not be told to install the
 * app six times. 40px target, because 24px was not a real one.
 */
function WorkspaceExit({ workspaceId }: { workspaceId: string }) {
  const exit = openIn({
    kind: "object",
    objectKind: "workspace",
    id: workspaceId,
  });
  return (
    <Button
      as="a"
      href={exit.href}
      isIconOnly
      size="sm"
      radius="full"
      variant="light"
      aria-label="Open this workspace in the desktop app"
      className="h-10 w-10 min-w-10 text-foreground/60 hover:text-foreground"
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </Button>
  );
}

// ─── Types ───────────────────────────────────────────────────────────

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

// ─── Page shell ──────────────────────────────────────────────────────

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
  useFocusRow({ ready: true });

  // Lifted so both PodAdminsSection and WorkspaceMembersSection share data.
  const podMembersQuery = trpc.workspaces.listPodMembers.useQuery(undefined, {
    staleTime: 60_000,
  });

  useEffect(() => {
    if (podMembersQuery.isError) {
      redirectToLoginIfUnauthorized(podMembersQuery.error, "/people");
    }
  }, [podMembersQuery.isError, podMembersQuery.error]);
  const isAuthRedirecting =
    podMembersQuery.error?.data?.code === "UNAUTHORIZED";

  // Single shared drawer for all human user detail.
  const [selectedMember, setSelectedMember] = useState<PodMember | null>(null);
  const [selectedIsPodAdmin, setSelectedIsPodAdmin] = useState(false);
  const drawerDisclosure = useDisclosure();

  function openMember(member: PodMember, isPodAdmin: boolean) {
    setSelectedMember(member);
    setSelectedIsPodAdmin(isPodAdmin);
    drawerDisclosure.onOpen();
  }

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
        <PodAdminsSection
          podMembers={podMembersQuery.data}
          onOpenMember={openMember}
        />
        <WorkspaceMembersSection
          members={podMembersQuery.data ?? []}
          isLoading={podMembersQuery.isLoading || isAuthRedirecting}
          isError={podMembersQuery.isError}
          onOpenMember={(m) => openMember(m, false)}
        />
        <AgentUsersSection />
        <PendingInvitesSection />
      </div>

      <UserDetailDrawer
        member={selectedMember}
        isPodAdmin={selectedIsPodAdmin}
        isOpen={drawerDisclosure.isOpen}
        onClose={drawerDisclosure.onClose}
      />

      <AddPeopleModal
        isOpen={inviteDisclosure.isOpen}
        onClose={inviteDisclosure.onClose}
      />
    </div>
  );
}

// ─── Shared: UserDetailDrawer ────────────────────────────────────────

function UserDetailDrawer({
  member,
  isPodAdmin,
  isOpen,
  onClose,
}: {
  member: PodMember | null;
  isPodAdmin: boolean;
  isOpen: boolean;
  onClose: () => void;
}) {
  const operatorEmail = useOperatorEmail();
  const utils = trpc.useUtils();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const isSelf = !!operatorEmail && operatorEmail === member?.email;

  const resetMutation = trpc.system.resetUserPassword.useMutation({
    onSuccess: () => {
      addToast({
        title: "Password reset",
        description: `Reset sent to ${member?.email}.`,
        color: "default",
      });
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err, "/people")) return;
      addToast({
        title: "Reset failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const removeMutation = trpc.workspaces.removeFromPod.useMutation({
    onSuccess: () => {
      void utils.workspaces.listPodMembers.invalidate();
      void utils.workspaces.adminListAll.invalidate();
      void utils.workspaces.listInvites.invalidate();
      addToast({
        title: "User removed",
        description: `${member?.email} has been removed from the pod.`,
        color: "default",
      });
      setConfirmRemove(false);
      onClose();
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err, "/people")) return;
      addToast({
        title: "Remove failed",
        description: err.message,
        color: "danger",
      });
      setConfirmRemove(false);
    },
  });

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
      /* The footer used to carry a single "Open in Studio" button built from
         `member.workspaces[0]` — an arbitrary pick that silently lied whenever
         someone belonged to more than one workspace, and pointed at the
         deprecated fluid app besides. Each membership row below now carries
         its own exit, so the destination always matches the row you clicked. */
      footer={
        <Button variant="flat" radius="md" size="sm" onPress={onClose}>
          Close
        </Button>
      }
    >
      {member ? (
        <div className="flex flex-col gap-5">
          {/* Identity */}
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              kind={rolePillKind(member.primaryRole)}
              label={member.primaryRole}
            />
            {isPodAdmin && <StatusPill kind="healthy" label="Pod admin" />}
          </div>

          {/* Workspace memberships */}
          <div>
            <h4 className="mb-2 text-[12px] font-medium text-foreground">
              Workspaces ({member.workspaces.length})
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
                    <StatusPill kind={rolePillKind(ws.role)} label={ws.role} />
                    <span className="tabular text-[11px] text-foreground/40">
                      {formatRelative(new Date(ws.joinedAt))}
                    </span>
                    <WorkspaceExit workspaceId={ws.id} />
                  </div>
                </div>
              ))}
            </div>
            {member.workspaces.length > 0 && (
              <p className="mt-2 text-[12px] text-foreground/70">
                Workspaces open in the desktop app.{" "}
                <ExitFallback
                  exit={openIn({
                    kind: "object",
                    objectKind: "workspace",
                    id: member.workspaces[0]!.id,
                  })}
                />
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="border-t border-foreground/[0.06] pt-4">
            <h4 className="mb-2 text-[12px] font-medium text-foreground">
              Actions
            </h4>
            <div className="flex flex-col gap-2">
              <Button
                variant="flat"
                size="sm"
                radius="md"
                startContent={<KeyRound className="h-3.5 w-3.5" />}
                isDisabled={resetMutation.isPending}
                isLoading={resetMutation.isPending}
                className="justify-start text-[12.5px]"
                onPress={() =>
                  member &&
                  resetMutation.mutate({ mode: "single", userId: member.id })
                }
              >
                Reset password
              </Button>

              {isSelf ? (
                <Tooltip content="You can't remove yourself.">
                  <span className="block">
                    <Button
                      variant="flat"
                      size="sm"
                      radius="md"
                      color="danger"
                      isDisabled
                      startContent={<Trash2 className="h-3.5 w-3.5" />}
                      className="w-full justify-start text-[12.5px]"
                    >
                      Remove from pod
                    </Button>
                  </span>
                </Tooltip>
              ) : (
                <Button
                  variant="flat"
                  size="sm"
                  radius="md"
                  color="danger"
                  startContent={<Trash2 className="h-3.5 w-3.5" />}
                  className="justify-start text-[12.5px]"
                  onPress={() => setConfirmRemove(true)}
                >
                  Remove from pod
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmModal
        isOpen={confirmRemove && Boolean(member)}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => {
          if (member) removeMutation.mutate({ userId: member.id });
        }}
        title={`Remove ${member?.email ?? "this person"}?`}
        consequence={
          <>
            <p>
              This removes them from all workspaces and deletes their pod
              account. This cannot be undone.
            </p>
            <p className="mt-2">
              They can be re-invited with the same email afterwards, and the
              data they created stays on the pod.
            </p>
          </>
        }
        confirmLabel="Remove user"
        isPending={removeMutation.isPending}
      />
    </DetailDrawer>
  );
}

// ─── 1. Pod admins ───────────────────────────────────────────────────

function PodAdminsSection({
  podMembers,
  onOpenMember,
}: {
  podMembers: PodMember[] | undefined;
  onOpenMember: (member: PodMember, isPodAdmin: boolean) => void;
}) {
  const workspacesQuery = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
  });

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
    { enabled: !!podAdminWorkspaceId, staleTime: 60_000 }
  );

  useEffect(() => {
    if (workspacesQuery.isError || membersQuery.isError) {
      redirectToLoginIfUnauthorized(
        workspacesQuery.error ?? membersQuery.error,
        "/people"
      );
    }
  }, [
    workspacesQuery.isError,
    workspacesQuery.error,
    membersQuery.isError,
    membersQuery.error,
  ]);
  const isAuthRedirecting =
    workspacesQuery.error?.data?.code === "UNAUTHORIZED" ||
    membersQuery.error?.data?.code === "UNAUTHORIZED";

  const isLoading =
    workspacesQuery.isLoading ||
    (!!podAdminWorkspaceId && membersQuery.isLoading) ||
    isAuthRedirecting;
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
          {admins.map((admin) => {
            // Look up full workspace breakdown from the shared pod members query.
            const fullMember = podMembers?.find((m) => m.id === admin.id) ?? {
              id: admin.id,
              email: admin.email,
              name: admin.name,
              avatarUrl: admin.avatarUrl,
              primaryRole: admin.role as PodMember["primaryRole"],
              workspaceCount: 0,
              workspaces: [],
            };
            return (
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
                  onSelect={() => onOpenMember(fullMember, true)}
                />
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

// ─── 2. Workspace members ────────────────────────────────────────────

function WorkspaceMembersSection({
  members,
  isLoading,
  isError,
  onOpenMember,
}: {
  members: PodMember[];
  isLoading: boolean;
  isError: boolean;
  onOpenMember: (member: PodMember) => void;
}) {
  const grouped = useMemo(() => groupByPrimaryRole(members), [members]);

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
      {isLoading ? (
        <ResourceRowSkeleton count={3} />
      ) : isError ? (
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
                        onSelect={() => onOpenMember(m)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

// ─── 3. Agent users ──────────────────────────────────────────────────

function AgentUsersSection() {
  const query = trpc.system.listUsers.useQuery(
    { type: "agent", limit: 200 },
    { staleTime: 60_000 }
  );

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error, "/people");
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

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
      {query.isLoading || isAuthRedirecting ? (
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
        description: `${res.revokedCount} key${res.revokedCount === 1 ? "" : "s"} revoked.`,
        color: "default",
      });
      setConfirm(null);
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err, "/people")) return;
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
        } and revoked ${res.revokedKeyCount} key${res.revokedKeyCount === 1 ? "" : "s"}.`,
        color: "default",
      });
      setConfirm(null);
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err, "/people")) return;
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

      <ConfirmModal
        isOpen={confirm === "revoke"}
        onClose={() => setConfirm(null)}
        onConfirm={() => revokeMutation.mutate({ userId })}
        title="Revoke API keys"
        consequence={
          <>
            <p>
              Revokes all API keys for this agent. Existing connections using
              those keys will fail immediately.
            </p>
            <p className="mt-2">
              The agent itself stays on the pod with its workspace memberships
              intact, and can be issued a new key.
            </p>
          </>
        }
        confirmLabel="Revoke keys"
        /* Scoped to THIS mutation, and only one of the two dialogs can be open
           at a time — `confirm` is a single slot, so a revoke in flight can
           never render the remove dialog already spinning. */
        isPending={revokeMutation.isPending}
      />
      <ConfirmModal
        isOpen={confirm === "remove"}
        onClose={() => setConfirm(null)}
        onConfirm={() => removeMutation.mutate({ userId })}
        title="Remove agent"
        consequence={
          <>
            <p>
              Removes this agent and revokes all its keys. This drops every
              workspace membership and cannot be undone.
            </p>
            <p className="mt-2">
              Data the agent already wrote stays on the pod — this removes the
              identity, not its work.
            </p>
          </>
        }
        confirmLabel="Remove agent"
        isPending={removeMutation.isPending}
      />
    </>
  );
}

// ─── Pending invites ─────────────────────────────────────────────────

function PendingInvitesSection() {
  const invitesQuery = trpc.workspaces.listInvites.useQuery(
    { type: "pod" },
    { staleTime: 30_000 }
  );

  useEffect(() => {
    if (invitesQuery.isError) {
      redirectToLoginIfUnauthorized(invitesQuery.error, "/people");
    }
  }, [invitesQuery.isError, invitesQuery.error]);
  const isAuthRedirecting = invitesQuery.error?.data?.code === "UNAUTHORIZED";

  const revokeMutation = trpc.workspaces.revokeInvite.useMutation({
    onSuccess: () => {
      void invitesQuery.refetch();
      addToast({ title: "Invite revoked", color: "default" });
    },
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e, "/people")) return;
      addToast({
        title: "Revoke failed",
        description: e.message,
        color: "danger",
      });
    },
  });

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  function copyLink(token: string, id: string) {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    void navigator.clipboard.writeText(`${origin}/invite/${token}`).then(() => {
      setCopiedId(id);
      const prev = copyTimers.current.get(id);
      if (prev) clearTimeout(prev);
      copyTimers.current.set(
        id,
        setTimeout(() => setCopiedId(null), 2000)
      );
    });
  }

  const pending = invitesQuery.data ?? [];

  if (!invitesQuery.isLoading && !isAuthRedirecting && pending.length === 0)
    return null;

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
      {invitesQuery.isLoading || isAuthRedirecting ? (
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
              secondary={`${inv.role} · expires ${formatExpiresAt(inv.expiresAt)}`}
              status={{ kind: "unknown" as StatusKind, label: "pending" }}
              actions={
                <div className="flex items-center gap-1">
                  <Button
                    isIconOnly
                    size="sm"
                    variant="flat"
                    radius="md"
                    aria-label="Copy invite link"
                    onPress={() => copyLink(inv.token, inv.id)}
                  >
                    {copiedId === inv.id ? (
                      <Check className="h-3.5 w-3.5 text-status-healthy" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
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
                </div>
              }
            />
          ))}
        </div>
      )}
    </SectionCard>
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

  useEffect(() => {
    if (wsQuery.isError) {
      redirectToLoginIfUnauthorized(wsQuery.error, "/people");
    }
  }, [wsQuery.isError, wsQuery.error]);

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

// ─── Helpers ─────────────────────────────────────────────────────────

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
  return "unknown";
}

// Suppress unused-import warnings for icons referenced only by type.
void (Users as LucideIcon);
