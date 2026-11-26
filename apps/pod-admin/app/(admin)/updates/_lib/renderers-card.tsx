"use client";

/**
 * Pod updates › Renderers: whether Synap's renderers are on this pod and
 * where their updates stand, drawn from ONE pure view (`renderersCardView`):
 * a mark, a short line, the quiet lines under it, ONE primary act and a ⋯
 * menu. A refusal stays on the card as an ErrorNote until the next act; a
 * failed read is a ResourceRowError with Retry, never a state the card did not
 * read (rule feedback-and-forms §1, §4).
 */

import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
} from "@heroui/react";
import { ArrowRight, MoreHorizontal, Shapes } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { formatRelative, formatUntil } from "@synap-core/types/value-format";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
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
import { en, fr } from "./copy";
import {
  SYNAP_RENDERERS_SLUG,
  readRenderersUpdates,
  renderersActFailureOf,
  renderersCardView,
  renderersRefusalOf,
  type RenderersCardView,
  type RenderersLast,
  type RenderersLine,
  type RenderersUpdatesRead,
} from "./renderers-model";

const CATALOGS = { en, fr };

/** The command that enrolls a pod's key with its control plane. */
const ENROLL_COMMAND = "synap pod-key enroll";

/** The cards on this page the Renderers card links to (`page.tsx`). */
export const AUTO_UPDATE_ANCHOR = "auto-update";
export const UPDATE_NOW_ANCHOR = "update-now";

/** Which act is running, for its button's spinner. */
export type RenderersPending =
  "install" | "reinstall" | "update" | "undo" | "pause" | null;

export type RenderersBodyState =
  | { kind: "loading" }
  | { kind: "failed"; onRetry: () => void }
  | {
      kind: "ready";
      view: RenderersCardView;
      pending: RenderersPending;
      onInstall: () => void;
      onReinstall: () => void;
      onUpdate: (version: string) => void;
      onUndo: (receiptId: string) => void;
      onPause: (paused: boolean) => void;
      onRetryUpdates: () => void;
    };

/** A tRPC error the pod answered 403 (not a pod admin): omit, never fail. */
function isForbidden(err: unknown): boolean {
  const data = (err as { data?: { code?: unknown; httpStatus?: unknown } })
    ?.data;
  return data?.code === "FORBIDDEN" || data?.httpStatus === 403;
}

