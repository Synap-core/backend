"use client";

/**
 * Settings' home for the rules a person set from a request ("always" and
 * "never", `request-rules-model.ts`): every receipt of those menus says "take
 * it back in Settings", so this is where that is true. Rules are a pod
 * admin's to take back (`assertCanManageRule`); anyone else reads the list.
 */
import { useEffect, useState } from "react";
import { Button, addToast } from "@heroui/react";
import { TRPCClientError } from "@trpc/client";
import { trpc } from "../../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../../lib/auth-redirect";
import { SectionCard } from "../../../components/section-card";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../components/resource-row";
import { useConsoleRole } from "../../../components/side-nav-role";
import { useT } from "../../../../../lib/i18n/locale-provider";
import { en, fr } from "./copy";
import { requestRules, type RequestRule } from "./request-rules-model";

const CATALOGS = { en, fr };

export function RequestRules() {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const mayTakeBack = useConsoleRole() === "admin";
  const rules = trpc.governanceRules.listAll.useQuery();
  useEffect(() => {
    if (rules.error) redirectToLoginIfUnauthorized(rules.error);
  }, [rules.error]);
  const revoke = trpc.governanceRules.revoke.useMutation();
  const [pending, setPending] = useState<string | null>(null);

  const line = (r: RequestRule) =>
    r.verdict === "deny"
      ? t("requestRules.never", { what: r.what })
      : t("requestRules.always", { what: r.what });

  async function takeBack(r: RequestRule) {
    setPending(r.id);
    try {
      await revoke.mutateAsync({ id: r.id });
      await utils.governanceRules.listAll.invalidate();
      addToast({
        title: t("requestRules.takenBack", { name: r.agent }),
        description: line(r),
        color: "success",
      });
    } catch (err) {
      if (err instanceof TRPCClientError && redirectToLoginIfUnauthorized(err))
        return;
      addToast({
        title: t("requestRules.notChanged"),
        description: t("requestRules.notChangedHint"),
        color: "danger",
      });
    } finally {
      setPending(null);
    }
  }

  const rows = requestRules(rules.data?.rules ?? []);
  return (
    <SectionCard title={t("requestRules.title")} hint={t("requestRules.hint")}>
      {rules.isLoading ? (
        <ResourceRowSkeleton count={2} />
      ) : rules.isError ? (
        <ResourceRowError
          message={t("requestRules.failed")}
          onRetry={() => void rules.refetch()}
        />
      ) : rows.length === 0 ? (
        <ResourceRowEmpty message={t("requestRules.empty")} />
      ) : (
        <ul className="-mx-2 divide-y divide-foreground/[0.05]">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">
                  {r.agent}
                </span>
                <span className="block text-[12px] text-foreground/65">
                  {line(r)}
                </span>
              </span>
              {mayTakeBack && (
                <Button
                  size="sm"
                  variant="flat"
                  className="min-h-10"
                  isLoading={pending === r.id}
                  isDisabled={pending !== null && pending !== r.id}
                  onPress={() => void takeBack(r)}
                  aria-label={t("requestRules.takeBack.aria", {
                    name: r.agent,
                    rule: line(r),
                  })}
                >
                  {t("requestRules.takeBack")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
