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
 * Failed AI turns are read in the desktop app's Work (Runs left the console,
 * `WORK_MOVED_TO_APP`); the line under the header points there.
 */

import { Sparkles } from "lucide-react";
import { Suspense } from "react";
import { WORK_APP_ID } from "../../../lib/console-nav";
import { ExitLink } from "../../../lib/exit-link";
import { openIn } from "../../../lib/open-in";
import { UrlTabs, type UrlTab } from "../components/url-tabs";
import { DefaultModelsSection } from "./_lib/default-models-section";
import { ProactiveDefaultsSection } from "./_lib/proactive-section";
import { ProviderHealthSection } from "./_lib/provider-health-section";
import { AIProvidersSection } from "./_lib/provider-registry-section";
import { IntelligenceServicesSection } from "./_lib/services-section";
import { PageShell } from "../components/page-header";

/** Work, in the desktop app: where a failed run is read now. */
const WORK_EXIT = openIn({ kind: "app", appId: WORK_APP_ID });

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
            <ExitLink
              exit={WORK_EXIT}
              label="Failed AI turns → Work, in the app"
            />
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
