"use client";

/**
 * Members — the people on this pod. Agents have their own page (`/agents`).
 *
 * Three independent SectionCards:
 *   1. Pod admins       — humans who own/admin the pod-admin workspace.
 *   2. Members by role  — every human across every workspace, deduped.
 *   3. Pending invites  — sent, not yet accepted (hidden when empty).
 *
 * `listPodMembers` is lifted to the page so the first two sections share the
 * same data and a single member drawer. `?focus=<userId>` (⌘K) is received
 * by the `data-row-id` wrappers in both lists.
 */

import { Button, useDisclosure } from "@heroui/react";
import { Plus } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { PageHeader } from "../components/page-header";
import { useFocusRow } from "../components/use-focus-row";
import { AddPeopleModal } from "./_lib/add-people-modal";
import type { PodMember } from "./_lib/helpers";
import { MemberDrawer } from "./_lib/member-drawer";
import { MembersByRoleSection } from "./_lib/members-by-role-section";
import { PendingInvitesSection } from "./_lib/pending-invites-section";
import { PodAdminsSection } from "./_lib/pod-admins-section";

const TITLE = "Members";
const DESCRIPTION =
  "The people who can sign in to this pod, what they can do, and the invites still open.";

export default function MembersPage() {
  return (
    <Suspense fallback={<MembersFallback />}>
      <MembersInner />
    </Suspense>
  );
}

function MembersFallback() {
  return (
    <div className="px-4 py-6 sm:px-6 max-w-[1400px]">
      <PageHeader title={TITLE} description={DESCRIPTION} />
      <div className="h-9 w-full max-w-md rounded-md bg-foreground/[0.05] shimmer-pulse" />
    </div>
  );
}

function MembersInner() {
  const inviteDisclosure = useDisclosure();

  const podMembersQuery = trpc.workspaces.listPodMembers.useQuery(undefined, {
    staleTime: 60_000,
  });

  useEffect(() => {
    if (podMembersQuery.isError) {
      redirectToLoginIfUnauthorized(podMembersQuery.error);
    }
  }, [podMembersQuery.isError, podMembersQuery.error]);
  const isAuthRedirecting =
    podMembersQuery.error?.data?.code === "UNAUTHORIZED";

  useFocusRow({ ready: !podMembersQuery.isLoading });

  // Single shared drawer for every member row.
  const [selected, setSelected] = useState<{
    member: PodMember;
    isPodAdmin: boolean;
  } | null>(null);
  const drawerDisclosure = useDisclosure();

  function openMember(member: PodMember, isPodAdmin: boolean) {
    setSelected({ member, isPodAdmin });
    drawerDisclosure.onOpen();
  }

  return (
    <div className="px-4 py-6 sm:px-6 max-w-[1400px]">
      <PageHeader
        title={TITLE}
        description={DESCRIPTION}
        actions={
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
        }
      />

      <div className="flex flex-col gap-4">
        <PodAdminsSection
          podMembers={podMembersQuery.data}
          onOpenMember={openMember}
        />
        <MembersByRoleSection
          members={podMembersQuery.data ?? []}
          isLoading={podMembersQuery.isLoading || isAuthRedirecting}
          isError={podMembersQuery.isError}
          onOpenMember={(m) => openMember(m, false)}
        />
        <PendingInvitesSection />
      </div>

      <MemberDrawer
        member={selected?.member ?? null}
        isPodAdmin={selected?.isPodAdmin ?? false}
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
