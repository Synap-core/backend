"use client";

/**
 * Catalog entry detail + install — every kind, from the pod's own catalog.
 *
 * The disclosure ladder, in order, no wizard:
 *   1. What it is           — description, kind, source (the cached row)
 *   2. What it contains     — counts read off the definition the install uses
 *   3. What it will DO here — `marketplace.preflight`, nothing written
 *   4. Confirm              — `marketplace.install`
 *
 * Step 3 is the point of the whole surface. The pod answers "these 7 profiles
 * would be created, this one conflicts" (a space) or "adds these 3 rules to the
 * space you pick, 1 runs on a schedule" (everything else) BEFORE anything is
 * written; skipping it would make the confirm button a dare.
 *
 * There is no install count and no "Verified" badge: the first is bumped by an
 * unauthenticated endpoint and the second certifies a DNS record, so neither
 * is evidence of anything. On the result, read what the pod reported
 * (`describeInstall`), never the absence of an error. A catalog failure is a
 * calm message in place — never a sign-in redirect.
 *
 * Where it comes from decides what Install means (enforced by the pod; this
 * page reflects it): a showcase source's package opens the
 * publisher's site and is never fetched; a blocked source says why; a package
 * from a trusted source names the code and network reach it brings and asks
 * for an explicit confirm of each before Install is enabled.
 */

import { Button, Checkbox, Input, Select, SelectItem } from "@heroui/react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock,
  Info,
} from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import {
  OBJECT_KINDS,
  OBJECT_KIND_ALIASES,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { navHref } from "../../../../lib/console-nav";
import { readableError } from "../../../../lib/format";
import { publisherExit } from "../../../../lib/open-in";
import { ExitLink } from "../../../../lib/exit-link";
import {
  readableDescription,
  type PackageDefinition,
} from "../../../../lib/marketplace";
import { SectionCard } from "../../components/section-card";
import { PageFallback, PageShell } from "../../components/page-header";
import { ErrorNote, errorDetail } from "../../../_lib/copy-button";
import { ObjectHeader } from "../../../_lib/object/object-header";
import { AdvancedPanel } from "../../../_lib/object/advanced-panel";
import {
  catalogDetailHref,
  catalogKindLabel,
  countNoun,
  describeInstall,
  installBlockedHint,
  type InstallSummary,
} from "../_lib/catalog-model";
import { confirmItems, installMode, riskLines } from "../_lib/sources-model";
import { TrustChip } from "../_lib/sources-tab";
import type {
  CatalogDetail,
  CatalogEntry,
  MarketPreflight,
  PreflightReport,
} from "../_lib/types";

type CatalogKind = CatalogEntry["kind"];

interface Target {
  kind: CatalogKind;
  slug: string;
  source?: string;
}

/**
 * Which definition keys become a "what it contains" line, in reading order.
 *
 * Keys that name an OBJECT KIND carry the kind, not a label: the words come
 * from `@synap-core/types/vocabulary`, the one door. The remaining keys have NO
 * object kind — they name parts of a definition's structure, not things the
 * product has nouns for — so they keep an explicit label here.
 */
const CONTENT_ROWS: {
  key: string;
  kind?: string;
  noun?: string;
  nounPlural?: string;
}[] = [
  { key: "profiles", noun: "entity type", nounPlural: "entity types" },
  { key: "views", kind: "view" },
  { key: "cells", kind: "cell" },
  { key: "capabilities", kind: "capability" },
  { key: "playbooks", kind: "playbook" },
  { key: "automations", kind: "automation" },
  { key: "relationDefs", noun: "relation type", nounPlural: "relation types" },
  { key: "commands", kind: "command" },
  { key: "entityLinks", noun: "entity link", nounPlural: "entity links" },
  {
    key: "suggestedEntities",
    noun: "starter record",
    nounPlural: "starter records",
  },
];

/**
 * The registry's own singular/plural for a kind. No naive `+ "s"`: that turns
 * "Property" into "Propertys".
 */
function nounsFor(row: { kind?: string; noun?: string; nounPlural?: string }): {
  noun: string;
  nounPlural: string;
} {
  if (!row.kind) {
    return {
      noun: row.noun ?? "",
      nounPlural: row.nounPlural ?? row.noun ?? "",
    };
  }
  const canonical = OBJECT_KIND_ALIASES[row.kind] ?? row.kind;
  const entry = OBJECT_KINDS[canonical];
  const noun = resolveObjectNoun(row.kind);
  return { noun, nounPlural: entry?.labelPlural ?? noun };
}

/** Next hands a dynamic segment back still encoded on some paths (`a%2Fb`). */
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

type Stage =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "plan"; preflight: MarketPreflight }
  | { kind: "installing"; preflight: MarketPreflight }
  | { kind: "done"; summary: InstallSummary }
  | { kind: "failed"; message: string; detail: string };

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

