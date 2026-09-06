"use client";

/**
 * Package detail + install.
 *
 * The disclosure ladder, in order, no wizard:
 *   1. What it is           — description, kind, provenance (always available)
 *   2. What it contains     — counts read off the published definition
 *   3. What it will DO here — the pod's own write-free preflight report
 *   4. Confirm              — the governed apply
 *
 * Step 3 is the point of the whole surface. The pod answers "these 7 profiles
 * would be created, this one conflicts with a role you already have" BEFORE
 * anything is written; skipping it would make the confirm button a dare.
 *
 * The trust content here is the preflight report — what this install does to
 * THIS pod, checked against this pod's own catalog — plus the package's
 * provenance. There is no install count and no "Verified" badge: the first is
 * bumped by an unauthenticated endpoint and the second certifies a DNS record,
 * so neither is evidence of anything.
 *
 * On the result: read `outcome`/`status`, never the absence of an error. A
 * re-install that changed nothing says so.
 */

import { Button, Chip, Spinner } from "@heroui/react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock,
  Copy,
  Info,
  Store,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  humanizeToken,
  OBJECT_KINDS,
  OBJECT_KIND_ALIASES,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import { readableDescription } from "../../../../lib/marketplace";
import type { PackageDetail } from "../../../../lib/marketplace";
import { openIn } from "../../../../lib/open-in";
import { HandoffCard } from "../../components/handoff-card";
import { SectionCard } from "../../components/section-card";
import { ResourceRowError } from "../../components/resource-row";
import { kindIcon, kindLabel, kindPackagePhrase } from "../_lib/kind-icon";
import type {
  AppliedResult,
  InstallError,
  PreflightReport,
} from "../_lib/types";

