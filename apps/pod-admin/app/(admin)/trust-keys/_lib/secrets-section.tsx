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
 *   2. Per-user vaults are OWNER-SCOPED, not zero-knowledge. Corrected
 *      2026-09-06: this tab claimed they were "encrypted client-side with
 *      each user's master password" and that an operator therefore could not
 *      read them. That is false for every secret written today.
 *      `packages/api/src/routers/secrets-vault.ts` says so in its own header:
 *      `encryption_mode` defaults to `'server'` (the ONLY write path), the
 *      server encrypts with `VAULT_SERVER_KEY`, and `reveal` decrypts
 *      server-side — required so AI credential grants can resolve on a
 *      sovereign pod. `'client'` rows are LEGACY and no longer written.
 *      The real property is ISOLATION, not blindness: `list`/`reveal` are
 *      scoped to `ctx.userId`, so one user cannot read another's vault.
 *
 * Before 2026-09-05 this tab carried a `TODO(phase-C+)` for a
 * `trpc.podSecrets.*` router nobody had written, and a CTA to a relative
 * fluid-web vault path on pod-admin's own origin — no such route, no rewrite:
 * a hard 404. Per the ratified front-desk scope, `podSecrets` is not being
 * built; the exit is now resolved through `openIn()`, the one door, and
 * rendered by `HandoffCard`, which always pairs a desktop-scheme link with its
 * web fallback.
 */

import Link from "next/link";
import { Button } from "@heroui/react";
import { ArrowRight, FileLock2 } from "lucide-react";
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
        hint="Per-user secret storage — owner-scoped"
      >
        {/* The reader's OWN vault is the one thing on this tab that pod-admin
            can render: `secretsVault.list` is scoped to `ctx.userId`, so
            /my-vault is safe for any signed-in member and needs no operator
            role. It is an inventory + delete surface only — it never reveals a
            plaintext value, which is why the authoring hand-off below stays. */}
        <div className="mb-4">
          <Button
            as={Link}
            href="/my-vault"
            size="sm"
            radius="sm"
            variant="flat"
            className="min-h-10"
            endContent={<ArrowRight className="h-3.5 w-3.5" />}
          >
            Review my vault
          </Button>
        </div>

        <HandoffCard
          title="Personal vaults live in the desktop app"
          body="Every user on this pod has their own vault. Secrets are encrypted at rest with a key this pod holds — the pod can decrypt them, which is what lets an agent use a credential you granted it. What a vault guarantees is isolation: it is scoped to its owner, so no one else on this pod can read yours."
          exit={openIn({ kind: "settings", section: "vault" })}
          cta="Open Settings → Vault"
        />
      </SectionCard>
    </div>
  );
}
