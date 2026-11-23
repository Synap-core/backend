"use client";

/**
 * Pod updates › Renderers: whether Synap's renderers are on this pod, and the
 * one action that fits (Install, or Reinstall latest). A refusal stays on the
 * row with its reason and next step until the next try (rule
 * feedback-and-forms §1); a failed read is an error with Retry, never "Not
 * installed". Rules: `renderers-model.ts`.
 */

import { Button } from "@heroui/react";
import { ArrowRight, Shapes } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { navHref } from "../../../../lib/console-nav";
import { useT } from "../../../../lib/i18n/locale-provider";
import { CommandLine } from "../../../_lib/command-line";
import { ErrorNote, errorDetail } from "../../../_lib/copy-button";
import { readRenderersStatus } from "../../../_lib/object/content/use-object-renderer";
import { SectionCard } from "../../components/section-card";
import {
  ResourceRow,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import type { StatusKind } from "../../components/status-pill";
import { en, fr } from "./copy";
import {
  SYNAP_RENDERERS_SLUG,
  renderersRefusalOf,
  renderersRowView,
  type RenderersRefusal,
  type RenderersRowView,
} from "./renderers-model";

const CATALOGS = { en, fr };

/** The command that enrolls a pod's key with its control plane. */
const ENROLL_COMMAND = "synap pod-key enroll";

/** What the last install answered in this visit, if anything. */
export type RenderersLast =
  | { kind: "refused"; refusal: RenderersRefusal; detail: string }
  | { kind: "proposed"; proposalId: string }
  | { kind: "installed" }
  | null;

export type RenderersBodyState =
  | { kind: "loading" }
  | { kind: "failed"; onRetry: () => void }
  | {
      kind: "ready";
      view: RenderersRowView;
      last: RenderersLast;
      installing: boolean;
      onInstall: () => void;
    };

export function RenderersCard() {
  const utils = trpc.useUtils();
  // Same query (and cache) as the object frame (`useObjectRenderer`).
  const status = trpc.renderers.status.useQuery(undefined, { retry: false });
  const install = trpc.marketplace.install.useMutation();
  const [last, setLast] = useState<RenderersLast>(null);

  const parsed = readRenderersStatus(status.data);

  async function runInstall() {
    setLast(null);
    try {
      const outcome = await install.mutateAsync({
        kind: "renderer-bundle",
        slug: SYNAP_RENDERERS_SLUG,
      });
      setLast(
        outcome.status === "proposed"
          ? { kind: "proposed", proposalId: outcome.proposalId }
          : { kind: "installed" }
      );
      // The status here and every frame that draws with the bundle.
      void utils.renderers.invalidate();
    } catch (err) {
      setLast({
        kind: "refused",
        refusal: renderersRefusalOf(err),
        detail: errorDetail(err),
      });
    }
  }

  const state: RenderersBodyState = status.isLoading
    ? { kind: "loading" }
    : status.isError || !parsed
      ? { kind: "failed", onRetry: () => void status.refetch() }
      : {
          kind: "ready",
          view: renderersRowView(parsed),
          last,
          installing: install.isPending,
          onInstall: () => void runInstall(),
        };

  return <RenderersBody state={state} />;
}

/** The card in each state it answers (rendered by the tests as-is). */
export function RenderersBody({ state }: { state: RenderersBodyState }) {
  const t = useT(CATALOGS);
  return (
    <SectionCard title={t("renderers.title")} hint={t("renderers.hint")}>
      {state.kind === "loading" ? (
        <div aria-busy="true">
          <ResourceRowSkeleton count={1} />
        </div>
      ) : state.kind === "failed" ? (
        <ResourceRowError
          message={t("renderers.read.failed")}
          onRetry={state.onRetry}
        />
      ) : (
        <ReadyRow state={state} />
      )}
    </SectionCard>
  );
}

function ReadyRow({
  state,
}: {
  state: Extract<RenderersBodyState, { kind: "ready" }>;
}) {
  const t = useT(CATALOGS);
  const { view, last, installing, onInstall } = state;
  const s = view.state;

  const mark: { kind: StatusKind; label: string } =
    s.kind === "installed"
      ? { kind: "healthy", label: resolveActionLabel("install", "past") }
      : s.kind === "other"
        ? { kind: "unknown", label: t("renderers.state.other") }
        : { kind: "unknown", label: t("renderers.state.none") };

  const secondary =
    s.kind === "installed"
      ? t(
          last?.kind === "installed"
            ? "renderers.version.justInstalled"
            : "renderers.version",
          { version: s.version }
        )
      : s.kind === "other"
        ? t("renderers.other", { slug: s.slug, version: s.version })
        : t("renderers.none");

  const action = view.action ? (
    <Button
      size="sm"
      radius="md"
      color={view.action === "install" ? "primary" : "default"}
      variant={view.action === "install" ? "solid" : "flat"}
      isLoading={installing}
      onPress={onInstall}
    >
      {view.action === "install"
        ? resolveActionLabel("install", "imperative")
        : t("renderers.action.reinstall")}
    </Button>
  ) : undefined;

  return (
    <div className="flex flex-col gap-3">
      <ResourceRow
        Icon={Shapes}
        primary={t("renderers.name")}
        secondary={secondary}
        status={mark}
        actions={action}
        wrap
      />
      {last?.kind === "refused" && (
        <div className="flex flex-col gap-2 px-3">
          <ErrorNote
            message={t(`renderers.refused.${last.refusal}`)}
            detail={last.detail}
          />
          {last.refusal === "pod_not_enrolled" && (
            <CommandLine command={ENROLL_COMMAND} />
          )}
        </div>
      )}
      {last?.kind === "proposed" && (
        <div className="flex flex-col gap-1.5 px-3">
          <p className="text-[12.5px] text-foreground/75">
            {t("renderers.proposed")}
          </p>
          <Link
            href={navHref("review", { focus: last.proposalId })}
            className="inline-flex w-fit items-center gap-1.5 rounded-sm text-[12.5px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {t("renderers.proposed.open")} <ArrowRight size={13} />
          </Link>
        </div>
      )}
    </div>
  );
}
