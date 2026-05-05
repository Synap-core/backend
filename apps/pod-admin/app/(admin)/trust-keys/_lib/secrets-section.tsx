"use client";

/**
 * Trust & Keys → Secrets vault sub-tab.
 *
 * Per the brief: this is the POD-SCOPED vault only.  The `secretsVault`
 * router on the backend is per-user (it queries `ctx.userId`) and is not
 * even mounted on the pod's tRPC root router (`coreRouter`) at the time
 * this tab was wired — so there is nothing pod-level to list here.
 *
 * Until a pod-scoped secrets surface ships, this sub-tab renders an
 * informational card pointing operators to:
 *   • env-file managed pod-level secrets
 *   • Studio's Workspace → Vault for user-scoped secrets
 *
 * TODO(phase-C+): wire to a future `trpc.podSecrets.list` / `.rotate` /
 * `.delete` once a pod-scoped secrets registry exists.
 */

import { Button } from "@heroui/react";
import { ExternalLink, FileLock2, Vault } from "lucide-react";
import { SectionCard } from "../../components/section-card";

export function SecretsSection() {
  return (
    <div className="flex flex-col gap-5">
      <SectionCard
        title="Pod-level secrets"
        hint="Environment-managed credentials for this pod"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="glass-icon flex h-9 w-9 shrink-0 items-center justify-center"
            style={{ background: "rgba(148, 163, 184, 0.15)" }}
          >
            <FileLock2 className="h-4 w-4 text-foreground/85" strokeWidth={2} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-[13.5px] font-medium text-foreground">
              Managed via env files
            </p>
            <p className="text-[12px] text-foreground/55">
              Pod-level secrets (database password, MinIO credentials, OAuth
              client secrets, internal hub keys) are managed at deploy time
              through environment variables. They are deliberately not exposed
              to the admin UI — rotating them happens via the deployment
              workflow, not the pod itself.
            </p>
          </div>
        </div>
        <p className="mt-3 text-[11.5px] text-foreground/45">
          A pod-scoped secrets registry with rotation support will land in a
          later phase. Until then, see the deployment runbook for the rotation
          procedure.
        </p>
      </SectionCard>

      <SectionCard
        title="User vaults"
        hint="Per-user secret storage — managed in Studio"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="glass-icon flex h-9 w-9 shrink-0 items-center justify-center"
            style={{ background: "rgba(52, 211, 153, 0.15)" }}
          >
            <Vault className="h-4 w-4 text-foreground/85" strokeWidth={2} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-[13.5px] font-medium text-foreground">
              Personal vaults live in Studio
            </p>
            <p className="text-[12px] text-foreground/55">
              Every user on this pod has their own client-encrypted vault for
              storing personal credentials and AI-accessible secrets. The pod
              admin cannot read user vault contents — they're encrypted
              client-side with each user's master password.
            </p>
          </div>
          <Button
            as="a"
            href="/studio/settings/vault"
            target="_blank"
            rel="noreferrer"
            size="sm"
            variant="flat"
            radius="md"
            endContent={<ExternalLink className="h-3 w-3" />}
            className="shrink-0"
          >
            Open Studio
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
