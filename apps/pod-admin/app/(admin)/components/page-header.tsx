import type { ReactNode } from "react";
import { ResourceRowSkeleton } from "./resource-row";

/**
 * The title block every console page opens with: name, one line on what the
 * page is for, and optional page-level actions on the right.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          {title}
        </h1>
        {description && (
          <p className="max-w-2xl text-[13px] text-foreground/65">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </header>
  );
}

/**
 * The column every console page sits in — one width and one gutter for all
 * of them, so moving between pages never shifts the content edge.
 * `personal` is the narrower column of the self-service pages (Connected,
 * My vault, My computers), which sit outside the console's side nav.
 */
export function PageShell({
  children,
  className,
  width = "console",
}: {
  children: ReactNode;
  className?: string;
  width?: "console" | "personal";
}) {
  return (
    <div
      className={[
        "mx-auto px-4 sm:px-6",
        width === "personal" ? "max-w-[900px] py-10" : "max-w-[1100px] py-6",
        className ?? "",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

/**
 * A page's loading shape without its shell: a header placeholder over a list
 * of row placeholders, so the content lands where the skeleton stood.
 */
export function PageSkeleton({
  rows = 4,
  label = "Loading…",
}: {
  rows?: number;
  label?: string;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <div className="mb-6 flex flex-col gap-2">
        <div className="h-6 w-40 rounded bg-foreground/10 shimmer-pulse" />
        <div className="h-3 w-full max-w-sm rounded bg-foreground/[0.07] shimmer-pulse" />
      </div>
      <div className="rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
        <ResourceRowSkeleton count={rows} />
      </div>
    </div>
  );
}

/** The Suspense fallback of a console page. */
export function PageFallback({ rows }: { rows?: number }) {
  return (
    <PageShell>
      <PageSkeleton rows={rows} />
    </PageShell>
  );
}