export default function CatalogEntryPage() {
  // `useSearchParams` needs a Suspense boundary for the static build.
  return (
    <Suspense fallback={<PageFallback />}>
      <CatalogEntry />
    </Suspense>
  );
}

function CatalogEntry() {
  const params = useParams<{ slug: string }>();
  const search = useSearchParams();
  const slug = decodeSegment(params?.slug ?? "");
  const kindParam = search.get("kind") as CatalogKind | null;
  const source = search.get("source") ?? undefined;

  // A link that names no kind (an older bookmark) is resolved by slug: one
  // match opens it, several are offered — never a silent pick.
  const bySlug = trpc.marketplace.list.useQuery(
    { query: slug, limit: 100 },
    { enabled: !kindParam && !!slug, retry: false }
  );
  if (!kindParam) {
    if (bySlug.isLoading) return <PageFallback />;
    const matches = (bySlug.data?.entries ?? []).filter((e) => e.slug === slug);
    if (bySlug.error || matches.length === 0) {
      return (
        <Failure
          message={
            bySlug.error
              ? "The pod couldn't read its catalog."
              : `"${slug}" is not in this pod's catalog.`
          }
          detail={bySlug.error ? errorDetail(bySlug.error) : undefined}
          onRetry={bySlug.error ? () => void bySlug.refetch() : undefined}
        />
      );
    }
    if (matches.length > 1) return <Choose matches={matches} />;
    return <Detail target={matches[0]!} />;
  }
  return <Detail target={{ kind: kindParam, slug, source }} />;
}

function Detail({ target }: { target: Target }) {
  const entry = trpc.marketplace.get.useQuery(
    { kind: target.kind, slug: target.slug, source: target.source },
    { retry: false, staleTime: 60_000 }
  );

  if (entry.isLoading) return <PageFallback />;
  if (entry.error || !entry.data) {
    return (
      <Failure
        message={
          readableError(entry.error?.message) ??
          "This catalog entry is unavailable right now."
        }
        detail={entry.error ? errorDetail(entry.error) : undefined}
        onRetry={() => void entry.refetch()}
      />
    );
  }
  const pkg = entry.data;
  const description = readableDescription(pkg.description);

  return (
    <PageShell className="flex flex-col gap-4">
      {/* ── 1. What it is ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <ObjectHeader
          kind={pkg.objectKind}
          noun={catalogKindLabel(pkg.objectKind)}
          title={pkg.name}
          summary={description}
          status={
            pkg.installed ? { kind: "healthy", label: "Installed" } : null
          }
          breadcrumb={[
            { label: "Marketplace", href: navHref("marketplace") },
            { label: pkg.name },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-foreground/65 sm:pl-14">
          <span>From {pkg.sourceName}</span>
          <TrustChip trust={pkg.trust} />
        </div>
      </div>

      {/* ── 2. What it contains ───────────────────────────────────────── */}
      <Contents pkg={pkg} />

      {/* ── 3 + 4. What it will do here, then confirm ─────────────────── */}
      <InstallPanel target={target} pkg={pkg} />

      <AdvancedPanel
        ids={[
          { label: "Package id", value: pkg.id },
          ...(pkg.version ? [{ label: "Version", value: pkg.version }] : []),
          { label: "Source id", value: pkg.source },
          ...(pkg.vendor ? [{ label: "Vendor id", value: pkg.vendor }] : []),
        ]}
      />
    </PageShell>
  );
}

