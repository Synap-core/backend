"use client";

/**
 * The proof-of-presence dialog (W3), mounted ONCE in `app/providers.tsx`.
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
 * page through `proposalHeading` and the vocabulary door) and why the browser
 * asks for Touch ID or a security key. With no passkey on this pod, or a
 * browser that cannot use one, it says so: add one under Security, or
 * approve in Relay with Face ID.
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
import type {
  PresenceProof,
  PresenceRefusalCode,
} from "@synap-core/types/presence";
import { trpc } from "../../../lib/trpc";
import { isUuid } from "../../../lib/format";
import {
  PasskeyCancelled,
  getPasskeyAssertion,
  isPasskeyAssertionSupported,
  type PresencePasskeyRequest,
} from "../../../lib/passkey";
import { proposalHeading } from "../../proposal/[id]/proposal-heading";
import { presenceT } from "./copy";
import {
  PresenceDeclined,
  type PresenceProgress,
  type PresenceSubject,
  type ProvePresence,
} from "./presence-model";

/** `presence.challenge`'s answer, as far as the dialog reads it. */
interface PresenceChallenge {
  challengeId: string;
  /** The proposal it names (a pending key's `agent/connect`). */
  proposalId: string;
  expiresAt: string;
  passkey: PresencePasskeyRequest | null;
  deviceKeys: Array<{ id: string; label: string }>;
}

/** A challenge this close to its end is read again before the prompt. */
const CHALLENGE_MARGIN_MS = 15_000;

interface Ask {
  subject: PresenceSubject;
  refusal: PresenceRefusalCode;
  progress?: PresenceProgress;
  resolve: (proof: PresenceProof) => void;
  reject: (err: Error) => void;
}

type Phase =
  | { kind: "reading" }
  | { kind: "read-failed"; message: string }
  | { kind: "ready"; challenge: PresenceChallenge; note: string | null }
  | { kind: "signing"; challenge: PresenceChallenge };

interface PresenceContextValue {
  prove: ProvePresence;
}

const PresenceContext = createContext<PresenceContextValue>({
  prove: () =>
    Promise.reject(
      new Error("Proof of presence is not available on this page.")
    ),
});

/** The person's proof of presence, asked through the one dialog. */
export function usePresence(): PresenceContextValue {
  return useContext(PresenceContext);
}

/** Why the pod asks again, in words; null for a first ask. */
function againNote(refusal: PresenceRefusalCode): string | null {
  const t = presenceT();
  switch (refusal) {
    case "PRESENCE_INVALID":
      return t("again.invalid");
    case "PRESENCE_EXPIRED":
      return t("again.expired");
    case "PRESENCE_USED":
      return t("again.used");
    default:
      return null;
  }
}

