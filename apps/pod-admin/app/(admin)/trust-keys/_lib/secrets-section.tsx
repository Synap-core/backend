"use client";

/**
 * Trust & Keys → Secrets vault sub-tab.
 *
 * pod-admin does NOT own secrets, and this tab exists only to say so honestly.
 * Two facts, both true and both load-bearing for an operator:
 *
 *   1. Pod-level secrets (DB password, MinIO credentials, OAuth client
 *      secrets, internal hub keys) are env-managed at deploy time. They are
 *      deliberately absent from this UI — rotation is a deployment action.
 *   2. Per-user vaults are client-side encrypted. The pod admin CANNOT read
 *      their contents. That is a trust property, not a missing feature, and
 *      their real home is the desktop app's Settings → Vault.
 *
 * Before 2026-09-05 this tab carried a `TODO(phase-C+)` for a
 * `trpc.podSecrets.*` router nobody had written, and a CTA to a relative
 * fluid-web vault path on pod-admin's own origin — no such route, no rewrite:
 * a hard 404. Per the ratified front-desk scope, `podSecrets` is not being
 * built; the exit is now resolved through `openIn()`, the one door, and
 * rendered by `HandoffCard`, which always pairs a desktop-scheme link with its
 * web fallback.
 */

import { FileLock2 } from "lucide-react";
import { openIn } from "../../../../lib/open-in";
import { HandoffCard } from "../../components/handoff-card";
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
      </SectionCard>

      <SectionCard
        title="User vaults"
        hint="Per-user secret storage — encrypted client-side"
      >
        <HandoffCard
          title="Personal vaults live in the desktop app"
          body="Every user on this pod has their own vault for personal credentials and AI-accessible secrets. The pod admin cannot read vault contents — they are encrypted client-side with each user's own master password, so there is nothing here to show even to an operator. Settings → Vault is where a user manages theirs."
          exit={openIn({ kind: "settings", section: "vault" })}
          cta="Open Settings → Vault"
        />
      </SectionCard>
    </div>
  );
}
