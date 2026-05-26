"use client";

/**
 * Members tab — full member list + invite + remove actions.
 */

import {
  addToast,
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Input,
  Select,
  SelectItem,
  useDisclosure,
} from "@heroui/react";
import { Plus, UserMinus } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../../../../lib/trpc";
import { SectionCard } from "../../../components/section-card";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../components/resource-row";

type Member = {
  id: string;
  role: string;
  userId: string;
  user: {
    id: string;
    name: string | null;
    email: string | null;
    userType?: string | null;
  };
};

function memberInitial(m: Member): string {
  const name = m.user.name ?? m.user.email ?? "";
  return name.trim().length > 0 ? name.trim()[0].toUpperCase() : "?";
}

function roleBadgeClass(role: string): string {
  if (role === "owner") return "bg-primary/10 text-primary ring-primary/20";
  if (role === "admin") return "bg-warning/10 text-warning ring-warning/20";
  return "bg-foreground/[0.06] text-foreground/55 ring-foreground/10";
}

export function MembersTab({ workspaceId }: { workspaceId: string }) {
  const inviteDisclosure = useDisclosure();
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);

  const utils = trpc.useUtils();
  const membersQuery = trpc.workspaces.listMembers.useQuery(
    { workspaceId },
    { staleTime: 30_000 }
  );

  const members = (membersQuery.data ?? []) as Member[];

  const removeMutation = trpc.workspaces.removeMember.useMutation({
    onSuccess: () => {
      void utils.workspaces.listMembers.invalidate({ workspaceId });
      addToast({ title: "Member removed", color: "default" });
      setRemoveTarget(null);
    },
    onError: (err) =>
      addToast({
        title: "Remove failed",
        description: err.message,
        color: "danger",
      }),
  });

  return (
    <div className="flex flex-col gap-5">
      <SectionCard
        title="Members"
        hint="All members of this workspace"
        actions={
          <Button
            size="sm"
            variant="flat"
            radius="md"
            color="primary"
            startContent={<Plus className="h-3.5 w-3.5" />}
            onPress={inviteDisclosure.onOpen}
          >
            Invite member
          </Button>
        }
      >
        {membersQuery.isLoading ? (
          <ResourceRowSkeleton count={3} />
        ) : membersQuery.isError ? (
          <ResourceRowError
            message="Couldn't load members."
            onRetry={() => void membersQuery.refetch()}
          />
        ) : members.length === 0 ? (
          <ResourceRowEmpty message="No members yet." />
        ) : (
          <div className="flex flex-col gap-1 pt-1">
            {members.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-3 rounded-md border border-foreground/[0.06] bg-foreground/[0.02] px-3 py-2"
              >
                {/* Avatar chip */}
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                  style={{ background: `hsl(${charCode(m.userId)}, 55%, 45%)` }}
                  aria-hidden
                >
                  {memberInitial(m)}
                </span>

                {/* Name / email */}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12.5px] font-medium text-foreground">
                    {m.user.name ?? m.user.email ?? m.userId}
                  </span>
                  {m.user.name && m.user.email ? (
                    <span className="truncate font-mono text-[10.5px] text-foreground/40">
                      {m.user.email}
                    </span>
                  ) : null}
                </div>

                {/* Role badge */}
                <span
                  className={[
                    "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] ring-1 ring-inset",
                    roleBadgeClass(m.role),
                  ].join(" ")}
                >
                  {m.role}
                </span>

                {/* Remove action (non-owners only) */}
                {m.role !== "owner" ? (
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    radius="full"
                    aria-label={`Remove ${m.user.name ?? m.user.email}`}
                    className="shrink-0 text-foreground/40 hover:text-status-down"
                    onPress={() => setRemoveTarget(m)}
                  >
                    <UserMinus className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <div className="h-8 w-8 shrink-0" />
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {inviteDisclosure.isOpen ? (
        <InviteMemberModal
          workspaceId={workspaceId}
          onClose={inviteDisclosure.onClose}
          onSuccess={() => {
            void utils.workspaces.listMembers.invalidate({ workspaceId });
            inviteDisclosure.onClose();
          }}
        />
      ) : null}

      {removeTarget ? (
        <ConfirmRemoveModal
          member={removeTarget}
          isPending={removeMutation.isPending}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() =>
            removeMutation.mutate({
              workspaceId,
              userId: removeTarget.userId,
            })
          }
        />
      ) : null}
    </div>
  );
}

// Deterministic hue from userId string
function charCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

// ─── Invite modal ────────────────────────────────────────────────────

function InviteMemberModal({
  workspaceId,
  onClose,
  onSuccess,
}: {
  workspaceId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "editor" | "viewer">("viewer");
  const [error, setError] = useState<string | null>(null);

  const inviteMutation = trpc.workspaces.createInvite.useMutation({
    onSuccess,
    onError: (err) => setError(err.message),
  });

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="md"
      placement="center"
    >
      <ModalContent>
        <ModalHeader className="border-b border-foreground/[0.06] px-6 py-4">
          <h2 className="text-[15px] font-medium text-foreground">
            Invite member
          </h2>
        </ModalHeader>
        <ModalBody className="gap-4 px-6 py-4">
          <Input
            label="Email"
            placeholder="user@example.com"
            type="email"
            value={email}
            onValueChange={setEmail}
            size="sm"
            isDisabled={inviteMutation.isPending}
          />
          <Select
            label="Role"
            size="sm"
            selectedKeys={[role]}
            onSelectionChange={(keys) => {
              const v = Array.from(keys as Set<string>)[0];
              if (v) setRole(v as typeof role);
            }}
            isDisabled={inviteMutation.isPending}
          >
            <SelectItem key="admin">Admin</SelectItem>
            <SelectItem key="editor">Editor</SelectItem>
            <SelectItem key="viewer">Viewer</SelectItem>
          </Select>
          {error ? (
            <div className="rounded-md bg-status-down/10 px-3 py-2 text-[12px] text-status-down ring-1 ring-inset ring-status-down/20">
              {error}
            </div>
          ) : null}
        </ModalBody>
        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          <Button
            variant="flat"
            radius="md"
            size="sm"
            onPress={onClose}
            isDisabled={inviteMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            color="primary"
            radius="md"
            size="sm"
            isDisabled={!email.trim() || inviteMutation.isPending}
            isLoading={inviteMutation.isPending}
            onPress={() => {
              setError(null);
              inviteMutation.mutate({
                type: "workspace",
                workspaceId,
                email: email.trim(),
                role,
              });
            }}
          >
            Send invite
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── Confirm remove modal ────────────────────────────────────────────

function ConfirmRemoveModal({
  member,
  isPending,
  onCancel,
  onConfirm,
}: {
  member: Member;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose: onCancel,
  });

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="sm"
      placement="center"
    >
      <ModalContent>
        <ModalHeader className="border-b border-foreground/[0.06] px-6 py-4">
          <h2 className="text-[15px] font-medium text-foreground">
            Remove member?
          </h2>
        </ModalHeader>
        <ModalBody className="px-6 py-4">
          <p className="text-[12.5px] text-foreground/85">
            Remove{" "}
            <span className="font-medium">
              {member.user.name ?? member.user.email ?? member.userId}
            </span>{" "}
            from this workspace? They will lose access immediately.
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
            radius="md"
            size="sm"
            isLoading={isPending}
            onPress={onConfirm}
          >
            Remove
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
