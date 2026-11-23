"use client";

/**
 * Pod updates › Renderers: whether Synap's renderers are on this pod, and the
 * one action that fits (Install, or Reinstall latest). A refusal stays on the
 * row with its reason and next step until the next try (rule
 * feedback-and-forms §1); a failed read is an error with Retry, never "Not
 * installed". Rules: `renderers-model.ts`.
 *
 * Updates (plan ad703ccd L2) through the pod's package updates: a newer
 * version and why it has not applied yet, "Update" (`packageUpdates.applyUpdate`,
 * the same door as Marketplace › Updates), the last update with Undo
 * (`packageUpdates.undo`) and Stop / Resume updates
 * (`packageUpdates.stopUpdates`). A refusal the pod's own pass recorded (its
 * first-sync install, D2) shows with the same words as an install's.
 */

import { Button } from "@heroui/react";
import { ArrowRight, Shapes } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { formatRelative, formatUntil } from "@synap-core/types/value-format";
import { trpc } from "../../../../lib/trpc";
import { navHref } from "../../../../lib/console-nav";
import { useConsoleLocale, useT } from "../../../../lib/i18n/locale-provider";
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
  readRenderersUpdates,
  renderersRefusalOf,
  renderersRowView,
  renderersUpdatesView,
  type RenderersRefusal,
  type RenderersRowView,
  type RenderersUpdatesView,
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

/** What the last update act answered in this visit, if anything. */
export type RenderersUpdateLast =
  "undone" | "update_failed" | "undo_failed" | "stop_failed" | null;

/** The row's updates, when the pod could say (absent: nothing to draw). */
export interface RenderersUpdatesState {
  view: RenderersUpdatesView;
  /** The read of the pod's update state failed (never "up to date"). */
  failed: boolean;
  last: RenderersUpdateLast;
  busy: boolean;
  onUpdate: () => void;
  onUndo: () => void;
  onToggleStop: () => void;
}

export type RenderersBodyState =
  | { kind: "loading" }
  | { kind: "failed"; onRetry: () => void }
  | {
      kind: "ready";
      view: RenderersRowView;
      last: RenderersLast;
      installing: boolean;
      onInstall: () => void;
      updates?: RenderersUpdatesState;
    };