function Contents({ pkg }: { pkg: CatalogDetail }) {
  const definition = pkg.definition as PackageDefinition | null;
  if (!definition) {
    return (
      <SectionCard title="What's in this package">
        <p className="text-[12.5px] text-foreground/65">
          {pkg.definitionError
            ? `The pod couldn't fetch the full package from ${pkg.sourceName} right now.`
            : pkg.installMode === "open_site"
              ? `Listed for show by ${pkg.sourceName} — the pod never fetches its contents.`
              : pkg.installMode === "refuse"
                ? "Not fetched while this source can't install anything."
                : "The catalog carries no definition for this entry."}
        </p>
      </SectionCard>
    );
  }
  const rows = CONTENT_ROWS.map((row) => {
    const value = definition[row.key];
    // A capability package stores a SINGULAR `capability` object, not a
    // `capabilities` array. The array is checked for LENGTH, not just
    // presence: `capabilities: []` beside a singular object must not shadow it.
    const arrayCount = Array.isArray(value) ? value.length : 0;
    const hasSingularCapability =
      row.key === "capabilities" &&
      !!definition.capability &&
      typeof definition.capability === "object";
    const count = arrayCount > 0 ? arrayCount : hasSingularCapability ? 1 : 0;
    return { ...row, ...nounsFor(row), count };
  }).filter((row) => row.count > 0);

  return (
    <SectionCard
      title="What's in this package"
      hint="Read from the definition the install uses"
    >
      {rows.length === 0 ? (
        <p className="text-[12.5px] text-foreground/65">
          Nothing to count here — the preview below says what installing it
          adds.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <li
              key={row.key}
              className="flex items-baseline gap-2 text-[12.5px] text-foreground/70"
            >
              <span className="w-8 shrink-0 text-right font-medium tabular-nums text-foreground">
                {row.count}
              </span>
              <span>{row.count === 1 ? row.noun : row.nounPlural}</span>
            </li>
          ))}
        </ul>
      )}
      {Array.isArray(definition.dependencies) &&
        definition.dependencies.length > 0 && (
          <p className="mt-3 border-t border-foreground/[0.07] pt-3 text-[12px] text-foreground/65">
            Also pulls in:{" "}
            {definition.dependencies.map((d) => d.slug).join(", ")}
          </p>
        )}
    </SectionCard>
  );
}

function InstallPanel({ target, pkg }: { target: Target; pkg: CatalogDetail }) {
  const mode = installMode(pkg);
  if (mode.kind === "open_site")
    return <PublisherSite pkg={pkg} url={mode.url} />;
  if (mode.kind === "blocked") {
    return (
      <SectionCard title="Install">
        <div className="flex items-start gap-2.5">
          <CircleAlert size={15} className="mt-0.5 shrink-0 text-status-down" />
          <p className="text-[12.5px] leading-relaxed text-foreground/75">
            {mode.reason}
          </p>
        </div>
      </SectionCard>
    );
  }
  return <Installer target={target} pkg={pkg} />;
}

/**
 * A showcase listing: Install is the publisher's own page, in a new tab —
 * never a fetch, never an install on this pod.
 */
function PublisherSite({
  pkg,
  url,
}: {
  pkg: CatalogDetail;
  url: string | null;
}) {
  const exit = publisherExit(url);
  return (
    <SectionCard title="Install">
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] leading-relaxed text-foreground/75">
          {pkg.sourceName} is listed for show only: this package installs from
          the publisher&apos;s site, and nothing from it runs on this pod.
        </p>
        {exit ? (
          <ExitLink exit={exit} label="Open the publisher's site" />
        ) : (
          <p className="text-[12px] text-foreground/65">
            The publisher gave no install page.
          </p>
        )}
      </div>
    </SectionCard>
  );
}

