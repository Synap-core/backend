"use client";

/**
 * Pod › Pod health — the pod's machine against its alert thresholds
 * (plan P3, G10, decision 8d8c2fef): one sentence on where it stands, each
 * reading with its mark, the safe actions that help the current alerts, and
 * the thresholds behind "Change thresholds".
 *
 * One door, `podHealth.*` (pod admins only): `get` is a dry run of the same
 * evaluator the 2-min check runs, so this page and the bell agree. Host
 * actions write a request the host engine takes (`requestAction`); the
 * console never runs a host command itself.
 */

import { addToast } from "@heroui/react";
import { useEffect, useState } from "react";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { useT } from "../../../lib/i18n/locale-provider";
import { trpc } from "../../../lib/trpc";
import { PageHeader, PageShell } from "../components/page-header";
import { HEALTH_CATALOGS } from "./_lib/copy";
import {
  actionErrorText,
  parsePodHealth,
  type HostAction,
} from "./_lib/health-model";
import { HealthBody, type HealthBodyState } from "./_lib/health-view";

export default function PodHealthPage() {
  const t = useT(HEALTH_CATALOGS);
  const utils = trpc.useUtils();
  const q = trpc.podHealth.get.useQuery(undefined, {
    // The host samples every 2 min; a minute keeps an open page current.
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
  useEffect(() => {
    if (q.isError) redirectToLoginIfUnauthorized(q.error);
  }, [q.isError, q.error]);

  const [sending, setSending] = useState<HostAction | null>(null);
  const request = trpc.podHealth.requestAction.useMutation({
    onSettled: () => {
      setSending(null);
      void utils.podHealth.get.invalidate();
    },
    onError: (err) =>
      addToast({
        title: t("error.title"),
        description: actionErrorText(t, err.message),
        color: "danger",
      }),
  });
  const save = trpc.podHealth.setThresholds.useMutation({
    onSuccess: () => {
      addToast({ title: t("thresholds.saved"), color: "success" });
      void utils.podHealth.get.invalidate();
    },
    onError: () => addToast({ title: t("thresholds.failed"), color: "danger" }),
  });

  const view = q.data ? parsePodHealth(q.data) : null;
  const retry = () => void q.refetch();
  const state: HealthBodyState = q.isLoading
    ? { kind: "loading" }
    : q.isError || !q.data
      ? { kind: "failed", onRetry: retry }
      : view
        ? { kind: "ready", view }
        : { kind: "unreadable", onRetry: retry };

  return (
    <PageShell>
      <PageHeader title={t("title")} description={t("description")} />
      <HealthBody
        state={state}
        handlers={{
          sendingAction: sending,
          onHostAction: (action, service) => {
            setSending(action);
            request.mutate({ action, ...(service ? { service } : {}) });
          },
          savingThresholds: save.isPending,
          onSaveThresholds: (patch) => save.mutate(patch),
        }}
      />
    </PageShell>
  );
}
