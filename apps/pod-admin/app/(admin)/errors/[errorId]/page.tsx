"use client";

/**
 * `/errors/[errorId]` — one server error, the page a 5xx body's `causeUrl`
 * opens (`system.getServerFault`, pod owner or admin; table `server_faults`).
 *
 * The CAUSE first: the innermost error, read as "field.path: message" when it
 * is a validation error's issue list; then the chain it came from, outermost
 * first; then its stack. The error texts are what the code threw: shown as
 * written (content), never translated.
 */

import { useParams } from "next/navigation";
import { trpc } from "../../../../lib/trpc";
import { formatRelative, formatTimestamp } from "../../../../lib/format";
import { navHref, navLabel } from "../../../../lib/console-nav";
import { useT } from "../../../../lib/i18n/locale-provider";
import { couldNotLoad, loadFailure } from "../../../_lib/object/load-failure";
import { useReauthOnUnauthorized } from "../../../_lib/object/use-reauth";
import { consoleFrame } from "../../../_lib/object/views/object-frame";
import { ERRORS_CATALOGS } from "../_lib/copy";
import {
  faultHeadline,
  faultRequest,
  readableMessage,
  rootCause,
  type FaultCauseLike,
} from "../_lib/fault-model";

const FRAME = consoleFrame({
  label: navLabel("errors"),
  href: navHref("errors"),
});

const PRE =
  "max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-foreground/[0.05] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-foreground/90";

export default function ServerErrorPage() {
  const t = useT(ERRORS_CATALOGS);
  const { errorId: raw } = useParams<{ errorId: string }>();
  const errorId = decodeURIComponent(raw);
  const query = trpc.system.getServerFault.useQuery(
    { errorId },
    { retry: false }
  );
  useReauthOnUnauthorized(query.error);

  if (query.isLoading) return FRAME.loading(t("noun.fault"));
  const fault = query.data;
  const wording = {
    inApp: false,
    notFound: t("fail.notFound"),
  } as const;
  const fail = loadFailure(query.error, t("fail.noun"), wording);
  if (fail || !fault) {
    return FRAME.failure({
      kind: "server_error",
      id: errorId,
      failure: fail ?? couldNotLoad(t("fail.noun"), wording),
      openIn: false,
    });
  }

  const cause = rootCause(fault);
  // The chain, outermost first: the error that reached the handler, then
  // what it was caused by.
  const chain: FaultCauseLike[] = [
    { name: fault.errorName, message: fault.message, stack: fault.stack },
    ...fault.causes,
  ];

  return FRAME.object({
    header: {
      kind: "server_error",
      noun: t("noun.fault"),
      title: faultHeadline(fault),
      summary: faultRequest(fault),
      status: {
        kind: "down",
        label: t("status.code", { status: String(fault.status) }),
      },
      breadcrumb: FRAME.breadcrumb?.(errorId),
    },
    facts: [
      {
        label: t("fact.when"),
        value: `${formatTimestamp(fault.occurredAt)} (${formatRelative(fault.occurredAt)})`,
      },
      { label: t("fact.request"), value: faultRequest(fault), mono: true },
      {
        label: t("fact.door"),
        value: fault.door === "trpc" ? t("door.trpc") : t("door.rest"),
      },
      {
        label: t("fact.caller"),
        value: fault.userId ?? t("caller.none"),
        mono: Boolean(fault.userId),
      },
      ...(fault.agentUserId
        ? [{ label: t("fact.agent"), value: fault.agentUserId, mono: true }]
        : []),
    ],
    children: (
      <>
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-medium text-foreground">
            {t("section.cause")}
          </h2>
          <p className="font-mono text-[12.5px] text-foreground/80">
            {cause.name}
          </p>
          <pre className={PRE}>{readableMessage(cause.message)}</pre>
        </section>
        {chain.length > 1 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-medium text-foreground">
              {t("section.chain")}
            </h2>
            <ol className="flex flex-col gap-2">
              {chain.map((c, i) => (
                <li key={i} className="flex flex-col gap-1">
                  <p className="font-mono text-[12.5px] text-foreground/80">
                    {c.name}
                  </p>
                  <pre className={PRE}>{readableMessage(c.message)}</pre>
                </li>
              ))}
            </ol>
          </section>
        )}
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-medium text-foreground">
            {t("section.stack")}
          </h2>
          {cause.stack ? (
            <pre className={PRE}>{cause.stack}</pre>
          ) : (
            <p className="text-[12.5px] text-foreground/65">
              {t("section.noStack")}
            </p>
          )}
        </section>
      </>
    ),
    advanced: {
      ids: [{ label: t("id.error"), value: fault.errorId }],
      raw: fault,
    },
  });
}
