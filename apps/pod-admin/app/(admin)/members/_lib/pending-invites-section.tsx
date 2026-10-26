"use client";

/**
 * Pending invites — sent, not yet accepted. Each row copies a NEW link or
 * revokes it. The pod keeps only a digest of a link's token (decision B2), so
 * an old link cannot be shown again: "Copy a new link" mints one
 * (`regenerateInvite`) and the old link stops working. The section hides
 * itself when nothing is pending.
 */

import { addToast, Button } from "@heroui/react";
import { Check, Clock, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import {
  ResourceRow,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import { inviteExpiry } from "./helpers";

export function PendingInvitesSection() {
  const invitesQuery = trpc.workspaces.listInvites.useQuery(
    { type: "pod" },
    { staleTime: 30_000 }
  );

  useEffect(() => {
    if (invitesQuery.isError) {
      redirectToLoginIfUnauthorized(invitesQuery.error);
    }
  }, [invitesQuery.isError, invitesQuery.error]);
  const isAuthRedirecting = invitesQuery.error?.data?.code === "UNAUTHORIZED";

  const revokeMutation = trpc.workspaces.revokeInvite.useMutation({
    onSuccess: () => {
      void invitesQuery.refetch();
      addToast({ title: "Invite revoked", color: "default" });
    },
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e)) return;
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

  function markCopied(id: string) {
    setCopiedId(id);
    const prev = copyTimers.current.get(id);
    if (prev) clearTimeout(prev);
    copyTimers.current.set(
      id,
      setTimeout(() => setCopiedId(null), 2000)
    );
  }

  const regenerateMutation = trpc.workspaces.regenerateInvite.useMutation({
    onSuccess: async ({ id, token }) => {
      void invitesQuery.refetch();
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      try {
        await navigator.clipboard.writeText(`${origin}/invite/${token}`);
        markCopied(id);
        addToast({
          title: "New link copied",
          description: "The previous link no longer works.",
          color: "default",
        });
      } catch {
        addToast({
          title: "Couldn't copy the new link",
          description:
            "The previous link no longer works. Copy a new link again.",
          color: "danger",
        });
      }
    },
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e)) return;
      addToast({
        title: "Couldn't make a new link",
        description: e.message,
        color: "danger",
      });
    },
  });

  const pending = invitesQuery.data ?? [];

  if (!invitesQuery.isLoading && !isAuthRedirecting && pending.length === 0)
    return null;

  return (
    <SectionCard
      title="Pending invites"
      hint="Sent but not yet accepted"
      actions={
        pending.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/65">
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
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {pending.map((inv) => (
            <ResourceRow
              key={inv.id}
              Icon={Clock}
              primary={inv.email}
              secondary={`${inv.role} · ${inviteExpiry(inv.expiresAt)}`}
              status={{ kind: "unknown", label: "pending" }}
              actions={
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="flat"
                    radius="md"
                    isLoading={
                      regenerateMutation.isPending &&
                      regenerateMutation.variables?.id === inv.id
                    }
                    startContent={
                      copiedId === inv.id ? (
                        <Check className="h-3.5 w-3.5 text-status-healthy" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )
                    }
                    onPress={() => regenerateMutation.mutate({ id: inv.id })}
                  >
                    Copy a new link
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