function Installer({ target, pkg }: { target: Target; pkg: CatalogDetail }) {
  const utils = trpc.useUtils();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [accepted, setAccepted] = useState<{
    code?: boolean;
    network?: boolean;
  }>({});
  const install = trpc.marketplace.install.useMutation();

  // The row's own source, so preflight and install name the exact row read.
  const exact = { kind: target.kind, slug: target.slug, source: pkg.source };

  async function check(space: string | null) {
    setStage({ kind: "checking" });
    try {
      const preflight = await utils.marketplace.preflight.fetch(
        { ...exact, workspaceId: space ?? undefined },
        { staleTime: 0 }
      );
      setAccepted({});
      setStage({ kind: "plan", preflight });
    } catch (err) {
      setStage({
        kind: "failed",
        message:
          readableError(errorDetail(err)) ??
          "The pod couldn't check this package. Nothing was written.",
        detail: errorDetail(err),
      });
    }
  }

  function chooseSpace(space: string | null) {
    setWorkspaceId(space);
    void check(space);
  }

  async function runInstall(preflight: MarketPreflight) {
    setStage({ kind: "installing", preflight });
    const params = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v.trim() !== "")
    );
    try {
      const outcome = await install.mutateAsync({
        ...exact,
        workspaceId: workspaceId ?? undefined,
        params: Object.keys(params).length > 0 ? params : undefined,
        acknowledge: accepted,
      });
      setStage({ kind: "done", summary: describeInstall(outcome) });
      // What an install can change: the package's own "Installed", the
      // Installed/Tools tabs, and the spaces a template creates.
      void Promise.all([
        utils.marketplace.get.invalidate(),
        utils.capabilities.invalidate(),
        utils.workspaces.invalidate(),
      ]);
    } catch (err) {
      setStage({
        kind: "failed",
        message:
          readableError(errorDetail(err)) ??
          "The install didn't go through. Nothing changed — try again.",
        detail: errorDetail(err),
      });
    }
  }

  if (stage.kind === "done") return <Result summary={stage.summary} />;

  if (stage.kind === "failed") {
    return (
      <SectionCard title="Install didn't go through">
        <div className="flex min-w-0 flex-col gap-2">
          <ErrorNote message={stage.message} detail={stage.detail} />
          <Button
            size="sm"
            radius="md"
            variant="flat"
            className="w-fit"
            onPress={() => setStage({ kind: "idle" })}
          >
            Start over
          </Button>
        </div>
      </SectionCard>
    );
  }

  if (stage.kind === "plan" || stage.kind === "installing") {
    const { preflight } = stage;
    const installing = stage.kind === "installing";
    const missing = preflight.params.filter(
      (p) => p.required && !p.hasDefault && !values[p.name]?.trim()
    );
    const confirms = confirmItems(preflight);
    const unconfirmed = confirms.some((c) => accepted[c.key] !== true);
    const blockedHint = installBlockedHint({
      ok: preflight.ok,
      missing: missing.map((p) => p.label ?? p.name),
      unconfirmed,
    });
    const brings = riskLines(preflight.risks);
    return (
      <SectionCard
        title="What this will do to your pod"
        hint="Checked against this pod — nothing has been written"
      >
        <div className="flex flex-col gap-3">
          {preflight.workspace !== "creates" && (
            <SpacePicker
              need={preflight.workspace}
              value={workspaceId}
              onChange={chooseSpace}
              isDisabled={installing}
            />
          )}
          {preflight.blockers.length > 0 && (
            <PlanGroup tone="down" heading="Before it can install">
              {preflight.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </PlanGroup>
          )}
          {preflight.report && <PlanBody report={preflight.report} />}
          <Adds preflight={preflight} />
          {brings.length > 0 && (
            <PlanGroup
              tone={confirms.length > 0 ? "stale" : "neutral"}
              heading="What it brings"
            >
              {brings.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </PlanGroup>
          )}
          {preflight.notices.length > 0 && (
            <PlanGroup tone="stale" heading="Worth knowing">
              {preflight.notices.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </PlanGroup>
          )}
          {preflight.params.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-[12.5px] font-medium text-foreground">
                It asks for
              </p>
              {preflight.params.map((p) => (
                <Input
                  key={p.name}
                  size="sm"
                  radius="md"
                  variant="bordered"
                  label={p.label ?? p.name}
                  description={p.description ?? undefined}
                  isRequired={p.required && !p.hasDefault}
                  type={p.secret ? "password" : "text"}
                  autoComplete="off"
                  value={values[p.name] ?? ""}
                  onValueChange={(v) =>
                    setValues((prev) => ({ ...prev, [p.name]: v }))
                  }
                  isDisabled={installing}
                  className="max-w-md"
                />
              ))}
            </div>
          )}
        </div>
        {confirms.length > 0 && (
          <div className="mt-3 flex flex-col gap-2 rounded-lg bg-status-stale/10 p-3">
            <p className="text-[12.5px] font-medium text-foreground">
              Before it installs — from {preflight.sourceName}, not Synap
            </p>
            {confirms.map((c) => (
              <Checkbox
                key={c.key}
                size="sm"
                isSelected={accepted[c.key] === true}
                isDisabled={installing}
                onValueChange={(v) =>
                  setAccepted((prev) => ({ ...prev, [c.key]: v }))
                }
              >
                <span className="text-[12.5px] text-foreground/80">
                  {c.label}
                </span>
              </Checkbox>
            ))}
          </div>
        )}
        <Provenance pkg={pkg} />
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-foreground/[0.07] pt-3">
          <Button
            size="sm"
            radius="md"
            color="primary"
            isDisabled={installing || blockedHint !== null}
            isLoading={installing}
            onPress={() => void runInstall(preflight)}
          >
            {installing ? "Installing…" : "Install"}
          </Button>
          <Button
            size="sm"
            radius="md"
            variant="light"
            isDisabled={installing}
            onPress={() => setStage({ kind: "idle" })}
          >
            Cancel
          </Button>
          {blockedHint && !installing && (
            <p className="w-full text-[12px] text-foreground/65 sm:w-auto">
              {blockedHint}
            </p>
          )}
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Install"
      hint="You'll see exactly what changes before anything is written"
    >
      <Button
        size="sm"
        radius="md"
        color="primary"
        className="w-fit"
        isLoading={stage.kind === "checking"}
        isDisabled={stage.kind === "checking"}
        onPress={() => void check(workspaceId)}
      >
        {stage.kind === "checking" ? "Checking…" : "Check this pod"}
      </Button>
    </SectionCard>
  );
}

/**
 * Where an install lands. `required` kinds go INTO a space the person picks;
 * `optional` ones are pod-wide unless one is picked. The pod re-checks on
 * every change, so the plan always describes the chosen space.
 */
function SpacePicker({
  need,
  value,
  onChange,
  isDisabled,
}: {
  need: MarketPreflight["workspace"];
  value: string | null;
  onChange: (space: string | null) => void;
  isDisabled: boolean;
}) {
  const spaces = trpc.workspaces.list.useQuery(undefined, { retry: false });
  const POD_WIDE = "__pod__";
  return (
    <Select
      label={need === "required" ? "Add it to" : "Install for"}
      size="sm"
      radius="md"
      variant="bordered"
      className="max-w-md"
      placeholder={spaces.isLoading ? "Loading spaces…" : "Choose a space"}
      isDisabled={isDisabled || spaces.isLoading}
      selectedKeys={value ? [value] : need === "optional" ? [POD_WIDE] : []}
      onSelectionChange={(keys) => {
        const picked = Array.from(keys as Set<string>)[0];
        if (!picked) return;
        onChange(picked === POD_WIDE ? null : picked);
      }}
      errorMessage={
        spaces.error
          ? "Couldn't list the spaces. Reload the page to try again."
          : undefined
      }
      isInvalid={!!spaces.error}
    >
      {[
        ...(need === "optional"
          ? [<SelectItem key={POD_WIDE}>The whole pod</SelectItem>]
          : []),
        ...(spaces.data ?? []).map((s) => (
          <SelectItem key={s.id}>{s.name}</SelectItem>
        )),
      ]}
    </Select>
  );
}

function Adds({ preflight }: { preflight: MarketPreflight }) {
  if (preflight.adds.length === 0) return null;
  return (
    <>
      {preflight.adds.map((part) => (
        <PlanGroup
          key={part.kind}
          heading={`Adds ${countNoun(part.kind, part.names.length)}`}
        >
          {part.names.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </PlanGroup>
      ))}
    </>
  );
}

function Result({ summary }: { summary: InstallSummary }) {
  const pending = summary.tone === "stale";
  return (
    <SectionCard title={summary.proposalId ? "Sent for review" : "Installed"}>
      <div className="flex items-start gap-2.5">
        {pending ? (
          <Clock size={15} className="mt-0.5 shrink-0 text-status-stale" />
        ) : (
          <CheckCircle2
            size={15}
            className="mt-0.5 shrink-0 text-status-healthy"
          />
        )}
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px] leading-relaxed text-foreground/75">
            {summary.sentence}
          </p>
          {summary.workspaceId && (
            <Link
              href={`/workspaces/${summary.workspaceId}`}
              className={`inline-flex w-fit items-center gap-1.5 rounded-sm text-[12.5px] font-medium text-primary hover:underline ${FOCUS_RING}`}
            >
              Open the space <ArrowRight size={13} />
            </Link>
          )}
          {summary.proposalId && (
            <Link
              href={navHref("review", { focus: summary.proposalId })}
              className={`inline-flex w-fit items-center gap-1.5 rounded-sm text-[12.5px] font-medium text-primary hover:underline ${FOCUS_RING}`}
            >
              Open in Review <ArrowRight size={13} />
            </Link>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function PlanBody({ report }: { report: PreflightReport }) {
  const { profiles, entityLinks, validationErrors } = report;
  const orphanedViews = report.views?.wouldOrphan ?? [];
  const scopeConflicts = profiles.scopeConflicts ?? [];

  return (
    <div className="flex flex-col gap-3">
      {validationErrors.length > 0 && (
        <PlanGroup tone="down" heading="Errors in the package">
          {validationErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </PlanGroup>
      )}

      {profiles.create.length > 0 && (
        <PlanGroup
          heading={`Creates ${profiles.create.length} entity type${profiles.create.length === 1 ? "" : "s"}`}
        >
          {profiles.create.map((s) => (
            <li key={s} className="font-mono">
              {s}
            </li>
          ))}
        </PlanGroup>
      )}

      {profiles.reused.length > 0 && (
        <PlanGroup
          heading={`Reuses ${profiles.reused.length} entity type${profiles.reused.length === 1 ? "" : "s"} you already have`}
        >
          {profiles.reused.map((s) => (
            <li key={s} className="font-mono">
              {s}
            </li>
          ))}
        </PlanGroup>
      )}

      {profiles.conflicts.length > 0 && (
        <PlanGroup tone="down" heading="Conflicts — these would be skipped">
          {profiles.conflicts.map((c) => (
            <li key={c.slug}>
              <span className="font-mono">{c.slug}</span> — declared as{" "}
              {c.declaredKind}, exists here as {c.existingKind}
            </li>
          ))}
        </PlanGroup>
      )}

      {profiles.deferred.length > 0 && (
        <PlanGroup tone="stale" heading="Would be duplicated, not shared">
          {profiles.deferred.map((d) => (
            <li key={d.slug}>
              <span className="font-mono">{d.slug}</span> — {d.reason}
            </li>
          ))}
        </PlanGroup>
      )}

      {scopeConflicts.length > 0 && (
        <PlanGroup
          tone="stale"
          heading="Reused as-is — the package's own scope is not applied"
        >
          {scopeConflicts.map((c) => (
            <li key={c.slug}>
              <span className="font-mono">{c.slug}</span> — this package
              declares {c.declaredScope} scope; your pod already has it as{" "}
              {c.existingScope} ({c.existingEntityScope}-wide). The existing one
              is used unchanged.
            </li>
          ))}
        </PlanGroup>
      )}

      {entityLinks.unresolved.length > 0 && (
        <PlanGroup tone="stale" heading="Relations that would be dropped">
          {entityLinks.unresolved.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </PlanGroup>
      )}

      {orphanedViews.length > 0 && (
        <PlanGroup tone="stale" heading="Views with no entity type to scope to">
          {orphanedViews.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </PlanGroup>
      )}

      {report.ok &&
        profiles.create.length === 0 &&
        profiles.reused.length === 0 &&
        scopeConflicts.length === 0 && (
          <div className="flex items-start gap-2 text-[12.5px] text-foreground/70">
            <Info size={14} className="mt-0.5 shrink-0 text-foreground/40" />
            <p>No entity types change.</p>
          </div>
        )}
    </div>
  );
}

function PlanGroup({
  heading,
  tone = "neutral",
  children,
}: {
  heading: string;
  tone?: "neutral" | "stale" | "down";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "down"
      ? "text-status-down"
      : tone === "stale"
        ? "text-status-stale"
        : "text-foreground";
  return (
    <div className="flex flex-col gap-1">
      <p className={`text-[12.5px] font-medium ${toneClass}`}>{heading}</p>
      <ul className="flex flex-col gap-0.5 break-words pl-3 text-[12px] text-foreground/65">
        {children}
      </ul>
    </div>
  );
}

/**
 * Where the entry came from, in words. The catalog stores publisher ids, not
 * names, so the vendor id and the source id live in Advanced rather than
 * being dressed up as an identity here.
 */
function Provenance({ pkg }: { pkg: CatalogDetail }) {
  return (
    <p className="mt-3 border-t border-foreground/[0.07] pt-3 text-[12px] text-foreground/65">
      From the {pkg.sourceName} catalog
      {pkg.official ? "." : " — a source an admin of this pod added."}
    </p>
  );
}

function Choose({ matches }: { matches: CatalogEntry[] }) {
  return (
    <PageShell className="flex flex-col gap-4">
      <BackLink />
      <SectionCard title="More than one entry has this name">
        <ul className="flex flex-col gap-1.5">
          {matches.map((m) => (
            <li key={`${m.source}|${m.kind}`}>
              <Link
                href={catalogDetailHref(m)}
                prefetch={false}
                className={`rounded-sm text-[12.5px] font-medium text-primary hover:underline ${FOCUS_RING}`}
              >
                {m.name} — {catalogKindLabel(m.objectKind)} from {m.sourceName}
              </Link>
            </li>
          ))}
        </ul>
      </SectionCard>
    </PageShell>
  );
}

function Failure({
  message,
  detail,
  onRetry,
}: {
  message: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <PageShell className="flex flex-col gap-4">
      <BackLink />
      <ErrorNote message={message} detail={detail} />
      {onRetry && (
        <Button
          size="sm"
          radius="md"
          variant="flat"
          className="w-fit"
          onPress={onRetry}
        >
          Retry
        </Button>
      )}
    </PageShell>
  );
}

function BackLink() {
  return (
    <Link
      href={navHref("marketplace")}
      className={`inline-flex w-fit items-center gap-1.5 rounded-sm text-[12px] text-foreground/65 hover:text-foreground ${FOCUS_RING}`}
    >
      <ArrowLeft size={13} /> Marketplace
    </Link>
  );
}
