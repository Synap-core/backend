"use client";

/**
 * Pod › Server errors — every 5xx of the last 30 days with its exact cause
 * (`system.listServerFaults`, pod owner or admin; table `server_faults`).
 *
 * A server error's client body is generic on purpose; it carries an errorId
 * and a link here (`causeUrl`). So the page has two ways in: the errorId a
 * person quotes (the lookup in the header opens its page), and the list,
 * newest first, each row naming the ROOT cause. A row opens the error's own
 * page (`/errors/:errorId`).
 */

import { Button, Input } from "@heroui/react";
import { Bug } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { formatRelative } from "../../../lib/format";
import { serverErrorHref } from "../../../lib/console-nav";
import { useT } from "../../../lib/i18n/locale-provider";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { ERRORS_CATALOGS } from "./_lib/copy";
import { faultHeadline, faultRequest } from "./_lib/fault-model";

const PAGE = 50;

export default function ServerErrorsPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <ServerErrorsInner />
    </Suspense>
  );
}

function ServerErrorsInner() {
  const t = useT(ERRORS_CATALOGS);
  const router = useRouter();
  const [lookup, setLookup] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const list = trpc.system.listServerFaults.useQuery(
    { limit },
    { staleTime: 30_000, retry: false }
  );

  useEffect(() => {
    if (list.isError) redirectToLoginIfUnauthorized(list.error);
  }, [list.isError, list.error]);
  const isAuthRedirecting = list.error?.data?.code === "UNAUTHORIZED";

  const open = (errorId: string) => router.push(serverErrorHref(errorId));
  const faults = list.data ?? [];

  return (
    <PageShell>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const id = lookup.trim();
              if (id) open(id);
            }}
          >
            <Input
              size="sm"
              radius="md"
              aria-label={t("lookup.aria")}
              placeholder={t("lookup.placeholder")}
              value={lookup}
              onValueChange={setLookup}
              className="w-[300px] max-w-full"
            />
            <Button
              size="sm"
              radius="md"
              type="submit"
              color="primary"
              isDisabled={!lookup.trim()}
            >
              {t("lookup.open")}
            </Button>
          </form>
        }
      />

      <div className="rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
        {list.isLoading || isAuthRedirecting ? (
          <ResourceRowSkeleton count={5} />
        ) : list.isError ? (
          <ResourceRowError
            message={list.error.message || t("list.failed")}
            onRetry={() => void list.refetch()}
          />
        ) : faults.length === 0 ? (
          <ResourceRowEmpty message={t("list.empty")} />
        ) : (
          <div className="flex flex-col divide-y divide-foreground/[0.05]">
            {faults.map((f) => (
              <ResourceRow
                key={f.errorId}
                Icon={Bug}
                wrap
                primary={faultHeadline(f)}
                secondary={t("row.where", {
                  where: faultRequest(f),
                  when: formatRelative(f.occurredAt),
                })}
                status={{
                  kind: "down",
                  label: t("status.code", { status: String(f.status) }),
                }}
                onSelect={() => open(f.errorId)}
              />
            ))}
          </div>
        )}
      </div>

      {faults.length === limit && limit < 200 && (
        <div className="mt-3 flex justify-center">
          <Button
            size="sm"
            variant="flat"
            radius="md"
            isLoading={list.isFetching}
            onPress={() => setLimit((n) => Math.min(n + PAGE, 200))}
          >
            {t("list.more")}
          </Button>
        </div>
      )}
    </PageShell>
  );
}
