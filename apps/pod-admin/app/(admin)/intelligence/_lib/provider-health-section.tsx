"use client";

/**
 * Per-provider configured / health cards. Part of `/intelligence`
 * (`page.tsx`).
 */

import { Button } from "@heroui/react";
import { Activity, Cpu, RefreshCw, Settings } from "lucide-react";
import { useEffect } from "react";
import { openIn } from "../../../../lib/open-in";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { HandoffCard } from "../../components/handoff-card";
import { ResourceRowEmpty } from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import type { StatusKind } from "../../components/status-pill";
import { StatusPill } from "../../components/status-pill";
import { ErrorBanner } from "./error-banner";

/**
 * Today the only signal we have for "providers" is the same
 * intelligenceServices table — these ARE the registered AI providers (an
 * IS instance often wraps a single provider; the `default` row is the
 * built-in Synap provider).
 *
 * For per-provider config (OpenRouter API key, Anthropic key, …) we have
 * `intelligenceRegistry.getServiceConfig` — but it requires a serviceId
 * and is scope-gated. So we render a card per active service, and stub
 * "Configure" with a TODO.
 */

interface ProviderCardData {
  id: string;
  serviceId: string;
  name: string;
  status: StatusKind;
  statusLabel: string;
  pricing?: string | null;
  capabilities: string[];
  isBuiltIn: boolean;
}

export function ProviderHealthSection() {
  const query = trpc.capabilities.list.useQuery(undefined, {
    staleTime: 30_000,
  });

  const checkHealthMutation = trpc.capabilities.checkHealth.useMutation({
    onSuccess: () => {
      void query.refetch();
    },
  });

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error);
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const cards: ProviderCardData[] = (
    query.data?.intelligenceServices ?? []
  ).map((s) => {
    const isBuiltIn = s.serviceId === "default";
    let status: StatusKind = "unknown";
    let statusLabel = "Unknown";
    // NOTE: `isBuiltIn` no longer short-circuits to "healthy". Painting the
    // default service green because it is "Configured" reported the EASY fact
    // (a row exists) instead of the TRUE one (did a ping succeed) — and the
    // health worker skipped default services entirely, so that green was never
    // backed by evidence. The worker now pings them; this renders its verdict.
    if (s.lastHealthStatus === "healthy") {
      status = "healthy";
      statusLabel = "Healthy";
    } else if (s.lastHealthStatus === "degraded") {
      status = "stale";
      statusLabel = "Degraded";
    } else if (s.lastHealthStatus === "unhealthy") {
      status = "down";
      statusLabel = "Unhealthy";
    } else if (s.lastHealthStatus === "unmonitored") {
      // The worker looked and found nothing to ping (no webhookUrl). Distinct
      // from "never looked" — an unmonitored service is a REPORTED state.
      status = "stale";
      statusLabel = "Not monitored";
    } else {
      status = "unknown";
      statusLabel = "Not pinged";
    }
    return {
      id: s.id,
      serviceId: s.serviceId,
      name: s.name,
      status,
      statusLabel,
      pricing: s.pricing,
      capabilities: (s.capabilities ?? []) as string[],
      isBuiltIn,
    };
  });

  return (
    <SectionCard
      title="Provider health"
      hint="Configured AI providers with cached health"
      actions={
        cards.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/65">
            {cards.length} providers
          </span>
        ) : null
      }
    >
      {query.isLoading || isAuthRedirecting ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-col gap-2 p-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02]"
            >
              <div className="h-3 w-1/2 rounded bg-foreground/10 shimmer-pulse" />
              <div className="h-2.5 w-3/4 rounded bg-foreground/[0.07] shimmer-pulse" />
              <div className="h-5 w-20 rounded bg-foreground/[0.07] shimmer-pulse" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <ErrorBanner
          message={query.error?.message ?? "Couldn't load providers."}
        />
      ) : cards.length === 0 ? (
        <ResourceRowEmpty message="No AI providers registered." />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => (
            <ProviderCard
              key={c.id}
              card={c}
              onTest={() =>
                !c.isBuiltIn &&
                checkHealthMutation.mutate({ serviceId: c.serviceId })
              }
              isTesting={
                checkHealthMutation.isPending &&
                checkHealthMutation.variables?.serviceId === c.serviceId
              }
            />
          ))}
        </div>
      )}

      {/* Rendered unconditionally: "where configuration lives" is true whether
          or not the list loaded, and a reader who hits an error still needs the
          way out. */}
      <div className="mt-3">
        <HandoffCard
          icon={Settings}
          title="Service configuration lives in the app"
          body="Credentials and endpoints for a provider are edited in the AI provider registry above. Which models an agent may reach, and the governance around them, are set per space in the app's AI settings."
          exit={openIn({ kind: "settings", section: "ai-governance" })}
          cta="Open AI settings"
        />
      </div>
    </SectionCard>
  );
}

function ProviderCard({
  card,
  onTest,
  isTesting,
}: {
  card: ProviderCardData;
  onTest: () => void;
  isTesting: boolean;
}) {
  return (
    <div
      className={[
        "flex flex-col gap-2.5 p-3 rounded-medium",
        "ring-1 ring-inset ring-foreground/10",
        "bg-foreground/[0.02]",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-success/10"
          >
            <Cpu
              className="h-3.5 w-3.5 text-success"
              strokeWidth={2}
              aria-hidden
            />
          </span>
          <div className="flex flex-col min-w-0">
            <span className="truncate text-[13px] font-medium text-foreground">
              {card.name}
            </span>
            <span className="truncate text-[11px] text-foreground/65 tabular">
              {card.serviceId}
            </span>
          </div>
        </div>
        <StatusPill kind={card.status} label={card.statusLabel} />
      </div>

      {card.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {card.capabilities.slice(0, 4).map((cap) => (
            <span
              key={cap}
              className="rounded-sm bg-foreground/[0.06] px-1.5 py-0.5 text-[10.5px] text-foreground/65"
            >
              {cap}
            </span>
          ))}
          {card.capabilities.length > 4 && (
            <span className="text-[10.5px] text-foreground/65">
              +{card.capabilities.length - 4}
            </span>
          )}
        </div>
      )}

      {/* No "Configure" here. pod-admin is the front desk: it reports a
          service's health, it does not own the service's configuration. The
          section-level handoff below says where that lives — a disabled button
          taught "broken", which was never true. */}
      <div className="mt-auto flex items-center gap-1">
        {!card.isBuiltIn && (
          <Button
            size="sm"
            variant="flat"
            radius="md"
            color="primary"
            isDisabled={isTesting}
            startContent={
              isTesting ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <Activity className="h-3 w-3" />
              )
            }
            onPress={onTest}
          >
            Test
          </Button>
        )}
      </div>
    </div>
  );
}
