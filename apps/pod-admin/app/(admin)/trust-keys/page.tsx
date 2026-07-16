"use client";

/**
 * Trust & Keys tab.
 *
 * Combines TrustedIssuers + ApiKeys + Secrets/Vault from the legacy
 * admin-ui (Phase C of the pod-admin port).  Three sub-tabs render in
 * a HeroUI `Tabs` strip; the active sub-tab is encoded in the URL
 * (`?section=...`) so deep links from Overview alerts (`/trust-keys?focus=...`)
 * land in the right place.
 *
 * Sub-tabs:
 *   1. Trusted issuers — who may *sign* JWTs this Pod verifies (crypto plane).
 *      Orthogonal to Apps & Connections (browser origin CORS allowlist).
 *   2. API keys        — system (read-only) + operator (CRUD) keys
 *   3. Secrets vault   — pointer to env-managed + Studio user vaults
 */

import { Tabs, Tab } from "@heroui/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ApiKeysSection } from "./_lib/api-keys-section";
import { IssuersSection } from "./_lib/issuers-section";
import { SecretsSection } from "./_lib/secrets-section";

type Section = "issuers" | "api-keys" | "secrets";
const SECTIONS: Section[] = ["issuers", "api-keys", "secrets"];

function TrustKeysInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const raw = searchParams.get("section");
  const active: Section = (SECTIONS as string[]).includes(raw ?? "")
    ? (raw as Section)
    : "issuers";

  function setActive(next: string | number) {
    const value = String(next);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (value === "issuers") params.delete("section");
    else params.set("section", value);
    const qs = params.toString();
    router.replace(qs ? `/trust-keys?${qs}` : "/trust-keys", { scroll: false });
  }

  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          Trust &amp; Keys
        </h1>
        <p className="text-[13px] text-foreground/55">
          Issuers, tokens, and secrets the pod trusts.
        </p>
      </header>

      <Tabs
        aria-label="Trust & Keys sections"
        variant="underlined"
        selectedKey={active}
        onSelectionChange={setActive}
        classNames={{
          tabList: "gap-4 px-0 border-b border-foreground/[0.05] rounded-none",
          tab: "px-1 h-10",
          cursor: "bg-primary",
          tabContent:
            "text-foreground/55 group-data-[selected=true]:text-foreground text-[12.5px] font-medium",
        }}
      >
        <Tab key="issuers" title="Trusted issuers">
          <div className="pt-5">
            <IssuersSection />
          </div>
        </Tab>
        <Tab key="api-keys" title="API keys">
          <div className="pt-5">
            <ApiKeysSection />
          </div>
        </Tab>
        <Tab key="secrets" title="Secrets vault">
          <div className="pt-5">
            <SecretsSection />
          </div>
        </Tab>
      </Tabs>
    </div>
  );
}

export default function TrustKeysPage() {
  // Next 16's `useSearchParams` requires a Suspense boundary.
  return (
    <Suspense fallback={<TrustKeysFallback />}>
      <TrustKeysInner />
    </Suspense>
  );
}

function TrustKeysFallback() {
  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          Trust &amp; Keys
        </h1>
        <p className="text-[13px] text-foreground/55">
          Issuers, tokens, and secrets the pod trusts.
        </p>
      </header>
      <div className="h-9 w-full max-w-md rounded-md bg-foreground/[0.05] shimmer-pulse" />
    </div>
  );
}
