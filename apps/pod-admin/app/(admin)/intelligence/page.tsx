"use client";

/**
 * Intelligence tab — pod-wide AI infrastructure.
 *
 * Per-workspace AI defaults live in Studio's `AgentsTab`. This tab is the
 * pod operator's view: which providers are configured, which IS instances
 * are healthy and what the pod-wide defaults are.
 *
 * This is the only tab that uses the emerald accent. Per the brief: use
 * it sparingly — header icons, key indicators, primary CTAs only.
 *
 * Sections (`?section=`, one module each under `_lib/`):
 *   Providers — AI provider registry, provider health, IS instances
 *   Models    — pod-wide default models, proactive AI defaults
 *
 * Failed AI turns moved to Runs (`/runs?filter=chat`), the one place a run
 * that went wrong is read; the line under the header points there.
 */

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { navHref } from "../../../lib/console-nav";
import { UrlTabs, type UrlTab } from "../components/url-tabs";
import { DefaultModelsSection } from "./_lib/default-models-section";
import { ProactiveDefaultsSection } from "./_lib/proactive-section";
import { ProviderHealthSection } from "./_lib/provider-health-section";
import { AIProvidersSection } from "./_lib/provider-registry-section";
import { IntelligenceServicesSection } from "./_lib/services-section";
import { PageShell } from "../components/page-header";

const SECTIONS: UrlTab[] = [
  {
    key: "providers",
    label: "Providers",
    content: (
      <div className="flex flex-col gap-6">
        <AIProvidersSection />
        <ProviderHealthSection />
        <IntelligenceServicesSection />
      </div>
    ),
  },
  {
    key: "models",
    label: "Models",
    content: (
      <div className="flex flex-col gap-6">
        <DefaultModelsSection />
        <ProactiveDefaultsSection />
      </div>
    ),
  },
];

export default function IntelligencePage() {
  return (
    <PageShell>
      <header className="mb-6 flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-success/10 ring-1 ring-inset ring-success/25"
        >
          <Sparkles
            className="h-4 w-4 text-success"
            strokeWidth={2}
            aria-hidden
          />
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
            Intelligence
          </h1>
          <p className="text-[13px] text-foreground/65">
            Pod-wide AI providers and services. Per-space overrides are set in
            the app.
          </p>
          <p className="text-[12.5px] text-foreground/65">
            <Link
              href={navHref("runs", { filter: "chat" })}
              className="rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Failed AI turns → Runs
            </Link>
          </p>
        </div>
      </header>

      {/* `UrlTabs` reads `useSearchParams`, which must sit under Suspense;
          the default section is what the reader would see first anyway. */}
      <Suspense fallback={SECTIONS[0]!.content}>
        <UrlTabs
          param="section"
          ariaLabel="Intelligence sections"
          tabs={SECTIONS}
        />
      </Suspense>
    </PageShell>
  );
}