export function RenderersCard() {
  const utils = trpc.useUtils();
  const locale = useConsoleLocale();
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
  const pause = trpc.packageUpdates.pauseUpdates.useMutation();
  const [last, setLast] = useState<RenderersLast>(null);
  const [pending, setPending] = useState<RenderersPending>(null);

  const parsed = readRenderersStatus(status.data);

  /** After any act: this card, every frame, and the Updates list. */
  function refresh() {
    void utils.renderers.invalidate();
    void utils.packageUpdates.invalidate();
  }

  async function act(
    which: Exclude<RenderersPending, null>,
    run: () => Promise<RenderersLast>,
    onError: (err: unknown) => RenderersLast
  ) {
    setLast(null);
    setPending(which);
    try {
      setLast(await run());
    } catch (err) {
      setLast(onError(err));
    } finally {
      setPending(null);
      refresh();
    }
  }

  const installAct = (which: "install" | "reinstall") =>
    void act(
      which,
      async () => {
        const outcome = await install.mutateAsync({
          kind: "renderer-bundle",
          slug: SYNAP_RENDERERS_SLUG,
        });
        return outcome.status === "proposed"
          ? { kind: "proposed", proposalId: outcome.proposalId }
          : { kind: "installed" };
      },
      (err) => ({
        kind: "refused",
        refusal: renderersRefusalOf(err),
        detail: errorDetail(err),
      })
    );

  const failedAct =
    (which: "update" | "undo" | "pause") =>
    (err: unknown): RenderersLast => ({
      kind: "act-failed",
      act: which,
      failure: renderersActFailureOf(err),
      detail: errorDetail(err),
    });

  const updates: RenderersUpdatesRead =
    updatesRead.isLoading || history.isLoading
      ? { read: "loading" }
      : isForbidden(updatesRead.error) || isForbidden(history.error)
        ? { read: "forbidden" }
        : updatesRead.isError || history.isError
          ? { read: "failed" }
          : { read: "ok", state: readRenderersUpdates(updatesRead.data) };

  const now = Date.now();
  const state: RenderersBodyState = status.isLoading
    ? { kind: "loading" }
    : status.isError || !parsed
      ? { kind: "failed", onRetry: () => void status.refetch() }
      : {
          kind: "ready",
          view: renderersCardView({
            status: parsed,
            updates,
            receipt: history.data?.[0] ?? null,
            last,
            now,
            when: {
              until: (iso) => formatUntil(iso, now, { locale }),
              since: (iso) => formatRelative(iso, now, { locale }),
            },
          }),
          pending,
          onInstall: () => installAct("install"),
          onReinstall: () => installAct("reinstall"),
          onUpdate: (version) =>
            void act(
              "update",
              async () => {
                const result = await apply.mutateAsync({
                  slug: SYNAP_RENDERERS_SLUG,
                  expectedVersion: version,
                  choices: {},
                });
                return result.status === "proposed" && result.proposalIds[0]
                  ? { kind: "proposed", proposalId: result.proposalIds[0] }
                  : null;
              },
              failedAct("update")
            ),
          onUndo: (receiptId) =>
            void act(
              "undo",
              async () => {
                const result = await undo.mutateAsync({ receiptId });
                return result.status === "proposed" && result.proposalIds[0]
                  ? { kind: "proposed", proposalId: result.proposalIds[0] }
                  : { kind: "undone" };
              },
              failedAct("undo")
            ),
          onPause: (paused) =>
            void act(
              "pause",
              async () => {
                await pause.mutateAsync({
                  slug: SYNAP_RENDERERS_SLUG,
                  paused,
                });
                return null;
              },
              failedAct("pause")
            ),
          onRetryUpdates: () => {
            void updatesRead.refetch();
            void history.refetch();
          },
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
  const locale = useConsoleLocale();
  // A line's key and params come from the model, typed against this catalog.
  const say = (l: RenderersLine) =>
    (t as unknown as (k: string, p?: Record<string, string>) => string)(
      l.key,
      l.params
    );
  const { view, pending } = state;
  const busy = pending !== null;

  return (
    <div className="flex flex-col gap-3" aria-busy={busy || undefined}>
      <ResourceRow
        Icon={Shapes}
        primary={t("renderers.name")}
        secondary={say(view.secondary)}
        status={
          view.mark
            ? { kind: view.mark.kind, label: say(view.mark.label) }
            : undefined
        }
        actions={<Actions state={state} />}
        wrap
      />
      {(view.notes.length > 0 || view.door) && (
        <div className="flex flex-col gap-1 px-3">
          {view.notes.map((n) => (
            <p key={n.key} className="text-[12.5px] text-foreground/75">
              {say(n)}
            </p>
          ))}
          {view.door === "auto-update" && (
            <a
              href={`#${AUTO_UPDATE_ANCHOR}`}
              className="inline-flex w-fit items-center gap-1.5 rounded-sm text-[12.5px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {t("renderers.update.autoOff.door")} <ArrowRight size={13} />
            </a>
          )}
        </div>
      )}
      {view.error && (
        <div className="flex flex-col gap-2 px-3">
          {view.error.byPassAt && (
            <p className="text-[12px] text-foreground/65">
              {t("renderers.refused.byPass", {
                when: formatRelative(view.error.byPassAt, Date.now(), {
                  locale,
                }),
              })}
            </p>
          )}
          <ErrorNote
            message={say(view.error.line)}
            detail={view.error.detail}
          />
          {view.error.enroll && <CommandLine command={ENROLL_COMMAND} />}
        </div>
      )}
      {view.proposalId && (
        <p className="px-3 text-[12.5px] text-foreground/75">
          {t("renderers.proposed")}
        </p>
      )}
      {view.updates === "failed" && (
        <ResourceRowError
          message={t("renderers.updates.failed")}
          onRetry={state.onRetryUpdates}
        />
      )}
    </div>
  );
}

/** ONE primary act, and the ⋯ menu when it holds anything. */
function Actions({
  state,
}: {
  state: Extract<RenderersBodyState, { kind: "ready" }>;
}) {
  const t = useT(CATALOGS);
  const { view, pending } = state;
  const busy = pending !== null;
  const p = view.primary;

  const primary = !p ? null : p.kind === "install" ? (
    <Button
      size="sm"
      radius="md"
      color="primary"
      isLoading={pending === "install"}
      isDisabled={busy}
      onPress={state.onInstall}
    >
      {resolveActionLabel("install", "imperative")}
    </Button>
  ) : p.kind === "open-request" ? (
    <Button
      as={Link}
      href={navHref("review", { focus: p.proposalId })}
      size="sm"
      radius="md"
      variant="flat"
    >
      {t("renderers.proposed.open")}
    </Button>
  ) : p.kind === "update" ? (
    <Button
      size="sm"
      radius="md"
      color="primary"
      isLoading={pending === "update"}
      isDisabled={busy}
      onPress={() => state.onUpdate(p.version)}
    >
      {resolveActionLabel("update", "imperative")}
    </Button>
  ) : p.kind === "update-pod" ? (
    <Button
      as="a"
      href={`#${UPDATE_NOW_ANCHOR}`}
      size="sm"
      radius="md"
      variant="light"
    >
      {t("renderers.action.updatePod")}
    </Button>
  ) : p.kind === "undo" ? (
    <Button
      size="sm"
      radius="md"
      variant="flat"
      isLoading={pending === "undo"}
      isDisabled={busy}
      aria-label={t("renderers.action.undo.label", { version: p.version })}
      onPress={() => state.onUndo(p.receiptId)}
    >
      {resolveActionLabel("undo", "imperative")}
    </Button>
  ) : (
    <Button
      size="sm"
      radius="md"
      variant="flat"
      isLoading={pending === "pause"}
      isDisabled={busy}
      onPress={() => state.onPause(false)}
    >
      {t("renderers.action.resume")}
    </Button>
  );

  const menu =
    view.overflow.length > 0 ? (
      <Dropdown>
        <DropdownTrigger>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            radius="full"
            isLoading={
              pending === "reinstall" ||
              (pending === "pause" && p?.kind !== "resume")
            }
            isDisabled={busy}
            aria-label={t("renderers.action.more")}
            className="text-foreground/55"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownTrigger>
        <DropdownMenu aria-label={t("renderers.action.more")}>
          {view.overflow.map((item) => (
            <DropdownItem
              key={item}
              onPress={
                item === "reinstall"
                  ? state.onReinstall
                  : () => state.onPause(item === "pause")
              }
            >
              {t(
                item === "reinstall"
                  ? "renderers.action.reinstall"
                  : item === "pause"
                    ? "renderers.action.pause"
                    : "renderers.action.resume"
              )}
            </DropdownItem>
          ))}
        </DropdownMenu>
      </Dropdown>
    ) : null;

  if (!primary && !menu) return null;
  return (
    <div className="flex items-center gap-1">
      {primary}
      {menu}
    </div>
  );
}
