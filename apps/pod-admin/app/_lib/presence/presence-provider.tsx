"use client";

/**
 * The proof-of-presence dialog, mounted ONCE in `app/providers.tsx`.
 * `usePresence().prove(subject, refusal)` opens it and resolves with a
 * `{kind: "passkey"}` proof, or rejects with `PresenceDeclined` when the
 * person does not confirm. The approve doors of this folder call it when the
 * pod answers `PRESENCE_*` (`presence-model.ts`); no page opens it itself.
 *
 * The challenge is read when the dialog opens, and the passkey prompt starts
 * on the person's click: a browser runs WebAuthn only from a user gesture,
 * and the click that sent the approval was spent on the first, refused, try.
 *
 * It names what is being approved (the request's heading, derived like its
 * page through `proposalHeading` and the vocabulary door); why the browser
 * asks for Touch ID or a security key is one "Why?" away. With no passkey on
 * this pod, or a browser that cannot use one, it says so: add one on the
 * passkeys page (a new tab; the dialog then says to come back and press Try
 * again), or approve in Relay with Face ID.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { Fingerprint } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";
import {
  PRESENCE_EXPIRED,
  PRESENCE_INVALID,
  PRESENCE_USED,
  type PresenceProof,
  type PresenceRefusalCode,
} from "@synap-core/types/presence";
import { trpc } from "../../../lib/trpc";
import { isUuid } from "../../../lib/format";
import {
  PasskeyCancelled,
  getPasskeyAssertion,
  isPasskeyAssertionSupported,
} from "../../../lib/passkey";
import { proposalHeading } from "../../proposal/[id]/proposal-heading";
import { PASSKEYS_PATH } from "../../settings/security/passkeys-path";
import { presenceT } from "./copy";
import { presenceDialogView } from "./dialog-model";
import {
  PresenceDeclined,
  challengeInput,
  type PresenceProgress,
  type PresenceSubject,
  type ProvePresence,
} from "./presence-model";

/** `presence.challenge`'s answer: `proposalId` names the request it signs. */
type PresenceChallenge = inferRouterOutputs<AppRouter>["presence"]["challenge"];

/** A challenge this close to its end is read again before the prompt. */
const CHALLENGE_MARGIN_MS = 15_000;

interface Ask {
  subject: PresenceSubject;
  refusal: PresenceRefusalCode;
  progress?: PresenceProgress;
  /**
   * Asked before the first try (a sensitive request). The dialog opens only
   * once the person can prove: no usable passkey, or an unreadable
   * challenge, resolves null without showing it, and the pod decides.
   */
  upFront: boolean;
  resolve: (proof: PresenceProof | null) => void;
  reject: (err: Error) => void;
}

type Outcome = { proof: PresenceProof | null } | { error: Error };

type Phase =
  | { kind: "reading" }
  /** The pod's own words, shown small under the headline (never the headline). */
  | { kind: "read-failed"; detail: string | null }
  | { kind: "ready"; challenge: PresenceChallenge; note: string | null }
  | { kind: "signing"; challenge: PresenceChallenge };

interface PresenceContextValue {
  prove: ProvePresence;
}

// Outside the provider (a test, an island page) nobody can prove here: the
// call goes without a proof and the pod decides, as with no usable passkey.
const PresenceContext = createContext<PresenceContextValue>({
  prove: async () => null,
});

/** The person's proof of presence, asked through the one dialog. */
export function usePresence(): PresenceContextValue {
  return useContext(PresenceContext);
}

/** Why the pod asks again, in words; null for a first ask. */
function againNote(refusal: PresenceRefusalCode): string | null {
  const t = presenceT();
  switch (refusal) {
    case PRESENCE_INVALID:
      return t("again.invalid");
    case PRESENCE_EXPIRED:
      return t("again.expired");
    case PRESENCE_USED:
      return t("again.used");
    default:
      return null;
  }
}

export function PresenceProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  // One ask at a time: a second waits for the first to settle.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const prove = useCallback<ProvePresence>(
    (subject, refusal, progress, options) => {
      const next = queue.current.then(
        () =>
          new Promise<PresenceProof | null>((resolve, reject) =>
            setAsk({
              subject,
              refusal,
              progress,
              upFront: options?.upFront === true,
              resolve,
              reject,
            })
          )
      );
      queue.current = next.catch(() => undefined);
      return next;
    },
    []
  );

  const value = useMemo(() => ({ prove }), [prove]);
  // The open ask, read by `settle` (an effect-free updater would run twice
  // in StrictMode and settle the promise from inside a render).
  const open = useRef<Ask | null>(null);
  open.current = ask;
  const settle = useCallback((outcome: Outcome) => {
    const current = open.current;
    if (!current) return;
    open.current = null;
    setAsk(null);
    if ("proof" in outcome) current.resolve(outcome.proof);
    else current.reject(outcome.error);
  }, []);

  return (
    <PresenceContext.Provider value={value}>
      {children}
      <PresenceDialog ask={ask} settle={settle} />
    </PresenceContext.Provider>
  );
}