export function PresenceProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  // One ask at a time: a second waits for the first to settle.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const prove = useCallback<ProvePresence>((subject, refusal, progress) => {
    const next = queue.current.then(
      () =>
        new Promise<PresenceProof>((resolve, reject) =>
          setAsk({ subject, refusal, progress, resolve, reject })
        )
    );
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  const value = useMemo(() => ({ prove }), [prove]);
  // The open ask, read by `settle` (an effect-free updater would run twice
  // in StrictMode and settle the promise from inside a render).
  const open = useRef<Ask | null>(null);
  open.current = ask;
  const settle = useCallback(
    (outcome: { proof: PresenceProof } | { error: Error }) => {
      const current = open.current;
      if (!current) return;
      open.current = null;
      setAsk(null);
      if ("proof" in outcome) current.resolve(outcome.proof);
      else current.reject(outcome.error);
    },
    []
  );

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
  settle: (outcome: { proof: PresenceProof } | { error: Error }) => void;
}) {
  const t = presenceT();
  const challengeMutation = trpc.presence.challenge.useMutation();
  const readChallenge = challengeMutation.mutateAsync;
  // Each phase belongs to one ask: a new ask starts at "reading" from its
  // first render, never on the last ask's challenge.
  const [state, setState] = useState<{ ask: Ask | null; phase: Phase }>({
    ask: null,
    phase: { kind: "reading" },
  });
  const phase: Phase = state.ask === ask ? state.phase : { kind: "reading" };
  // The ask the latest read belongs to: a late answer of a closed ask is dropped.
  const live = useRef<Ask | null>(null);
  const setPhase = (forAsk: Ask, next: Phase) => {
    if (live.current === forAsk) setState({ ask: forAsk, phase: next });
  };

  // Read a challenge for this ask. A ref, not an effect dependency: the
  // dialog reads once per ask, never again because a render made a new
  // function.
  const read = useRef<(current: Ask, note: string | null) => Promise<void>>(
    async () => undefined
  );
  read.current = async (current: Ask, note: string | null) => {
    setPhase(current, { kind: "reading" });
    try {
      const challenge = (await readChallenge(
        current.subject
      )) as PresenceChallenge;
      setPhase(current, { kind: "ready", challenge, note });
    } catch (err) {
      setPhase(current, {
        kind: "read-failed",
        message:
          err instanceof Error && err.message
            ? err.message
            : presenceT()("readFailed"),
      });
    }
  };

  useEffect(() => {
    live.current = ask;
    if (ask) void read.current(ask, againNote(ask.refusal));
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

  const decline = () => settle({ error: new PresenceDeclined(t("declined")) });
  const challenge =
    phase.kind === "ready" || phase.kind === "signing" ? phase.challenge : null;
  const canSign = !!challenge?.passkey && isPasskeyAssertionSupported();
  const progress = ask?.progress;

  return (
    <Modal
      isOpen={ask !== null}
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
          {challenge ? (
            <ApprovingWhat proposalId={challenge.proposalId} />
          ) : (
            <p>{t("action.unnamed")}</p>
          )}
          <p className="text-foreground/65">{t("why")}</p>
          {phase.kind === "reading" && (
            <p className="text-foreground/55">{t("checking")}</p>
          )}
          {phase.kind === "read-failed" && (
            <p role="alert" className="text-danger">
              {phase.message}
            </p>
          )}
          {phase.kind === "ready" && phase.note && (
            <p role="status" className="text-warning-600">
              {phase.note}
            </p>
          )}
          {phase.kind === "signing" && (
            <p className="text-foreground/55">{t("waiting")}</p>
          )}
          {challenge && !canSign && <NoPasskey challenge={challenge} />}
          {challenge && canSign && <RelayInstead challenge={challenge} />}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="light"
            onPress={decline}
            isDisabled={phase.kind === "signing"}
          >
            {t("notNow")}
          </Button>
          {phase.kind === "read-failed" || (challenge && !canSign) ? (
            <Button
              color="primary"
              variant="flat"
              onPress={() => ask && void read.current(ask, null)}
            >
              {t("tryAgain")}
            </Button>
          ) : (
            <Button
              color="primary"
              isLoading={phase.kind === "signing" || phase.kind === "reading"}
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

/** "To approve “<heading>”…": the request's heading, as its own page names it. */
function ApprovingWhat({ proposalId }: { proposalId: string }) {
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

/** No passkey on this pod, or none this browser can use: the two other ways. */
function NoPasskey({ challenge }: { challenge: PresenceChallenge }) {
  const t = presenceT();
  const unsupported = !!challenge.passkey && !isPasskeyAssertionSupported();
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-warning/[0.06] px-3 py-2 ring-1 ring-inset ring-warning/25">
      {!unsupported && <p className="font-medium">{t("noPasskey.title")}</p>}
      <p>{unsupported ? t("unsupported.body") : t("noPasskey.body")}</p>
      {!unsupported && (
        <a
          href="/settings/security#passkeys"
          target="_blank"
          rel="noopener"
          className="self-start text-primary underline-offset-2 hover:underline"
        >
          {t("addPasskey")}
        </a>
      )}
      <RelayInstead challenge={challenge} />
    </div>
  );
}

/** Relay with Face ID: on a device the person enrolled, else "your phone". */
function RelayInstead({ challenge }: { challenge: PresenceChallenge }) {
  const t = presenceT();
  const device = challenge.deviceKeys[0]?.label?.trim();
  return (
    <p className="text-foreground/55">
      {device ? t("relay.device", { device }) : t("relay.any")}
    </p>
  );
}
