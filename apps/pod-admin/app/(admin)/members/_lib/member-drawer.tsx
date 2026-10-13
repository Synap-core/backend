"use client";

/**
 * One member's detail: role, every workspace membership (each with its own
 * exit to the desktop app), and the admin actions — reset password, revoke
 * all keys, remove from the pod. Self-actions are blocked here AND by the
 * pod (`adminRevokeAllForUser` / `removeFromPod` refuse the caller).
 */

import { addToast, Avatar, Button, Tooltip } from "@heroui/react";
import { Ban, ExternalLink, KeyRound, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { formatRelative } from "../../../../lib/format";
import { openIn } from "../../../../lib/open-in";
import { ExitFallback } from "../../../../lib/exit-link";
import { useOperatorEmail } from "../../components/admin-shell";
import { ConfirmModal } from "../../components/confirm-modal";
import { DetailDrawer } from "../../components/detail-drawer";
import { StatusPill } from "../../components/status-pill";
import { rolePillKind, type PodMember } from "./helpers";

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

export function MemberDrawer({
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
  // One slot, so only one confirm can be open — a revoke in flight can never
  // render the remove dialog already spinning (see ConfirmModal `isPending`).
  const [confirm, setConfirm] = useState<null | "revoke" | "remove">(null);

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
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Reset failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const revokeKeysMutation = trpc.apiKeys.adminRevokeAllForUser.useMutation({
    onSuccess: (res) => {
      void utils.apiKeys.adminListAll.invalidate();
      addToast({
        title: "Keys revoked",
        description: `${res.revokedCount} key${res.revokedCount === 1 ? "" : "s"} revoked.`,
        color: "default",
      });
      setConfirm(null);
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
      setConfirm(null);
      onClose();
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Remove failed",
        description: err.message,
        color: "danger",
      });
      setConfirm(null);
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

              <SelfGuard
                isSelf={isSelf}
                reason="You can't revoke your own keys here."
              >
                <Button
                  variant="flat"
                  size="sm"
                  radius="md"
                  color="danger"
                  isDisabled={isSelf}
                  startContent={<Ban className="h-3.5 w-3.5" />}
                  className="w-full justify-start text-[12.5px]"
                  onPress={() => setConfirm("revoke")}
                >
                  Revoke all keys
                </Button>
              </SelfGuard>

              <SelfGuard isSelf={isSelf} reason="You can't remove yourself.">
                <Button
                  variant="flat"
                  size="sm"
                  radius="md"
                  color="danger"
                  isDisabled={isSelf}
                  startContent={<Trash2 className="h-3.5 w-3.5" />}
                  className="w-full justify-start text-[12.5px]"
                  onPress={() => setConfirm("remove")}
                >
                  Remove from pod
                </Button>
              </SelfGuard>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmModal
        isOpen={confirm === "revoke" && Boolean(member)}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (member) revokeKeysMutation.mutate({ userId: member.id });
        }}
        title={`Revoke every key ${member?.email ?? "this person"} holds?`}
        consequence={
          <>
            <p>
              Every active API key this person created stops working immediately
              — scripts, CLIs and apps that use them will fail.
            </p>
            <p className="mt-2">
              They keep their account, their sign-in and their workspaces, and
              can create new keys afterwards. Agents they connected hold their
              own keys: disconnect those from Agents.
            </p>
          </>
        }
        confirmLabel="Revoke all keys"
        isPending={revokeKeysMutation.isPending}
      />

      <ConfirmModal
        isOpen={confirm === "remove" && Boolean(member)}
        onClose={() => setConfirm(null)}
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

/**
 * A self-action is shown disabled with the reason on hover, never hidden: the
 * pod refuses it anyway, and a missing button reads as a missing feature.
 */
function SelfGuard({
  isSelf,
  reason,
  children,
}: {
  isSelf: boolean;
  reason: string;
  children: ReactNode;
}) {
  if (!isSelf) return <>{children}</>;
  return (
    <Tooltip content={reason}>
      <span className="block">{children}</span>
    </Tooltip>
  );
}