function PresenceDialog({
  ask,
  settle,
}: {
  ask: Ask | null;
  settle: (outcome: Outcome) => void;
}) {
  const t = presenceT();
  const challengeMutation = trpc.presence.challenge.useMutation();
  const readChallenge = challengeMutation.mutateAsync;
  // Each phase belongs to one ask: a new ask starts at "reading" from its
  // first render, never on the last ask's challenge.
  // `shown`: this ask has had something to show (an up-front ask stays
  // hidden while its first challenge is read).
  const [state, setState] = useState<{
    ask: Ask | null;
    phase: Phase;
    shown: boolean;
  }>({ ask: null, phase: { kind: "reading" }, shown: false });
  const mine = state.ask === ask;
  const phase: Phase = mine ? state.phase : { kind: "reading" };
  const shown = mine && state.shown;
  // What the person opened in this ask's dialog: the "Why?" and the passkey
  // tab. Each belongs to one ask, like its phase.
  const [opened, setOpened] = useState<{
    ask: Ask | null;
    why: boolean;
    addPasskey: boolean;
  }>({ ask: null, why: false, addPasskey: false });
  const ours = opened.ask === ask;
  const whyOpen = ours && opened.why;
  const toggle = (part: "why" | "addPasskey", value: boolean) =>
    setOpened((prev) => ({
      ask,
      why: prev.ask === ask ? prev.why : false,
      addPasskey: prev.ask === ask ? prev.addPasskey : false,
      [part]: value,
    }));
  // The ask the latest read belongs to: a late answer of a closed ask is dropped.
  const live = useRef<Ask | null>(null);
  const setPhase = (forAsk: Ask, next: Phase) => {
    if (live.current === forAsk)
      setState((prev) => ({
        ask: forAsk,
        phase: next,
        shown: (prev.ask === forAsk && prev.shown) || next.kind !== "reading",
      }));
  };

  // Read a challenge for this ask. A ref, not an effect dependency: the
  // dialog reads once per ask, never again because a render made a new
  // function.
  // `mayPass`: an up-front ask's first read, which hands back null (no
  // proof, the pod decides) when the person cannot prove here.
  const read = useRef<
    (current: Ask, note: string | null, mayPass?: boolean) => Promise<void>
  >(async () => undefined);
  read.current = async (current: Ask, note: string | null, mayPass = false) => {
    setPhase(current, { kind: "reading" });
    try {
      const challenge = await readChallenge(challengeInput(current.subject));
      if (
        mayPass &&
        (challenge.passkey === null || !isPasskeyAssertionSupported())
      ) {
        if (live.current === current) settle({ proof: null });
        return;
      }
      setPhase(current, { kind: "ready", challenge, note });
    } catch (err) {
      if (mayPass) {
        if (live.current === current) settle({ proof: null });
        return;
      }
      // A failed read is not "no passkey": it says so, and keeps Try again.
      setPhase(current, {
        kind: "read-failed",
        detail: err instanceof Error && err.message ? err.message : null,
      });
    }
  };

  useEffect(() => {
    live.current = ask;
    if (ask) void read.current(ask, againNote(ask.refusal), ask.upFront);
  }, [ask]);

  async function signWith(challenge: PresenceChallenge) {
    if (!ask || !challenge.passkey) return;
    // Read a fresh one rather than sign a challenge about to lapse; the
    // person clicks again (the prompt needs that click).
    if (Date.parse(challenge.expiresAt) - Date.now() < CHALLENGE_MARGIN_MS) {
      await read.current(ask, null);
      return;
    }
    setPhase(ask, { kind: "signing", challenge });
    try {
      const credential = await getPasskeyAssertion(challenge.passkey);
      settle({
        proof: {
          kind: "passkey",
          challengeId: challenge.challengeId,
          credential,
        },
      });
    } catch (err) {
      setPhase(ask, {
        kind: "ready",
        challenge,
        note:
          err instanceof PasskeyCancelled
            ? t("cancelled")
            : t("ceremonyFailed"),
      });
    }
  }

  // A change this page makes itself (`doing`), not an approval: its own
  // words, and only this browser can prove it (no Relay).
  const doing = ask?.subject.doing ?? null;
  const decline = () =>
    settle({
      error: new PresenceDeclined(t(doing ? "declined.act" : "declined")),
    });
  const challenge =
    phase.kind === "ready" || phase.kind === "signing" ? phase.challenge : null;
  const progress = ask?.progress;
  const view = presenceDialogView({
    phase:
      phase.kind === "ready" || phase.kind === "signing"
        ? {
            kind: phase.kind,
            passkey: phase.challenge.passkey !== null,
            deviceKeys: phase.challenge.deviceKeys,
            note: phase.kind === "ready" ? phase.note : null,
          }
        : phase,
    passkeySupported: isPasskeyAssertionSupported(),
    progress,
    inBrowserOnly: doing !== null,
    addPasskeyOpened: ours && opened.addPasskey,
  });
  const reread = () => ask && void read.current(ask, null);
  const status = !view.status
    ? ""
    : "word" in view.status
      ? t(view.status.word)
      : view.status.note;

  return (
    <Modal
      isOpen={ask !== null && (!ask.upFront || shown)}
      onClose={decline}
      isDismissable={phase.kind !== "signing"}
      size="md"
      data-presence-dialog=""
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-2 text-[15px] font-semibold">
          <Fingerprint aria-hidden className="h-4 w-4 text-primary" />
          {progress && progress.total > 1
            ? t("title.progress", {
                index: progress.index,
                total: progress.total,
              })
            : t("title")}
        </ModalHeader>
        <ModalBody className="gap-3 text-[13px] text-foreground/85">
          {doing ? (
            <p>{t("act", { doing })}</p>
          ) : challenge ? (
            <ApprovingWhat
              proposalId={challenge.proposalId}
              label={ask?.subject.label}
            />
          ) : (
            <p>{t("action.unnamed")}</p>
          )}
          <div className="flex flex-col items-start gap-1">
            <button
              type="button"
              aria-expanded={whyOpen}
              aria-controls="presence-dialog-why"
              onClick={() => toggle("why", !whyOpen)}
              className="inline-flex min-h-8 items-center text-[12.5px] font-medium text-primary underline-offset-2 hover:underline"
            >
              {t("whyToggle")}
            </button>
            {whyOpen && (
              <p id="presence-dialog-why" className="text-foreground/65">
                {t(doing ? "why.act" : "why")}
              </p>
            )}
          </div>
          {view.notice && (
            <div className="flex flex-col gap-1 rounded-lg bg-warning/[0.06] px-3 py-2 ring-1 ring-inset ring-warning/25">
              {view.notice === "noPasskey" && (
                <p className="font-medium">
                  {t(doing ? "noPasskey.title.act" : "noPasskey.title")}
                </p>
              )}
              <p>
                {view.notice === "noPasskey"
                  ? t("noPasskey.body")
                  : t("unsupported.body")}
              </p>
            </div>
          )}
          {/* ONE status line, always mounted, so a screen reader hears each
              change of what the dialog is doing. */}
          <p role="status" aria-live="polite" className={TONE[view.tone]}>
            {status}
          </p>
          {view.detail && (
            <p className="-mt-2 text-[12px] text-foreground/45">
              {view.detail}
            </p>
          )}
          {view.relayDevice !== null && (
            <p className="text-foreground/55">
              {view.relayDevice
                ? t("relay.device", { device: view.relayDevice })
                : t("relay.any")}
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="light"
            onPress={decline}
            isDisabled={phase.kind === "signing"}
          >
            {t(view.decline)}
          </Button>
          {view.secondary === "tryAgain" && (
            <Button variant="flat" onPress={reread}>
              {t("tryAgain")}
            </Button>
          )}
          {view.secondary === "addPasskey" && (
            <Button
              as="a"
              href={PASSKEYS_PATH}
              target="_blank"
              rel="noopener"
              variant="flat"
            >
              {t("addPasskey")}
            </Button>
          )}
          {view.primary === "tryAgain" && (
            <Button color="primary" autoFocus onPress={reread}>
              {t("tryAgain")}
            </Button>
          )}
          {view.primary === "addPasskey" && (
            <Button
              as="a"
              href={PASSKEYS_PATH}
              target="_blank"
              rel="noopener"
              color="primary"
              autoFocus
              onPress={() => toggle("addPasskey", true)}
            >
              {t("addPasskey")}
            </Button>
          )}
          {view.primary === "confirm" && (
            <Button
              color="primary"
              autoFocus
              isLoading={view.busy}
              isDisabled={!challenge}
              onPress={() => challenge && void signWith(challenge)}
            >
              {t("confirm")}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

const TONE = {
  muted: "text-foreground/55",
  warning: "text-warning-600",
  danger: "text-danger",
} as const;

/** "To approve “<heading>”…": the request's heading, as its own page names it. */
function ApprovingWhat({
  proposalId,
  label,
}: {
  proposalId: string;
  /** The page's heading for a request no proposal names. */
  label?: string;
}) {
  const t = presenceT();
  if (label) return <p>{t("action", { action: label })}</p>;
  return <ProposalHeading proposalId={proposalId} />;
}

function ProposalHeading({ proposalId }: { proposalId: string }) {
  const t = presenceT();
  const query = trpc.proposals.get.useQuery(
    { proposalId },
    { enabled: isUuid(proposalId), retry: false }
  );
  const p = query.data;
  if (!p) return <p>{t("action.unnamed")}</p>;
  const payload =
    (p as { request?: { data?: unknown } | null }).request?.data ?? p.data;
  const { heading } = proposalHeading(p, payload);
  return <p>{t("action", { action: heading })}</p>;
}
