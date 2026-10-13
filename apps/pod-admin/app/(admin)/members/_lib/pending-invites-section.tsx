"use client";

/**
 * Pending invites — sent, not yet accepted. Each row copies its link or
 * revokes it. The section hides itself when nothing is pending.
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
