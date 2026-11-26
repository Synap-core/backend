"use client";

/**
 * A pod app's access on its page (design A, the app page): the same three
 * lines as the consent ("It can", "In", "It changes things in"), each a door
 * showing its value. A line's sheet edits a copy; Save applies it through
 * `apps.updateAccess` (W3d, with proof of presence): it may narrow, widen
 * within what the app ASKED (decision fc37f740 Q2) and hold projects. A save
 * shows a receipt with Undo (the previous access, saved again).
 *
 * The offer is `apps.accessOffer`: what it asked and the places the person
 * may give now. A connection whose old pairs do not fit one access
 * (`reconsent`, Q3) is shown in its proposed form, with Confirm.
 */

import { useMemo, useRef, useState } from "react";
import { Button, addToast, closeToast } from "@heroui/react";
import { Info } from "lucide-react";
import { trpc } from "../../../lib/trpc";
import { useUpdateAppAccess } from "../../_lib/presence/use-sensitive-actions";
import { UNDO_WINDOW_MS } from "../../_lib/receipt/decision-receipt";
import { AccessLines } from "../../oauth/consent/AccessLines";
import {
  accessInput,
  type AccessInput,
} from "../../oauth/consent/allow-payload";
import {
  accessOfNamed,
  canRows,
  draftHeadline,
  draftOf,
  namesOfNamed,
  offerOfContract,
  placeNames,
  toAccess,
  type ConsentDraft,
} from "../../oauth/consent/consent-access";
import { consentT } from "../../oauth/consent/copy";
import { readableError } from "../../../lib/format";
import { isReadPermission } from "@synap-core/types/grants";
import type { PodAppInfo } from "./pod-app-view";

/**
 * Two accesses give the same, as the server stores them: under All spaces
 * every project is included (Q1), and a permission with no place in its tier
 * is dropped (v1.2, nothing dormant).
 */
export function sameAccess(a: AccessInput, b: AccessInput): boolean {
  const norm = (x: AccessInput) => {
    const projects = x.read.spaces === "all" ? "all" : x.read.projects;
    const readPlace =
      x.read.spaces === "all" ||
      x.read.spaces.length > 0 ||
      projects === "all" ||
      projects.length > 0;
    const writePlace = x.write.spaces.length + x.write.projects.length > 0;
    const sorted = (l: string[] | "all") =>
      l === "all" ? "all" : [...l].sort();
    return JSON.stringify({
      permissions: x.permissions
        .filter((p) => (isReadPermission(p) ? readPlace : writePlace))
        .sort(),
      read: { spaces: sorted(x.read.spaces), projects: sorted(projects) },
      write: {
        spaces: sorted(x.write.spaces),
        projects: sorted(x.write.projects),
      },
    });
  };
  return norm(a) === norm(b);
}

