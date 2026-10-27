"use client";

/**
 * A BOX run's own story on the run page (code-runtime B0): what it produced,
 * its log, what its box was refused, and the script as queued. Read from
 * `runs.get`'s `boxRun` block — the same read the rest of the run page uses;
 * nothing here fetches on its own. Produced outranks process: files first,
 * then the log, then the evidence, the script folded last.
 */

import { useState } from "react";
import { Button } from "@heroui/react";
import { ExitLink } from "../../../../lib/exit-link";
import { openIn } from "../../../../lib/open-in";
import { formatTimestamp } from "../../../../lib/format";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";

type RunDetail = NonNullable<inferRouterOutputs<AppRouter>["runs"]["get"]>;
export type BoxRunView = NonNullable<RunDetail["boxRun"]>;

/** Log lines drawn before "Show all". */
const LOG_LINES_SHOWN = 40;

/** The facts a box run adds to the run page's grid. */
export function boxRunFacts(box: BoxRunView) {
  const ev = box.evidence;
  return [
    {
      label: "Runs on",
      value: box.computerName ?? "Your computer (not picked up yet)",
    },
    {
      label: "Script",
      value: `${box.script.language} · ${box.script.entrypoint}`,
    },
    ...(ev?.exitCode !== undefined && ev?.exitCode !== null
      ? [{ label: "Exit code", value: String(ev.exitCode) }]
      : []),
    ...(ev?.durationMs
      ? [
          {
            label: "Took",
            value: `${Math.max(1, Math.round(ev.durationMs / 1000))} s`,
          },
        ]
      : []),
    ...(box.startedAt
      ? [{ label: "Script started", value: formatTimestamp(box.startedAt) }]
      : []),
  ];
}

function LogBlock({ box }: { box: BoxRunView }) {
  const [all, setAll] = useState(false);
  const log = box.evidence?.log;
  if (!log || (!log.head && !log.tail)) {
    return (
      <p className="text-[12.5px] text-foreground/65">
        {box.evidence
          ? "The script printed nothing."
          : "The log comes back when the run finishes."}
      </p>
    );
  }
  const text = log.tail
    ? `${log.head}\n… ${log.truncated ? "the middle of the log was not kept" : ""} …\n${log.tail}`
    : log.head;
  const lines = text.split("\n");
  const shown = all ? lines : lines.slice(-LOG_LINES_SHOWN);
  return (
    <div className="flex flex-col gap-1.5">
      <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-foreground/[0.04] px-3 py-2 font-mono text-[11.5px] leading-relaxed text-foreground/85">
        {shown.join("\n")}
      </pre>
      {lines.length > LOG_LINES_SHOWN && (
        <Button
          size="sm"
          variant="light"
          radius="md"
          className="self-start"
          onPress={() => setAll((v) => !v)}
        >
          {all ? "Show the end only" : `Show all ${lines.length} lines`}
        </Button>
      )}
    </div>
  );
}

export function BoxRunSection({
  box,
  summary,
}: {
  box: BoxRunView;
  /** Where it stands: the run's `summary`, derived once by the pod. */
  summary: string | null;
}) {
  const ev = box.evidence;
  const files = ev?.files ?? [];
  return (
    <div className="flex flex-col gap-5">
      {summary && <p className="text-[12.5px] text-foreground/75">{summary}</p>}

      {files.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-medium text-foreground">Produced</h3>
          <ul className="flex flex-col gap-1.5">
            {files.map((f) => (
              <li
                key={f.path}
                className="flex flex-wrap items-center gap-x-3 text-[12.5px]"
              >
                {f.status === "created" && f.fileEntityId ? (
                  <ExitLink
                    exit={openIn({
                      kind: "object",
                      objectKind: "entity",
                      id: f.fileEntityId,
                    })}
                    label={f.title ?? f.path}
                  />
                ) : f.status === "proposed" && f.proposalId ? (
                  <ExitLink
                    exit={openIn({
                      kind: "object",
                      objectKind: "proposal",
                      id: f.proposalId,
                    })}
                    label={`${f.title ?? f.path} — waiting for your review`}
                  />
                ) : (
                  <span className="text-foreground/75">
                    {f.path}
                    {f.status === "refused"
                      ? ` — not stored: ${f.error ?? "refused"}`
                      : " — not stored (the run had no space to store it in)"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium text-foreground">Log</h3>
        <LogBlock box={box} />
      </section>

      {ev && ev.blockedEgress.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-medium text-foreground">
            Blocked from the network
          </h3>
          <ul className="flex flex-col gap-1 text-[12.5px] text-foreground/80">
            {ev.blockedEgress.slice(0, 20).map((b, i) => (
              <li key={`${b.host}:${b.port ?? ""}:${i}`}>
                {b.host}
                {b.port ? `:${b.port}` : ""}
                {b.phase === "setup" ? " (while installing)" : ""}
                {b.reason ? ` — ${b.reason}` : ""}
              </li>
            ))}
          </ul>
          {ev.blockedEgress.length > 20 && (
            <p className="text-[12px] text-foreground/65">
              The first 20 of {ev.blockedEgress.length}.
            </p>
          )}
        </section>
      )}

      <details className="rounded-md ring-1 ring-inset ring-foreground/[0.08]">
        <summary className="cursor-pointer px-3 py-2 text-[12.5px] text-foreground/80">
          The script, as approved ({box.script.packages.length} package
          {box.script.packages.length === 1 ? "" : "s"}, reaches{" "}
          {box.script.hosts.length > 0
            ? box.script.hosts.join(", ")
            : "no host"}
          )
        </summary>
        <div className="flex flex-col gap-2 px-3 pb-3">
          {box.script.packages.length > 0 && (
            <p className="text-[12px] text-foreground/75">
              {box.script.packages
                .map((p) => `${p.name}==${p.version}`)
                .join(", ")}
            </p>
          )}
          <pre className="max-h-[24rem] overflow-auto whitespace-pre rounded-md bg-foreground/[0.04] px-3 py-2 font-mono text-[11.5px] text-foreground/85">
            {box.script.code}
          </pre>
        </div>
      </details>
    </div>
  );
}