/**
 * Which definition keys become a "what it contains" line, in reading order.
 *
 * Keys that name an OBJECT KIND carry the kind, not a label: the words come
 * from `@synap-core/types/vocabulary`, the one door. This file previously
 * hand-wrote both forms and had already forked — it said "card"/"cards" where
 * the registry says "Card"/"Cards", and "entity type" where the landing page
 * said "record type". A second label table is a fork the moment it exists, and
 * this one was correct-looking enough to survive review, which is exactly how.
 *
 * The remaining keys have NO object kind — they name parts of a definition's
 * structure, not things the product has nouns for — so they keep an explicit
 * label here. That is not a fork: there is nothing upstream to disagree with.
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
 * The registry's own singular/plural for a kind. `resolveObjectNoun` returns
 * only the singular, and `labelPlural` lives on the registry rows, which the
 * vocabulary entry point re-exports — so both words still come from the SSOT.
 * No naive `+ "s"`: that turns "Property" into "Propertys".
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

type Stage =
  | { kind: "idle" }
  | { kind: "preflighting" }
  | { kind: "plan"; report: PreflightReport }
  | { kind: "applying"; report: PreflightReport }
  | { kind: "applied"; result: AppliedResult }
  | { kind: "failed"; error: InstallError };

export default function PackageDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? "";

  const [pkg, setPkg] = useState<PackageDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetch(`/api/marketplace/packages/${encodeURIComponent(slug)}`, {
      credentials: "include",
    })
      .then(async (res) => {
        const body = (await res.json()) as
          { package: PackageDetail } | { error: string };
        if (!res.ok) {
          throw new Error(
            "error" in body ? body.error : `Catalog error ${res.status}`
          );
        }
        return (body as { package: PackageDetail }).package;
      })
      .then((p) => {
        if (!cancelled) setPkg(p);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : "Unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function callInstall(step: "preflight" | "apply") {
    const res = await fetch("/api/marketplace/install", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, step }),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  }

  async function runPreflight() {
    setStage({ kind: "preflighting" });
    try {
      const { status, body } = await callInstall("preflight");
      if (status !== 200) {
        setStage({ kind: "failed", error: body as InstallError });
        return;
      }
      setStage({ kind: "plan", report: body as PreflightReport });
    } catch {
      setStage({
        kind: "failed",
        error: { error: "Could not reach this pod." },
      });
    }
  }

  async function runApply(report: PreflightReport) {
    setStage({ kind: "applying", report });
    try {
      const { status, body } = await callInstall("apply");
      // Read what the pod actually reported. There is no `success` field on
      // this response, so the absence of one means nothing at all.
      if (status === 200 || status === 201) {
        setStage({ kind: "applied", result: body as AppliedResult });
        return;
      }
      setStage({ kind: "failed", error: body as InstallError });
    } catch {
      setStage({
        kind: "failed",
        error: { error: "Could not reach this pod." },
      });
    }
  }

  if (loadError) {
    return (
      <div className="px-6 py-6 max-w-[900px]">
        <BackLink />
        <ResourceRowError message={loadError} />
      </div>
    );
  }

  if (!pkg) {
    return (
      <div className="px-6 py-6 max-w-[900px]">
        <BackLink />
        <div className="flex items-center gap-2 py-10 text-[12.5px] text-foreground/55">
          <Spinner size="sm" /> Loading package…
        </div>
      </div>
    );
  }

  const Icon = kindIcon(pkg.category);
  const contents = CONTENT_ROWS.map((row) => {
    const value = pkg.definition?.[row.key];
    // A capability package stores a SINGULAR `capability` object, not a
    // `capabilities` array — 24 of the 53 published packages are that shape.
    // Counting arrays only made every one of them report zero contents, and
    // the empty branch below then asserted "declares no profiles, views or
    // capabilities" about a definition this page was holding in memory. The
    // landing detail page already folds the object form; this matches it.
    // The array is checked for LENGTH, not just presence: `capabilities: []`
    // alongside a singular `capability` object is a real shape here (25 shipped
    // templates write `skills: []` present-but-empty), and testing
    // `Array.isArray` first would let that empty array shadow the object and
    // report 0 — the same false "declares nothing" this fold exists to prevent.
    const arrayCount = Array.isArray(value) ? value.length : 0;
    const hasSingularCapability =
      row.key === "capabilities" &&
      !!pkg.definition?.capability &&
      typeof pkg.definition.capability === "object";
    const count = arrayCount > 0 ? arrayCount : hasSingularCapability ? 1 : 0;
    return { ...row, ...nounsFor(row), count };
  }).filter((row) => row.count > 0);

  return (
    <div className="px-6 py-6 max-w-[900px] flex flex-col gap-4">
      <BackLink />

      {/* ── 1. What it is ─────────────────────────────────────────────── */}
      <header className="flex flex-col gap-2">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.06] text-foreground/70">
            <Icon size={17} />
          </span>
          <div className="min-w-0 flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
                {pkg.displayName}
              </h1>
              <Chip
                size="sm"
                radius="sm"
                variant="flat"
                className="text-[11px]"
              >
                {kindLabel(pkg.category)}
              </Chip>
            </div>
            <p className="font-mono text-[11.5px] text-foreground/45">
              {pkg.slug} · {pkg.version}
              {pkg.domain ? ` · ${pkg.domain}` : ""}
            </p>
          </div>
        </div>

        {readableDescription(pkg.description) && (
          <p className="text-[13px] leading-relaxed text-foreground/70">
            {readableDescription(pkg.description)}
          </p>
        )}

        {pkg.tags && pkg.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {pkg.tags.map((tag) => (
              <Chip
                key={tag}
                size="sm"
                radius="sm"
                variant="flat"
                className="text-[11px] text-foreground/60"
              >
                {tag}
              </Chip>
            ))}
          </div>
        )}
      </header>

      {/* ── 2. What it contains ───────────────────────────────────────── */}
      <SectionCard
        title="What's in this package"
        hint="Read from the published definition"
      >
        {contents.length === 0 ? (
          <p className="text-[12.5px] text-foreground/55">
            This package declares no profiles, views or capabilities — it
            carries configuration only.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {contents.map((row) => (
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

        {Array.isArray(pkg.definition?.dependencies) &&
          pkg.definition.dependencies.length > 0 && (
            <p className="mt-3 border-t border-foreground/[0.07] pt-3 text-[12px] text-foreground/55">
              Also pulls in:{" "}
              {pkg.definition.dependencies.map((d) => d.slug).join(", ")}
            </p>
          )}
      </SectionCard>

      {/* ── 3 + 4. What it will do here, then confirm ─────────────────── */}
      <InstallPanel
        stage={stage}
        category={pkg.category}
        slug={pkg.slug}
        source={pkg.source ?? null}
        vendorId={pkg.vendorId ?? null}
        onPreflight={runPreflight}
        onApply={runApply}
        onReset={() => setStage({ kind: "idle" })}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/marketplace"
      className="inline-flex w-fit items-center gap-1.5 text-[12px] text-foreground/55 hover:text-foreground"
    >
      <ArrowLeft size={13} /> Marketplace
    </Link>
  );
}

function InstallPanel({
  stage,
  category,
  slug,
  source,
  vendorId,
  onPreflight,
  onApply,
  onReset,
}: {
  stage: Stage;
  category: string;
  slug: string;
  source: string | null;
  vendorId: string | null;
  onPreflight: () => void;
  onApply: (report: PreflightReport) => void;
  onReset: () => void;
}) {
  if (stage.kind === "applied") {
    const { status, outcome, workspaceId } = stage.result;
    // Report only what the pod's own response says. `outcome` is the
    // discriminator that tells a fresh materialization apart from an idempotent
    // re-hit; inferring "created" from a 200 would call a no-op reinstall a new
    // workspace. `status: "pending"` means provisioning has not finished — it
    // is in progress, not done.
    const pending = status === "pending";
    return (
      <SectionCard title={pending ? "Installing" : "Installed"}>
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
              {pending
                ? "The workspace exists but the pod is still provisioning it. Reopen it in a moment to see the finished result."
                : outcome === "unchanged"
                  ? "Already installed and up to date — the pod made no changes."
                  : outcome === "reconciled"
                    ? "Already installed; the pod updated it to this version."
                    : outcome === "created"
                      ? "A new workspace was created."
                      : "The pod accepted the install but did not say what it did — open the workspace to check."}
            </p>
            {workspaceId && (
              <Link
                href={`/workspaces/${workspaceId}`}
                className="inline-flex w-fit items-center gap-1.5 text-[12.5px] font-medium text-primary hover:underline"
              >
                Open the workspace <ArrowRight size={13} />
              </Link>
            )}
          </div>
        </div>
      </SectionCard>
    );
  }

  if (stage.kind === "failed") {
    // A kind this front desk does not install is a BOUNDARY, not a failure —
    // an amber note plus the surface that owns it, never a red error box and
    // never an apology for a feature nobody is coming to build here.
    const blockedByKind = stage.error.reason === "kind_not_installable_here";
    return (
      <SectionCard
        title={blockedByKind ? "Installs in the desktop app" : "Install failed"}
      >
        <div className="flex items-start gap-2.5">
          <CircleAlert
            size={15}
            className={[
              "mt-0.5 shrink-0",
              blockedByKind ? "text-status-stale" : "text-status-down",
            ].join(" ")}
          />
          <div className="flex flex-col gap-2 min-w-0">
            <p className="text-[12.5px] leading-relaxed text-foreground/75">
              {stage.error.error}
            </p>
            {stage.error.detail && (
              <p className="text-[12px] text-foreground/55">
                {stage.error.detail}
              </p>
            )}
            {stage.error.conflicts && stage.error.conflicts.length > 0 && (
              <ul className="flex flex-col gap-1 text-[12px] text-foreground/60">
                {stage.error.conflicts.map((c) => (
                  <li key={c.slug}>
                    <span className="font-mono">{c.slug}</span> — this package
                    declares it as a {c.declaredKind}, your pod already has it
                    as a {c.existingKind}.
                  </li>
                ))}
              </ul>
            )}
            {blockedByKind && <KindHandoff category={category} slug={slug} />}
            {/*
             * "Start over" belongs on BOTH branches. It used to be hidden when
             * `blockedByKind`, which left that card with no exit at all — the
             * only way back was a BackLink already scrolled off the top.
             */}
            <Button
              size="sm"
              radius="sm"
              variant="flat"
              className="w-fit"
              onPress={onReset}
            >
              Start over
            </Button>
          </div>
        </div>
      </SectionCard>
    );
  }

  if (stage.kind === "plan" || stage.kind === "applying") {
    const { report } = stage;
    const applying = stage.kind === "applying";
    return (
      <SectionCard
        title="What this will do to your pod"
        hint="Checked against this pod — nothing has been written"
      >
        <PlanBody report={report} />
        <Provenance source={source} vendorId={vendorId} />
        <div className="mt-4 flex items-center gap-2 border-t border-foreground/[0.07] pt-3">
          <Button
            size="sm"
            radius="sm"
            color="primary"
            isDisabled={applying || !report.ok}
            isLoading={applying}
            onPress={() => onApply(report)}
          >
            {applying ? "Installing…" : "Install"}
          </Button>
          <Button
            size="sm"
            radius="sm"
            variant="light"
            isDisabled={applying}
            onPress={onReset}
          >
            Cancel
          </Button>
        </div>
      </SectionCard>
    );
  }

  /**
   * Where a non-workspace package actually installs.
   *
   * `POST /api/marketplace/install` answers 501 for `capability | cell | view |
   * automation | skill`; only `workspace` has a web install path. Before this,
   * the page said "Not installable from here yet" — which reads as a defect in
   * the product rather than what it is: a boundary. pod-admin is the pod's front
   * desk, and installing a capability into a running workspace is desktop work.
   *
   * So: name the real destination first, and keep the CLI as a genuine second
   * option rather than the apologetic only one. Operators who live in a terminal
   * legitimately prefer it, and it is the one path that works for every kind.
   */
  function KindHandoff({ category, slug }: { category: string; slug: string }) {
    const noun = resolveObjectNoun(category);
    return (
      <div className="flex flex-col gap-3">
        <HandoffCard
          title={`${noun} packages install in the desktop app`}
          body={`Installing a ${noun.toLowerCase()} binds it to a live workspace, so it happens where that workspace is open. The pod's marketplace here is for browsing and for workspace packages.`}
          exit={openIn({ kind: "app", appId: "marketplace" })}
          cta="Open the marketplace in the app"
        />
        <div className="flex flex-col gap-1.5">
          <p className="text-[11.5px] text-foreground/50">
            Or install it from a terminal:
          </p>
          <code className="w-fit rounded-md bg-foreground/[0.06] px-2.5 py-1.5 font-mono text-[11.5px] text-foreground/80">
            synap market install {slug}
          </code>
        </div>
      </div>
    );
  }

  // The install door only handles workspace packages — `POST /api/marketplace/
  // install` answers 501 for the other five kinds. `category` is known HERE, at
  // render, so say it BEFORE offering the button. Presenting an identical CTA
  // and an identical "you'll see exactly what changes" promise for all six
  // kinds, then failing after the click, is what made an honest boundary read
  // as a broken feature.
  if (category !== "workspace") {
    return (
      <SectionCard title="Install" hint="This kind installs in the desktop app">
        <KindHandoff category={category} slug={slug} />
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
        radius="sm"
        color="primary"
        className="w-fit"
        isLoading={stage.kind === "preflighting"}
        isDisabled={stage.kind === "preflighting"}
        onPress={onPreflight}
      >
        {stage.kind === "preflighting" ? "Checking…" : "Check this pod"}
      </Button>
    </SectionCard>
  );
}

function PlanBody({ report }: { report: PreflightReport }) {
  const { profiles, entityLinks, validationErrors } = report;
  const orphanedViews = report.views?.wouldOrphan ?? [];
  const scopeConflicts = profiles.scopeConflicts ?? [];

  return (
    <div className="flex flex-col gap-3">
      {!report.ok && (
        <div className="flex items-start gap-2 rounded-lg bg-status-down/10 px-3 py-2 ring-1 ring-inset ring-status-down/25">
          <CircleAlert size={14} className="mt-0.5 shrink-0 text-status-down" />
          <p className="text-[12px] leading-relaxed text-foreground/75">
            This package would not apply cleanly to your pod. Installing is
            blocked until the conflicts below are resolved.
          </p>
        </div>
      )}

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
            <p>
              No entity types change. The package&apos;s other contents —
              capabilities, playbooks, automations — are applied after the
              workspace step and are not part of this check.
            </p>
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
      <ul className="flex flex-col gap-0.5 pl-3 text-[12px] text-foreground/60">
        {children}
      </ul>
    </div>
  );
}

/**
 * Where the package came from. The catalog carries `source` plus two opaque
 * UUIDs and NO publisher name, so this says exactly that rather than dressing
 * an id up as an identity. An unnamed publisher shown as "Unknown" would still
 * be more honest than a badge, but naming the gap is better than either.
 */
function Provenance({
  source,
  vendorId,
}: {
  source: string | null;
  vendorId: string | null;
}) {
  return (
    <div className="mt-3 flex flex-col gap-1 border-t border-foreground/[0.07] pt-3">
      <p className="text-[12px] text-foreground/55">
        {source
          ? `Published to the catalog by: ${humanizeToken(source)}`
          : "The catalog records no publishing source for this package."}
      </p>
      {vendorId ? (
        <p className="font-mono text-[11px] text-foreground/40">
          vendor {vendorId}
        </p>
      ) : (
        <p className="text-[11.5px] text-foreground/40">
          No vendor is named — the catalog stores publisher ids, not names.
        </p>
      )}
    </div>
  );
}
