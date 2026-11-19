"use client";

/**
 * A pod app's access on its page (design A, the app page): the same three
 * lines as the consent ("It can", "In", "It changes things in"), each a
 * door showing its value. A line's sheet edits a copy; Save applies it.
 *
 * Today the page reads only what the app HOLDS, so a sheet offers only that
 * (`heldOffer`) and a save can only take away, through the narrow door
 * (`apps.narrow`, no new consent). Without an Undo yet, a save that takes
 * something away is confirmed first, as the per-space list did. Widening
 * within what it asked (decision fc37f740 Q2) and the receipt's Undo come
 * with the W3d update door.
 *
 * A connection whose pairs do not fit one v2 access (`heldAccessOf` says
 * "reconsent") is not drawn here: the page keeps its per-space list and says
 * it is confirmed at the next sign-in (Q3).
 */

import { useMemo, useState } from "react";
import { addToast } from "@heroui/react";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";
import { AccessLines } from "../../oauth/consent/AccessLines";
import {
  canRows,
  draftHeadline,
  draftOf,
  heldAccessOf,
  placeNames,
  toApprovedPairs,
  type ConsentDraft,
} from "../../oauth/consent/consent-access";
import { consentT } from "../../oauth/consent/copy";
import { heldOffer, type PodAppInfo } from "./pod-app-view";

export function AppAccessSection({
  pod,
  appName,
  onNarrow,
}: {
  pod: PodAppInfo;
  appName: string;
  /** Keep only these pairs (`PATCH /api/apps`, `narrow`); the page reloads. */
  onNarrow: (
    keep: Array<{ permission: string; workspaceId: string | null }>
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const t = consentT();
  const offer = useMemo(() => heldOffer(pod.approved), [pod.approved]);
  const held = useMemo(() => heldAccessOf(pod.approved), [pod.approved]);
  // A Synap app decides as the person; any other app acts as its own agent.
  const actsAs = pod.verified ? "person" : "agent";
  const rows = useMemo(() => canRows(offer, actsAs), [offer, actsAs]);
  const [pending, setPending] = useState<{
    keep: Array<{ permission: string; workspaceId: string | null }>;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  if (held.kind !== "access") return null;
  const draft = draftOf(held.access);

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
        {draftHeadline(draft, offer)}
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
        names={placeNames(offer)}
        onSave={save}
        isDisabled={saving}
      />
      <p className="max-w-2xl text-pretty text-xs text-foreground/65">
        {t("page.applies")} {t("page.narrowOnly")}
      </p>
      <ConfirmModal
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => void applyPending()}
        title={t("page.confirmTitle", { name: appName })}
        consequence={<p>{t("page.confirmBody", { name: appName })}</p>}
        confirmLabel={t("sheet.save")}
        isPending={saving}
      />
    </section>
  );
}