export function RenderersCard() {
  const utils = trpc.useUtils();
  // Same query (and cache) as the object frame (`useObjectRenderer`).
  const status = trpc.renderers.status.useQuery(undefined, { retry: false });
  const updatesRead = trpc.renderers.updates.useQuery(undefined, {
    retry: false,
  });
  const history = trpc.packageUpdates.history.useQuery(
    { slug: SYNAP_RENDERERS_SLUG, limit: 1 },
    { retry: false }
  );
  const install = trpc.marketplace.install.useMutation();
  const apply = trpc.packageUpdates.applyUpdate.useMutation();
  const undo = trpc.packageUpdates.undo.useMutation();
  const stop = trpc.packageUpdates.stopUpdates.useMutation();
  const [last, setLast] = useState<RenderersLast>(null);
  const [updateLast, setUpdateLast] = useState<RenderersUpdateLast>(null);

  const parsed = readRenderersStatus(status.data);

  /** After an update act: this row, every frame, and the Updates list. */
  function refresh() {
    void utils.renderers.invalidate();
    void utils.packageUpdates.invalidate();
  }

  async function run(
    act: () => Promise<unknown>,
    failed: Exclude<RenderersUpdateLast, "undone" | null>,
    done: RenderersUpdateLast = null
  ) {
    setUpdateLast(null);
    try {
      await act();
      setUpdateLast(done);
    } catch {
      setUpdateLast(failed);
    } finally {
      refresh();
    }
  }

  const updatesView =
    parsed &&
    renderersUpdatesView(
      parsed,
      readRenderersUpdates(updatesRead.data),
      history.data?.[0] ?? null,
      Date.now()
    );
  const updates: RenderersUpdatesState | undefined = updatesView
    ? {
        view: updatesView,
        failed: updatesRead.isError || history.isError,
        last: updateLast,
        busy: apply.isPending || undo.isPending || stop.isPending,
        onUpdate: () => {
          const version = updatesView.available?.version;
          if (!version) return;
          void run(
            () =>
              apply.mutateAsync({
                slug: SYNAP_RENDERERS_SLUG,
                expectedVersion: version,
                choices: {},
              }),
            "update_failed"
          );
        },
        onUndo: () => {
          const receiptId = updatesView.undoable?.receiptId;
          if (!receiptId) return;
          void run(
            () => undo.mutateAsync({ receiptId }),
            "undo_failed",
            "undone"
          );
        },
        onToggleStop: () =>
          void run(
            () =>
              stop.mutateAsync({
                kind: "renderer-bundle",
                slug: SYNAP_RENDERERS_SLUG,
                stopped: !updatesView.stopped,
              }),
            "stop_failed"
          ),
      }
    : undefined;

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
          updates,
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
  const { view, last, installing, onInstall, updates } = state;
  const s = view.state;
  // A refusal of this visit's install, else the one the pod's pass recorded.
  const refusal: RenderersRefusal | null =
    last?.kind === "refused"
      ? last.refusal
      : s.kind === "none"
        ? (updates?.view.refusal ?? null)
        : null;

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
      {refusal && (
        <div className="flex flex-col gap-2 px-3">
          <ErrorNote
            message={t(`renderers.refused.${refusal}`)}
            detail={last?.kind === "refused" ? last.detail : undefined}
          />
          {refusal === "pod_not_enrolled" && (
            <CommandLine command={ENROLL_COMMAND} />
          )}
        </div>
      )}
      {updates && s.kind === "installed" && <UpdatesPart updates={updates} />}
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

/** Why a newer version waits, but its own soak (which names a time). */
const WAIT_KEYS = {
  manual: "renderers.update.manual",
  stopped: "renderers.update.stopped",
  requires: "renderers.update.requires",
  undone: "renderers.update.undone",
} as const;

/** A newer version and why it waits, the last update with Undo, Stop/Resume. */
function UpdatesPart({ updates }: { updates: RenderersUpdatesState }) {
  const t = useT(CATALOGS);
  const locale = useConsoleLocale();
  const { view, failed, last, busy } = updates;
  const now = Date.now();
  const available = view.available;

  return (
    <div className="flex flex-col gap-2 px-3">
      {failed && (
        <p role="alert" className="text-[12.5px] text-status-stale">
          {t("renderers.updates.failed")}
        </p>
      )}
      {available && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 flex-1 text-[12.5px] text-foreground/80">
            {t("renderers.update.available", { version: available.version })}{" "}
            {available.wait === "auto"
              ? t("renderers.update.auto", {
                  when: formatUntil(available.applyAfter ?? now, now, {
                    locale,
                  }),
                })
              : t(WAIT_KEYS[available.wait])}
          </p>
          <Button
            size="sm"
            radius="md"
            color="primary"
            isDisabled={busy}
            onPress={updates.onUpdate}
          >
            {resolveActionLabel("update", "imperative")}
          </Button>
        </div>
      )}
      {view.undoable && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 flex-1 text-[12.5px] text-foreground/75">
            {t(
              view.undoable.automatic
                ? "renderers.updated.auto"
                : "renderers.updated.person",
              {
                version: view.undoable.version,
                when: formatRelative(view.undoable.at, now, { locale }),
              }
            )}
          </p>
          <Button
            size="sm"
            radius="md"
            variant="flat"
            isDisabled={busy}
            onPress={updates.onUndo}
          >
            {resolveActionLabel("undo", "imperative")}
          </Button>
        </div>
      )}
      {last === "undone" && (
        <p role="status" className="text-[12.5px] text-foreground/75">
          {t("renderers.undone")}
        </p>
      )}
      {last && last !== "undone" && (
        <p role="alert" className="text-[12.5px] text-status-down">
          {t(
            last === "update_failed"
              ? "renderers.update.failed"
              : last === "undo_failed"
                ? "renderers.undo.failed"
                : "renderers.stop.failed"
          )}
        </p>
      )}
      <div>
        <Button
          size="sm"
          radius="md"
          variant="light"
          isDisabled={busy}
          onPress={updates.onToggleStop}
        >
          {t(
            view.stopped ? "renderers.action.resume" : "renderers.action.stop"
          )}
        </Button>
      </div>
    </div>
  );
}