export function AppAccessSection({
  pod,
  publicId,
  appName,
  onChanged,
}: {
  pod: PodAppInfo;
  publicId: string;
  /** A Synap app by its name, any other app by its domain (as the consent). */
  appName: string;
  /** The page reloads its row (Connected's mark, the write mode). */
  onChanged: () => void;
}) {
  const t = consentT();
  const offerQ = trpc.apps.accessOffer.useQuery(
    { publicId },
    { retry: false, refetchOnWindowFocus: false }
  );
  const update = useUpdateAppAccess();
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const data = offerQ.data ?? null;
  const offer = useMemo(() => (data ? offerOfContract(data) : null), [data]);
  const held = data?.reconsent?.proposed ?? data?.current ?? pod.access ?? null;
  const draft = useMemo<ConsentDraft | null>(
    () => (held ? draftOf(accessOfNamed(held)) : null),
    [held]
  );
  const names = useMemo(
    () => ({
      ...namesOfNamed(pod.access),
      ...namesOfNamed(data?.current),
      ...namesOfNamed(data?.reconsent?.proposed),
      ...(offer ? placeNames(offer) : {}),
    }),
    [pod.access, data, offer]
  );
  // A Synap app decides as the person; any other app acts as its own agent.
  const actsAs = pod.verified ? "person" : "agent";
  const rows = useMemo(
    () => (offer ? canRows(offer, actsAs) : []),
    [offer, actsAs]
  );

  /**
   * Save an access, then wait for the page to re-read it before anything
   * else may be pressed (`busy`). An Undo saves the previous access again,
   * but only if the access is still exactly what this Save wrote: a change
   * made in between (another tab, the app asking again) is never overwritten.
   */
  async function apply(
    next: AccessInput,
    previous: AccessInput | null,
    undoOf: AccessInput | null = null
  ) {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      if (undoOf) {
        const fresh = await offerQ.refetch();
        const now = fresh.data?.current ?? null;
        if (!now || !sameAccess(accessInput(accessOfNamed(now)), undoOf)) {
          addToast({ title: t("page.undoChanged"), color: "warning" });
          return;
        }
      }
      await update.mutateAsync({ publicId, access: next });
      await offerQ.refetch();
      onChanged();
      const holder: { key: string | null } = { key: null };
      holder.key = addToast({
        title: undoOf ? t("page.undone") : t("page.saved"),
        color: "default",
        timeout: previous ? UNDO_WINDOW_MS : undefined,
        endContent: previous ? (
          <Button
            size="sm"
            variant="flat"
            className="min-h-10"
            onPress={() => {
              if (holder.key) closeToast(holder.key);
              void apply(previous, null, next);
            }}
          >
            {t("reconsent.undo")}
          </Button>
        ) : undefined,
      });
    } catch (err) {
      addToast({
        title: t("page.saveFailed"),
        description:
          readableError((err as { message?: string }).message) ??
          t("act.tryAgain"),
        color: "danger",
      });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  function save(next: ConsentDraft) {
    if (!offer) return;
    const access = toAccess(next, offer);
    if (access.permissions.length === 0) {
      addToast({
        title: t("page.saveFailed"),
        description: t("page.revokeInstead"),
        color: "danger",
      });
      return;
    }
    const previous = data?.current
      ? accessInput(accessOfNamed(data.current))
      : null;
    void apply(accessInput(access), previous);
  }

  return (
    <section className="mt-6 flex flex-col gap-3" aria-labelledby="pod-access">
      <h2 id="pod-access" className="text-sm font-medium text-foreground">
        {t("page.heading")}
      </h2>
      {offerQ.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-danger/10 px-3.5 py-3 ring-1 ring-inset ring-danger/30"
        >
          <span className="text-sm text-foreground">
            {t("page.offerFailed")}
          </span>
          <Button
            size="sm"
            variant="flat"
            className="min-h-10"
            isLoading={offerQ.isFetching}
            onPress={() => void offerQ.refetch()}
          >
            {t("act.tryAgain")}
          </Button>
        </div>
      ) : null}
      {data?.reconsent ? (
        <div
          role="note"
          className="flex gap-2.5 rounded-lg bg-default-100 px-3.5 py-3 ring-1 ring-inset ring-foreground/10"
        >
          <Info
            className="mt-0.5 h-4 w-4 shrink-0 text-foreground/80"
            aria-hidden
          />
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-foreground">
              {t("page.confirmLaterTitle")}
            </p>
            <p className="text-pretty text-xs text-foreground/80">
              {t("page.confirmHere")}
            </p>
            {offer && draft ? (
              <Button
                size="sm"
                color="primary"
                className="min-h-10 self-start"
                isLoading={saving}
                onPress={() => save(draft)}
              >
                {t("act.confirm")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {draft && offer ? (
        <>
          <p className="text-pretty text-sm leading-relaxed text-foreground/85">
            {draftHeadline(draft, offer, rows, names)}
          </p>
          <AccessLines
            mode="page"
            appName={appName}
            declaredPlaces
            draft={draft}
            offer={offer}
            rows={rows}
            actsAs={actsAs}
            podWideKinds={[]}
            names={names}
            onSave={save}
            isDisabled={saving}
          />
          <p className="max-w-2xl text-pretty text-xs text-foreground/65">
            {t("page.applies")}
          </p>
        </>
      ) : offerQ.isLoading ? (
        <div
          aria-busy="true"
          className="h-24 rounded-lg bg-foreground/10 motion-safe:animate-pulse"
        >
          <span className="sr-only" role="status">
            {t("loading.label")}
          </span>
        </div>
      ) : !offerQ.isError ? (
        <p className="text-xs text-foreground/65">{t("page.nothing")}</p>
      ) : null}
    </section>
  );
}
