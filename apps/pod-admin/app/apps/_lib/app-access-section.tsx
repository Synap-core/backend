"use client";

/**
 * A pod app's access on its page (design A, the app page): the same three
 * lines as the consent ("It can", "In", "It changes things in"), each a
 * door showing its value. A line's sheet edits a copy; Save applies it.
 *
 * The truth is `pod_app.access` (W3d) when the pod sends it, else the lift
 * of its pairs. The page only takes away, through the narrow door
 * (`apps.narrow`, pairs): a save that takes something away is confirmed
 * first. Pairs cannot carry a project, so while the access names one the
 * lines are read-only and say why (a save would drop it). Widening within
 * the ask (Q2) and the receipt's Undo come with `apps.updateAccess`.
 *
 * A connection whose pairs do not fit one v2 access, with no `access`, is
 * not drawn here: the page keeps its per-space list (Q3).
 */

import { useMemo, useState } from "react";
import { addToast } from "@heroui/react";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";
import { AccessLines } from "../../oauth/consent/AccessLines";
import {
  accessOfNamed,
  canRows,
  draftHeadline,
  draftOf,
  heldAccessOf,
  namesOfNamed,
  placeNames,
  toApprovedPairs,
  type ConsentDraft,
} from "../../oauth/consent/consent-access";
import { consentT } from "../../oauth/consent/copy";
import {
  accessNamesProject,
  heldOffer,
  heldOfferOfAccess,
  type PodAppInfo,
} from "./pod-app-view";

/** The section draws this connection: it has a v2 access, or pairs that fit one. */
export function drawsAccessLines(pod: PodAppInfo): boolean {
  return !!pod.access || heldAccessOf(pod.approved).kind === "access";
}

export function AppAccessSection({
  pod,
  appName,
  onNarrow,
}: {
  pod: PodAppInfo;
  /** A Synap app by its name, any other app by its domain (as the consent). */
  appName: string;
  /** Keep only these pairs (`PATCH /api/apps`, `narrow`); the page reloads. */
  onNarrow: (
    keep: Array<{ permission: string; workspaceId: string | null }>
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const t = consentT();
  const named = pod.access ?? null;
  const offer = useMemo(
    () => (named ? heldOfferOfAccess(named) : heldOffer(pod.approved)),
    [named, pod.approved]
  );
  const draft = useMemo<ConsentDraft | null>(() => {
    if (named) return draftOf(accessOfNamed(named));
    const held = heldAccessOf(pod.approved);
    return held.kind === "access" ? draftOf(held.access) : null;
  }, [named, pod.approved]);
  const names = useMemo(
    () => ({ ...namesOfNamed(named), ...placeNames(offer) }),
    [named, offer]
  );
  // A Synap app decides as the person; any other app acts as its own agent.
  const actsAs = pod.verified ? "person" : "agent";
  const rows = useMemo(() => canRows(offer, actsAs), [offer, actsAs]);
  const locked = !!named && accessNamesProject(named);
  const [pending, setPending] = useState<{
    keep: Array<{ permission: string; workspaceId: string | null }>;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  if (!draft) return null;

  function save(next: ConsentDraft) {
    const keep = toApprovedPairs(next, offer);
    if (keep.length === 0) {
      addToast({
        title: t("page.saveFailed"),
        description: t("page.revokeInstead"),
        color: "danger",
      });
      return;
    }
    setPending({ keep });
  }

  async function applyPending() {
    if (!pending) return;
    setSaving(true);
    const r = await onNarrow(pending.keep);
    setSaving(false);
    setPending(null);
    addToast(
      r.ok
        ? { title: t("page.saved"), color: "default" }
        : { title: t("page.saveFailed"), description: r.error, color: "danger" }
    );
  }

  return (
    <section className="mt-6 flex flex-col gap-3" aria-labelledby="pod-access">
      <h2 id="pod-access" className="text-sm font-medium text-foreground">
        {t("page.heading")}
      </h2>
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
        isDisabled={saving || locked}
      />
      <p className="max-w-2xl text-pretty text-xs text-foreground/65">
        {locked ? t("page.projectsLocked") : t("page.narrowOnly")}
      </p>
      <ConfirmModal
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => void applyPending()}
        title={t("page.confirmTitle", { name: appName })}
        consequence={<p>{t("page.confirmBody", { name: appName })}</p>}
        confirmLabel={t("page.takeAway")}
        confirmColor="danger"
        isPending={saving}
      />
    </section>
  );
}
