"use client";

/**
 * One site (`/sites/[projectId]`): is it live, what does it publish, and its
 * link. Design 73df57f3, variant A: the object page grammar (header with the
 * site's mark and its one primary action, the Link section, Records | Charts
 * tabs capped at {@link SITE_PAGE_ITEMS}, the danger zone last).
 *
 * Reads: `shares.siteStatus` (the site, its first records and charts, the
 * home switch and policy as this caller may read them), `shares.listSites`
 * (the project's name; usually already cached by the list), and
 * `workspaces.list` (the home space's name).
 *
 * The link is shown ONCE (`RevealKeyModal`), right after "Put live" minted it
 * or "Get a new link" replaced it. "Put back live" brings back the same link
 * and shows nothing new. A site whose read failed shows the Error mark with
 * a retry; one revoked here shows Revoked once, then the reads forget it.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { Alert, Button, Snippet, Switch, addToast } from "@heroui/react";
import { Inbox } from "lucide-react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { navHref, siteHref } from "../../../../lib/console-nav";
import { formatDate } from "../../../../lib/format";
import { openIn } from "../../../../lib/open-in";
import { publicPodUrl } from "../../../../lib/public-pod-url";
import { useReauthOnUnauthorized } from "../../../_lib/object/use-reauth";
import {
  ObjectHeader,
  type ObjectCrumb,
} from "../../../_lib/object/object-header";
import { ObjectPage } from "../../../_lib/object/object-page";
import { FactsGrid, type Fact } from "../../../_lib/object/facts-grid";
import type { DangerAction } from "../../../_lib/object/danger-zone";
import { ConfirmModal } from "../../components/confirm-modal";
import { HandoffCard } from "../../components/handoff-card";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import { RevealKeyModal } from "../../keys/_lib/key-modals";
import {
  ERROR_MARK,
  PRIMARY_ACTION_LABEL,
  REVOKED_MARK,
  SITE_PAGE_ITEMS,
  linkPrefixLabel,
  siteDataAddress,
  siteMark,
  sitePrimaryAction,
  tabLabel,
} from "./site-model";
import {
  ChartRow,
  RecordRow,
  useSiteItemActions,
  type SiteChart,
  type SiteRecord,
} from "./site-items";

type Failure = { message: string; data?: { code?: string | null } | null };

function toastFailure(title: string) {
  return (err: Failure) => {
    if (redirectToLoginIfUnauthorized(err)) return;
    addToast({ title, description: err.message, color: "danger" });
  };
}

export function SitePage({ projectId }: { projectId: string }) {
  const status = trpc.shares.siteStatus.useQuery(
    { projectId, limit: SITE_PAGE_ITEMS },
    { retry: false }
  );
  const list = trpc.shares.listSites.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });
  const site = status.data ?? null;
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    enabled: Boolean(site),
    staleTime: 60_000,
    retry: false,
  });
  // Only the space's owner can read the switch; the status says whether we can.
  const doors = trpc.shares.getPublicDoors.useQuery(
    { workspaceId: site?.homeWorkspaceId ?? "" },
    { enabled: site?.publicDoorsOpen === false, retry: false }
  );
  useReauthOnUnauthorized(status.error, list.error);

  const [revealed, setRevealed] = useState<{
    token: string;
    note: "created" | "rotated";
  } | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [revokedHere, setRevokedHere] = useState<number | null>(null);

  const utils = trpc.useUtils();
  const refresh = () => {
    void utils.shares.siteStatus.invalidate();
    void utils.shares.listSites.invalidate();
  };
  const publish = trpc.shares.publishSite.useMutation({
    onSuccess: (res) => {
      refresh();
      if (res.token) setRevealed({ token: res.token, note: "created" });
      else
        addToast({
          title: "The site is live again",
          description: "Same link as before.",
          color: "default",
        });
    },
    onError: toastFailure("Couldn't put the site live"),
  });
  const rotate = trpc.shares.rotateSiteToken.useMutation({
    onSuccess: (res) => {
      refresh();
      setConfirmRotate(false);
      setRevealed({ token: res.token, note: "rotated" });
    },
    onError: toastFailure("Couldn't get a new link"),
  });
  const unpublish = trpc.shares.unpublishSite.useMutation({
    onSuccess: () => {
      refresh();
      addToast({ title: "The site is off the web", color: "default" });
    },
    onError: toastFailure("Couldn't take the site off the web"),
  });
  const revoke = trpc.shares.revokeSite.useMutation({
    onSuccess: (res) => {
      setRevokedHere(res.membersRevoked);
      refresh();
    },
    onError: toastFailure("Couldn't revoke the site"),
  });
  const setDoors = trpc.shares.setPublicDoors.useMutation({
    onSuccess: () => {
      refresh();
      void utils.shares.getPublicDoors.invalidate();
    },
    onError: toastFailure("Couldn't change the public pages"),
  });
  const items = useSiteItemActions(site?.siteId ?? "");
  const podUrl = useMemo(() => publicPodUrl(), []);

  const title =
    list.data?.sites.find((s) => s.projectId === projectId)?.projectName ??
    "Site";
  const breadcrumb: ObjectCrumb[] = [
    { label: "Sites", href: navHref("sites") },
    { label: title },
  ];

  if (status.isLoading) {
    return <ResourceRowSkeleton count={4} />;
  }
  if (status.isError) {
    return (
      <div className="flex flex-col gap-6">
        <ObjectHeader
          kind="project"
          noun="Site"
          title={title}
          status={ERROR_MARK}
          breadcrumb={breadcrumb}
        />
        <ResourceRowError
          message="Couldn't read this site."
          onRetry={() => void status.refetch()}
        />
      </div>
    );
  }
  if (!site) {
    return revokedHere !== null ? (
      <div className="flex flex-col gap-6">
        <ObjectHeader
          kind="project"
          noun="Site"
          title={title}
          status={REVOKED_MARK}
          breadcrumb={breadcrumb}
        />
        <HandoffCard
          title="This site was revoked"
          body={`Its link and the ${revokedHere} records and charts it published are off for good. To publish this project again, an agent sets up a new site, with a new link.`}
          exit={openIn({
            kind: "object",
            objectKind: "project",
            id: projectId,
          })}
          cta="Open the project in Synap"
        />
      </div>
    ) : (
      <div className="flex flex-col gap-6">
        <ObjectHeader
          kind="project"
          noun="Site"
          title={title}
          breadcrumb={breadcrumb}
        />
        <HandoffCard
          title="This project has no site"
          body="An agent sets up a site for a project and you approve it in Requests. Then you put it live here and get its link."
          exit={openIn({
            kind: "object",
            objectKind: "project",
            id: projectId,
          })}
          cta="Open the project in Synap"
        />
        <div>
          <Button
            as="a"
            href={navHref("review")}
            size="sm"
            radius="md"
            variant="flat"
            startContent={<Inbox className="h-3.5 w-3.5" />}
          >
            Open Requests
          </Button>
        </div>
      </div>
    );
  }

  const mark = siteMark(site);
  const primary = sitePrimaryAction(site);
  const spaceName =
    (spaces.data ?? []).find((w) => w.id === site.homeWorkspaceId)?.name ??
    "its space";

  const facts: Fact[] = [];
  const prefix = linkPrefixLabel(site.tokenPrefix);
  if (site.hasToken && prefix) {
    facts.push({ label: "Link", value: prefix, mono: true });
  }
  if (site.live && site.publishedAt) {
    facts.push({ label: "Live since", value: formatDate(site.publishedAt) });
  }
  facts.push({
    label: "Public pages",
    value:
      site.publicDoorsOpen === null
        ? "Can't check: only the space's owner can"
        : site.publicDoorsOpen
          ? "On"
          : "Off",
  });
  facts.push({
    label: "Home space",
    value: (
      <Link
        href={`${navHref("spaces")}/${encodeURIComponent(site.homeWorkspaceId)}`}
        className="underline-offset-2 hover:underline"
      >
        {spaceName}
      </Link>
    ),
  });

  const linkHint = !site.hasToken
    ? "This site has no link yet. Putting it live makes one and shows it to you once."
    : !site.live
      ? "Kept. Putting the site back live brings back the same link; nothing new is shown."
      : "Shown once, when you put the site live. The pod keeps only its start.";

  const records = site.members as SiteRecord[];
  const charts = site.charts as SiteChart[];
  const shownCharts = charts.slice(0, SITE_PAGE_ITEMS);

  const danger: DangerAction[] = [];
  if (site.live) {
    danger.push({
      key: "unpublish",
      label: "Take the site off the web",
      description:
        "Visitors get 'not found'. Everything is kept; putting it live again brings back the same link.",
      consequence:
        "Visitors get 'not found' until you put it back live. Its records, charts and link are kept.",
      confirmLabel: "Take off the web",
      confirmColor: "danger",
      isPending: unpublish.isPending,
      onConfirm: () => unpublish.mutateAsync({ siteId: site.siteId }),
    });
  }
  danger.push({
    key: "revoke",
    label: "Revoke the site",
    description:
      "For good: the link dies and every record and chart on it is taken off.",
    consequence:
      "The link stops working for good and every record and chart on this site is taken off. Publishing this project again needs a new site, with a new link.",
    confirmLabel: "Revoke site",
    confirmColor: "danger",
    isPending: revoke.isPending,
    onConfirm: () => revoke.mutateAsync({ siteId: site.siteId }),
  });

  const tabs = [
    {
      key: "records",
      label: tabLabel("Records", site.membersTotal),
      content: (
        <SectionCard
          variant="flat"
          title="Records"
          hint={
            site.membersTotal > records.length
              ? `${records.length} of ${site.membersTotal}`
              : undefined
          }
          actions={
            site.membersTotal > records.length ? (
              <Button
                as={Link}
                href={siteHref(projectId, "records")}
                size="sm"
                radius="md"
                variant="light"
              >
                Show all {site.membersTotal}
              </Button>
            ) : undefined
          }
        >
          {records.length === 0 ? (
            <div className="flex flex-col items-center gap-2">
              <ResourceRowEmpty message="Nothing published here yet. You or an agent publish records into this site; an agent's batch waits in Requests." />
              <Button
                as="a"
                href={navHref("review")}
                size="sm"
                radius="md"
                variant="flat"
              >
                Open Requests
              </Button>
            </div>
          ) : (
            <div className="-mx-2 divide-y divide-foreground/[0.05]">
              {records.map((r) => (
                <RecordRow
                  key={r.entityId}
                  record={r}
                  siteLive={site.live}
                  actions={items}
                />
              ))}
            </div>
          )}
        </SectionCard>
      ),
    },
    // No chart on this site: no Charts tab (OMIT; the reader cannot publish one here).
    ...(site.chartsTotal > 0
      ? [
          {
            key: "charts",
            label: tabLabel("Charts", site.chartsTotal),
            content: (
              <SectionCard
                variant="flat"
                title="Charts"
                hint={
                  site.chartsTotal > shownCharts.length
                    ? `${shownCharts.length} of ${site.chartsTotal}`
                    : undefined
                }
                actions={
                  site.chartsTotal > shownCharts.length ? (
                    <Button
                      as={Link}
                      href={siteHref(projectId, "charts")}
                      size="sm"
                      radius="md"
                      variant="light"
                    >
                      Show all {site.chartsTotal}
                    </Button>
                  ) : undefined
                }
              >
                <div className="-mx-2 divide-y divide-foreground/[0.05]">
                  {shownCharts.map((c) => (
                    <ChartRow
                      key={c.cellInstanceId}
                      chart={c}
                      siteLive={site.live}
                      actions={items}
                    />
                  ))}
                </div>
              </SectionCard>
            ),
          },
        ]
      : []),
  ];

  const address = revealed
    ? podUrl
      ? siteDataAddress(podUrl, revealed.token)
      : revealed.token
    : "";

  return (
    <>
      <ObjectPage
        header={{
          kind: "project",
          noun: "Site",
          title,
          status: { kind: mark.kind, label: mark.label },
          breadcrumb,
          primaryAction: primary ? (
            <Button
              size="md"
              radius="md"
              color="primary"
              isLoading={publish.isPending}
              onPress={() => publish.mutate({ siteId: site.siteId })}
            >
              {PRIMARY_ACTION_LABEL[primary]}
            </Button>
          ) : undefined,
        }}
        tabs={tabs}
        danger={danger}
      >
        <div className="flex flex-col gap-4">
          {site.live && site.publicDoorsOpen === false && (
            <Alert
              color="warning"
              title={`Public pages are off in ${spaceName}`}
              description={`The site is live, but visitors are refused until this space's public pages are on.${
                doors.data?.sharedClientIp
                  ? " Off by default because this pod cannot tell visitors apart."
                  : ""
              }`}
              endContent={
                <Switch
                  size="sm"
                  isSelected={false}
                  isDisabled={setDoors.isPending}
                  onValueChange={(on) =>
                    setDoors.mutate({
                      workspaceId: site.homeWorkspaceId,
                      enabled: on,
                    })
                  }
                >
                  Public pages
                </Switch>
              }
            />
          )}
          {!site.live && site.policyAllowsSites === false && (
            <Alert
              color="warning"
              title={`${spaceName} doesn't allow sites`}
              description="Its sharing rules must allow publishing a project before this site can go live. They are set in Synap, Settings › Sharing."
            />
          )}
          <SectionCard
            title="Link"
            hint={linkHint}
            actions={
              site.hasToken ? (
                <Button
                  size="sm"
                  radius="md"
                  variant="flat"
                  onPress={() => setConfirmRotate(true)}
                >
                  Get a new link
                </Button>
              ) : undefined
            }
          >
            <FactsGrid facts={facts} columns={3} />
          </SectionCard>
        </div>
      </ObjectPage>

      <ConfirmModal
        isOpen={confirmRotate}
        onClose={() => setConfirmRotate(false)}
        onConfirm={() => rotate.mutate({ siteId: site.siteId })}
        title="Get a new link?"
        consequence="The current link stops working at once. Your site and anyone using it get 'not found' until you give them the new one."
        confirmLabel="Get a new link"
        confirmColor="danger"
        isPending={rotate.isPending}
      />

      {revealed && (
        <RevealKeyModal
          keyName={`${title}'s link`}
          plaintext={address}
          note={revealed.note}
          title={
            revealed.note === "created"
              ? "Your site is live"
              : "Your site's new link"
          }
          warning="Anyone with it can read what this site publishes."
          usage={
            <div className="flex flex-col gap-2">
              <p className="text-[11.5px] text-foreground/65">
                The bare token, for a site kit's settings:
              </p>
              <Snippet
                symbol=""
                size="sm"
                className="overflow-hidden font-mono"
                classNames={{ base: "bg-foreground/[0.05]" }}
              >
                {revealed.token}
              </Snippet>
            </div>
          }
          onClose={() => setRevealed(null)}
        />
      )}
    </>
  );
}
