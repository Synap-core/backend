"use client";

/**
 * One key, opened from the Keys list: what it is, what it may touch (its
 * grants, in words with the raw permission beside each), how much it was used
 * over the usage window, and what it did on the pod — the proposals it filed
 * and the sessions it worked in. `apiKeys.adminKeyDetail` reads it.
 */

import { Button, Chip, Spinner } from "@heroui/react";
import { ArrowUpRight, FileCheck2, PlayCircle } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { trpc } from "../../../../lib/trpc";
import { formatRelative, shortId } from "../../../../lib/format";
import { openIn } from "../../../../lib/open-in";
import { permissionLabel } from "../../../oauth/consent/consent-model";
import { DetailDrawer } from "../../components/detail-drawer";
import { StatusPill } from "../../components/status-pill";
import {
  CATEGORY_LABEL,
  categorize,
  holderName,
  keyHref,
  keyStatus,
  type UnifiedKey,
} from "./key-model";

export function KeyDrawer({
  apiKey,
  onClose,
}: {
  apiKey: UnifiedKey | null;
  onClose: () => void;
}) {
  const detail = trpc.apiKeys.adminKeyDetail.useQuery(
    { keyId: apiKey?.id ?? "" },
    { enabled: apiKey !== null, staleTime: 30_000 }
  );
  if (!apiKey) return null;
  const status = keyStatus(apiKey);
  const holderPage = keyHref(apiKey);
  const holder = holderName(apiKey);

  return (
    <DetailDrawer
      isOpen
      onClose={onClose}
      title={apiKey.keyName}
      subtitle={`${CATEGORY_LABEL[categorize(apiKey)]} · ${
        apiKey.keyPrefix ? `${apiKey.keyPrefix}…` : shortId(apiKey.id)
      }`}
      headerRight={<StatusPill kind={status.kind} label={status.label} />}
      footer={
        holderPage ? (
          <Button
            as={Link}
            href={holderPage}
            size="sm"
            variant="flat"
            endContent={<ArrowUpRight className="h-3.5 w-3.5" />}
          >
            {holder ? `Open ${holder}` : "Open its space"}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        <Section title="Overview">
          <Facts
            rows={[
              ["Held by", holder ?? apiKey.user?.name ?? apiKey.user?.email],
              ["Created", when(apiKey.createdAt)],
              ["Expires", apiKey.expiresAt ? when(apiKey.expiresAt) : "Never"],
              [
                "Last used",
                apiKey.lastUsedAt ? when(apiKey.lastUsedAt) : "Never",
              ],
              ["Uses", apiKey.usageCount?.toLocaleString() ?? null],
              [
                "Revoked",
                apiKey.revokedAt
                  ? `${when(apiKey.revokedAt)}${
                      apiKey.revokedReason ? ` — ${apiKey.revokedReason}` : ""
                    }`
                  : null,
              ],
            ]}
          />
        </Section>

        {detail.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner size="sm" />
          </div>
        ) : detail.isError ? (
          <p className="text-[12.5px] text-danger">
            Couldn&apos;t load this key&apos;s detail: {detail.error.message}
          </p>
        ) : detail.data ? (
          <>
            <Section title="What it can do">
              {detail.data.grants.length === 0 ? (
                <p className="text-[12.5px] text-foreground/75">
                  No live grant: this key can touch nothing.
                </p>
              ) : (
                detail.data.grants.map((g) => (
                  <GrantCard key={g.id} grant={g} />
                ))
              )}
            </Section>

            <Section
              title={`Use · last ${detail.data.usage.retentionDays} days`}
            >
              <UsageBars days={detail.data.usage.days} />
              {detail.data.usage.clients.length > 0 && (
                <Facts
                  rows={detail.data.usage.clients.map((c) => [
                    c.client,
                    `${c.calls.toLocaleString()} calls`,
                  ])}
                />
              )}
            </Section>

            <Section title="What it did on the pod">
              {detail.data.proposals.length === 0 &&
              detail.data.sessions.length === 0 ? (
                <p className="text-[12.5px] text-foreground/75">
                  No proposals filed and no sessions worked in with this key.
                </p>
              ) : (
                <ul className="-mx-2 flex flex-col">
                  {detail.data.sessions.map((s) => (
                    <ActivityRow
                      key={`s-${s.id}`}
                      href={
                        openIn({
                          kind: "object",
                          objectKind: "session",
                          id: s.id,
                        }).href
                      }
                      icon={<PlayCircle className="h-3.5 w-3.5" />}
                      primary={s.title ?? "Untitled session"}
                      secondary={`Session · ${s.harness} · ${formatRelative(s.lastSeenAt)}`}
                    />
                  ))}
                  {detail.data.proposals.map((p) => (
                    <ActivityRow
                      key={`p-${p.id}`}
                      href={
                        openIn({
                          kind: "object",
                          objectKind: "proposal",
                          id: p.id,
                        }).href
                      }
                      icon={<FileCheck2 className="h-3.5 w-3.5" />}
                      primary={p.summary ?? p.proposalType}
                      secondary={`Proposal · ${p.status} · ${formatRelative(p.createdAt)}`}
                    />
                  ))}
                </ul>
              )}
            </Section>
          </>
        ) : null}
      </div>
    </DetailDrawer>
  );
}

type Grant = NonNullable<
  ReturnType<typeof trpc.apiKeys.adminKeyDetail.useQuery>["data"]
>["grants"][number];

function GrantCard({ grant }: { grant: Grant }) {
  const pins = [
    grant.workspaces
      ? `Spaces: ${grant.workspaces.map((w) => w.name ?? shortId(w.id)).join(", ")}`
      : "Every space",
    grant.projectIds ? `${grant.projectIds.length} project(s)` : null,
    grant.entityIds ? `${grant.entityIds.length} object(s)` : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-foreground/[0.03] p-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-foreground/75">
        {grant.label && (
          <span className="font-medium text-foreground">{grant.label}</span>
        )}
        <span>For {grant.onBehalfOf.name ?? shortId(grant.onBehalfOf.id)}</span>
        <span>·</span>
        <span>{pins.join(" · ")}</span>
        <span>·</span>
        <span>
          {grant.expiresAt ? `until ${when(grant.expiresAt)}` : "no end date"}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {grant.permissions.map((p) => (
          <li key={p} className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] text-foreground">
              {permissionLabel(p)}
            </span>
            <code className="shrink-0 text-[11px] text-foreground/60">{p}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Calls per day as a strip of bars; the failed share sits at each bar's foot. */
function UsageBars({
  days,
}: {
  days: Array<{ day: string; calls: number; failed: number }>;
}) {
  if (days.length === 0) {
    return (
      <p className="text-[12.5px] text-foreground/75">
        Not used in this window.
      </p>
    );
  }
  const max = Math.max(...days.map((d) => d.calls));
  const total = days.reduce((n, d) => n + d.calls, 0);
  const failed = days.reduce((n, d) => n + d.failed, 0);
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex h-16 items-end gap-[3px]"
        role="img"
        aria-label={`${total} calls over ${days.length} active days`}
      >
        {days.map((d) => (
          <div
            key={d.day}
            title={`${d.day}: ${d.calls} calls${d.failed ? `, ${d.failed} failed` : ""}`}
            className="flex min-w-[4px] flex-1 flex-col justify-end"
            style={{ height: `${Math.max(6, (d.calls / max) * 100)}%` }}
          >
            {d.failed > 0 && (
              <div
                className="bg-danger/70"
                style={{ height: `${(d.failed / d.calls) * 100}%` }}
              />
            )}
            <div className="flex-1 rounded-t-sm bg-primary/60" />
          </div>
        ))}
      </div>
      <div className="flex gap-3 text-[11.5px] text-foreground/70">
        <span>{total.toLocaleString()} calls</span>
        {failed > 0 && (
          <Chip size="sm" variant="flat" color="danger">
            {failed.toLocaleString()} failed
          </Chip>
        )}
      </div>
    </div>
  );
}

function ActivityRow({
  href,
  icon,
  primary,
  secondary,
}: {
  href: string;
  icon: ReactNode;
  primary: string;
  secondary: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-foreground/[0.04]"
      >
        <span className="mt-0.5 text-foreground/60">{icon}</span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] text-foreground">
            {primary}
          </span>
          <span className="truncate text-[11.5px] text-foreground/65">
            {secondary}
          </span>
        </span>
      </Link>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-foreground/65">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: Array<[string, string | null | undefined]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-foreground/65">{k}</dt>
            <dd className="min-w-0 truncate text-foreground">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

const when = (d: Date | string | null | undefined): string | null =>
  d ? formatRelative(d) : null;
