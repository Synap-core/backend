"use client";

/**
 * An agent's question, answered in Review's detail column — one control per
 * ask mode, through the pod's own slot doors:
 *
 *   confirm / choose / form / no ask → `focusSessions.answerOutput`
 *   act                              → `attestOutput` ("I did this") ·
 *                                      `unblockOutput` ("Not mine")
 *   provide                          → nothing here can hand a secret, file
 *                                      or connection over yet: the shared
 *                                      copy, "Open in app" and "Ask the agent
 *                                      about it"
 *   every mode                       → `askAboutSlot`, then the session room
 *
 * The shapes and checks are `ask-detail.ts` (pure, tested); the rules and the
 * words are `@synap-core/types/ask`, the same the desktop and phone apps use.
 * Every call carries the fingerprint of the ask the reader SAW: when the
 * agent re-asks underneath, the pod refuses it as stale, and so does this
 * detail — it says the question changed and offers the current one, keeping
 * nothing the reader did not see.
 *
 * The doors refuse an agent key and anyone but the session's owner; such a
 * refusal is shown as the pod words it.
 */

import { useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  Chip,
  Input,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
  Switch,
  Textarea,
  addToast,
} from "@heroui/react";
import { ArrowUpRight, Check, MessageSquare, X } from "lucide-react";
import { ASK_COPY, classifyAskRefusal } from "@synap-core/types/ask";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { formatRelative } from "../../../../lib/format";
import { openIn } from "../../../../lib/open-in";
import {
  ExitFallback,
  ExitLink,
  externalProps,
  rowHref,
  usePlacedExit,
} from "../../../../lib/exit-link";
import { kindIcon } from "../../../_lib/object/kind-icon";
import {
  OTHER_KEY,
  answerCall,
  askStaleness,
  askView,
  askerOf,
  formFieldErrors,
  initialFormDraft,
  slotCall,
  type AnswerCall,
  type AskControlView,
  type AskDraft,
  type AskSlot,
  type FormDraft,
  type FormFieldView,
  type LookedAtItem,
} from "./ask-detail";

/** A door's error, as tRPC hands it over. */
type DoorError = { message: string; data?: { code?: string | null } | null };

export interface AskAnswerProps {
  /** The question as it read when the reader opened it. */
  slot: AskSlot;
  /** The question as the pod holds it now (null = no longer owed). */
  live: AskSlot | null;
  occurredAt: string | null;
  /** Answered, done or handed back: the page closes this and moves on. */
  onSettled: () => void;
  onClose: () => void;
}

export function AskAnswer({
  slot,
  live,
  occurredAt,
  onSettled,
  onClose,
}: AskAnswerProps) {
  // What the reader sees stays put until they choose to see the new question:
  // a poll must never swap the options under a half-made answer.
  const [seen, setSeen] = useState(slot);
  const staleness = askStaleness(seen, live);
  const view = askView(seen);
  const [failure, setFailure] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  const utils = trpc.useUtils();
  const session = trpc.focusSessions.get.useQuery(
    { id: seen.sessionId },
    { staleTime: 60_000, retry: false }
  );
  const who = askerOf(session.data?.participants);

  /** Every read an answer changes: the rows, the badges, Sessions, Home. */
  function refresh() {
    void utils.signals.invalidate();
    void utils.focusSessions.owed.invalidate();
    void utils.focusSessions.get.invalidate({ id: seen.sessionId });
    void utils.focusSessions.browse.invalidate();
    void utils.diagnose.global.invalidate();
  }

  function settled(title: string) {
    addToast({ title, color: "success" });
    refresh();
    onSettled();
  }

  function refused(err: DoorError) {
    if (redirectToLoginIfUnauthorized(err)) return;
    const refusal = classifyAskRefusal(err.message);
    if (refusal.kind === "failed") {
      setFailure(refusal.message);
      return;
    }
    // Stale is not a failure: re-read, and say so calmly. A changed question
    // shows the banner below once the fresh read lands.
    addToast({
      title:
        refusal.kind === "ask_changed" ? ASK_COPY.askChanged : ASK_COPY.movedOn,
      color: "default",
    });
    refresh();
    if (refusal.kind === "moved_on") onClose();
  }

  const answer = trpc.focusSessions.answerOutput.useMutation({
    onSuccess: () => settled("Answer sent"),
    onError: refused,
  });
  const attest = trpc.focusSessions.attestOutput.useMutation({
    onSuccess: () => settled("Marked as done"),
    onError: refused,
  });
  const handBack = trpc.focusSessions.unblockOutput.useMutation({
    onSuccess: () => settled("Handed back to the agent"),
    onError: refused,
  });
  const askAbout = trpc.focusSessions.askAboutSlot.useMutation({
    onSuccess: () => {
      setAsked(true);
      void utils.focusSessions.get.invalidate({ id: seen.sessionId });
    },
    onError: refused,
  });
  const busy =
    answer.isPending ||
    attest.isPending ||
    handBack.isPending ||
    askAbout.isPending;

  function send(call: AnswerCall) {
    setFailure(null);
    answer.mutate(call);
  }

  const sessionExit = openIn({
    kind: "object",
    objectKind: "session",
    id: seen.sessionId,
  });
  const roomExit = openIn({
    kind: "object",
    objectKind: "session",
    id: seen.sessionId,
    view: "room",
  });
  // A chip whose object only opens in the desktop app: the install hatch,
  // once, under the chips — not once per chip.
  const lookedAtDesktop = view.lookedAt
    .map((item) =>
      openIn({ kind: "object", objectKind: item.kind, id: item.id })
    )
    .find((exit) => exit.isDesktopLink);

  return (
    <div className="flex flex-col gap-5 pb-4">
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-2 text-[12px] text-foreground/65">
          <Chip
            size="sm"
            variant="flat"
            radius="sm"
            startContent={<MessageSquare className="h-3 w-3" aria-hidden />}
          >
            Ask
          </Chip>
          <span>
            Question
            {occurredAt ? ` · asked ${formatRelative(occurredAt)}` : ""}
          </span>
        </p>
        <h3 className="font-heading text-[17px] font-medium leading-snug text-foreground">
          {view.heading}
        </h3>
        {view.why && (
          <p className="text-[13px] leading-relaxed text-foreground/75">
            {view.why}
          </p>
        )}
        {view.claimedDone && (
          <p className="text-[12.5px] text-foreground/65">
            The agent says it did this after all. Check before you answer.
          </p>
        )}
      </div>

      <Section label="Who is asking">
        <p className="text-[13px] leading-relaxed text-foreground/85">
          <strong className="font-medium text-foreground">
            {who ?? "An agent"}
          </strong>
          , while working in the session{" "}
          <span className="text-foreground">
            {seen.sessionTitle ?? "this session"}
          </span>
          . It is waiting on your answer.
        </p>
        <ExitLink exit={sessionExit} label="Open session" />
      </Section>

      {view.lookedAt.length > 0 && (
        <Section label={ASK_COPY.lookedAt}>
          <div className="flex flex-wrap gap-1.5">
            {view.lookedAt.map((item) => (
              <LookedAtChip key={`${item.kind}:${item.id}`} item={item} />
            ))}
          </div>
          {lookedAtDesktop && (
            <ExitFallback exit={lookedAtDesktop} showWeb={false} />
          )}
        </Section>
      )}

      {staleness === "changed" && live && (
        <Alert
          color="warning"
          variant="flat"
          title={ASK_COPY.askChanged}
          endContent={
            <Button
              size="sm"
              variant="flat"
              onPress={() => {
                setSeen(live);
                setFailure(null);
              }}
            >
              Show the current question
            </Button>
          }
        />
      )}

      {staleness === "gone" ? (
        <Alert color="default" variant="flat" title={ASK_COPY.movedOn}>
          It was answered, handed back, or the session ended.
        </Alert>
      ) : (
        <>
          {failure && (
            <Alert
              color="danger"
              variant="flat"
              title={ASK_COPY.failedTitle}
              onClose={() => setFailure(null)}
            >
              {failure}
            </Alert>
          )}
          <Controls
            // A new question is a new form: nothing typed against the old
            // one carries over.
            key={`${seen.sessionId}:${seen.label}:${JSON.stringify(seen.ask)}`}
            slot={seen}
            control={view.control}
            busy={busy || staleness === "changed"}
            pending={answer.isPending}
            onAnswer={(draft) => {
              const built = answerCall(seen, draft);
              if (!built.ok) {
                setFailure(built.message);
                return built.fieldErrors ?? null;
              }
              send(built.call);
              return null;
            }}
            onAttest={() => {
              setFailure(null);
              attest.mutate(slotCall(seen));
            }}
            attesting={attest.isPending}
            onHandBack={() => {
              setFailure(null);
              handBack.mutate({
                sessionId: seen.sessionId,
                expectedLabel: seen.label,
              });
            }}
            handingBack={handBack.isPending}
          />
        </>
      )}

      <div className="flex flex-col gap-2 border-t border-foreground/[0.06] pt-4">
        {asked ? (
          <>
            <p className="text-[12.5px] text-foreground/75">
              Your question is in the session room. The agent answers there.
            </p>
            <ExitLink exit={roomExit} label="Open the conversation" />
          </>
        ) : (
          <div>
            <Button
              size="sm"
              variant={view.control.mode === "provide" ? "solid" : "flat"}
              color={view.control.mode === "provide" ? "primary" : "default"}
              startContent={<MessageSquare className="h-3.5 w-3.5" />}
              isLoading={askAbout.isPending}
              isDisabled={busy || staleness === "gone"}
              onPress={() => {
                setFailure(null);
                askAbout.mutate(slotCall(seen));
              }}
            >
              Ask the agent about it
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65">
        {label}
      </div>
      {children}
    </div>
  );
}

/** One thing the agent read, as a door — plain text where nothing opens it. */
function LookedAtChip({ item }: { item: LookedAtItem }) {
  const placed = usePlacedExit(
    openIn({ kind: "object", objectKind: item.kind, id: item.id })
  );
  const href = rowHref(placed);
  const Icon = kindIcon(item.kind);
  const body = (
    <>
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{item.label}</span>
    </>
  );
  const cls =
    "inline-flex max-w-full items-center gap-1.5 rounded-md bg-foreground/[0.04] px-2 py-1 text-[12.5px] text-foreground/85 ring-1 ring-inset ring-foreground/10";
  return href ? (
    <a
      href={href}
      {...externalProps(href)}
      className={`${cls} transition-colors hover:bg-foreground/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}
    >
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}

// ─── The controls, one per mode ─────────────────────────────────────────────

interface ControlsProps {
  slot: AskSlot;
  control: AskControlView;
  busy: boolean;
  /** The answer call is in flight. */
  pending: boolean;
  /** Returns field errors to show, or null when the answer went out. */
  onAnswer: (draft: AskDraft) => Record<string, string> | null;
  onAttest: () => void;
  attesting: boolean;
  onHandBack: () => void;
  handingBack: boolean;
}

function Controls(props: ControlsProps) {
  const { control } = props;
  switch (control.mode) {
    case "confirm":
      return <ConfirmControl prompt={control.prompt} {...props} />;
    case "choose":
      return <ChooseControl {...props} control={control} />;
    case "form":
      return <FormControl {...props} control={control} />;
    case "act":
      return (
        <div className="flex flex-col gap-3">
          <Section label="What to do">
            {control.url && (
              <a
                href={control.url}
                {...externalProps(control.url)}
                className="inline-flex items-start gap-1.5 break-all rounded-sm font-mono text-[12px] text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {control.url}
                <ArrowUpRight
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  strokeWidth={1.75}
                  aria-hidden
                />
              </a>
            )}
            {control.steps.length > 0 && (
              <ol className="ml-5 list-decimal space-y-1 text-[13px] leading-relaxed text-foreground/85">
                {control.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            )}
          </Section>
          <DidThisPair {...props} />
        </div>
      );
    case "provide":
      // Nothing here can hand a secret, file or connection over: the app can.
      return (
        <div className="flex flex-col gap-2">
          <Alert color="default" variant="flat" title={control.title}>
            <span className="flex flex-col gap-1">
              <span>{control.wants}.</span>
              <span>{control.body}</span>
            </span>
          </Alert>
          <ExitLink
            exit={openIn({
              kind: "objectInApp",
              objectKind: "session",
              id: props.slot.sessionId,
            })}
            label="Open in app"
          />
        </div>
      );
    case "legacy":
      return <LegacyControl {...props} />;
  }
}

/** "I did this" · "Not mine" — an equal pair; neither is the default. */
function DidThisPair({
  busy,
  onAttest,
  attesting,
  onHandBack,
  handingBack,
}: ControlsProps) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button
        variant="bordered"
        className="min-h-10"
        startContent={<Check className="h-4 w-4" />}
        isLoading={attesting}
        isDisabled={busy}
        onPress={onAttest}
      >
        {ASK_COPY.didThis}
      </Button>
      <Button
        variant="bordered"
        className="min-h-10"
        startContent={<X className="h-4 w-4" />}
        isLoading={handingBack}
        isDisabled={busy}
        onPress={onHandBack}
      >
        {ASK_COPY.notMine}
      </Button>
    </div>
  );
}

function ConfirmControl({
  prompt,
  busy,
  pending,
  onAnswer,
  slot,
}: ControlsProps & { prompt: string | null }) {
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<boolean | null>(null);
  const press = (confirmed: boolean) => {
    setPicked(confirmed);
    onAnswer({ type: "confirm", confirmed, note });
  };
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65">
        Your answer
      </legend>
      {prompt && prompt !== slot.label && (
        <p className="text-[13px] text-foreground/85">{prompt}</p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="bordered"
          className="min-h-10"
          isLoading={pending && picked === true}
          isDisabled={busy}
          onPress={() => press(true)}
        >
          {ASK_COPY.yes}
        </Button>
        <Button
          variant="bordered"
          className="min-h-10"
          isLoading={pending && picked === false}
          isDisabled={busy}
          onPress={() => press(false)}
        >
          {ASK_COPY.no}
        </Button>
      </div>
      <Input
        size="sm"
        label="Note for the agent (optional)"
        placeholder={ASK_COPY.notePlaceholder}
        value={note}
        onValueChange={setNote}
        isDisabled={busy}
      />
    </fieldset>
  );
}

function ChooseControl({
  control,
  busy,
  pending,
  onAnswer,
}: ControlsProps & {
  control: Extract<AskControlView, { mode: "choose" }>;
}) {
  const [key, setKey] = useState<string>(control.initialKey ?? "");
  const [other, setOther] = useState("");
  const isOther = key === OTHER_KEY;
  const ready = key !== "" && (!isOther || other.trim().length > 0);
  return (
    <div className="flex flex-col gap-3">
      <RadioGroup
        label="Your answer · choose one"
        value={key}
        onValueChange={setKey}
        isDisabled={busy}
        classNames={{
          label:
            "text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65",
          wrapper: "gap-2",
        }}
      >
        {control.options.map((o) => (
          <Radio
            key={o.key}
            value={o.key}
            description={o.description ?? undefined}
            classNames={RADIO_CARD}
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-foreground">{o.label}</span>
              {o.recommended && (
                <Chip size="sm" variant="flat" color="primary" radius="sm">
                  Recommended
                </Chip>
              )}
            </span>
          </Radio>
        ))}
        {control.allowOther && (
          <Radio value={OTHER_KEY} classNames={RADIO_CARD}>
            <span className="text-[13px] text-foreground">Other…</span>
          </Radio>
        )}
      </RadioGroup>
      {isOther && (
        <Input
          size="sm"
          label="Your own answer"
          value={other}
          onValueChange={setOther}
          isDisabled={busy}
          autoFocus
        />
      )}
      <div>
        <Button
          color="primary"
          className="min-h-10"
          startContent={<Check className="h-4 w-4" />}
          isLoading={pending}
          isDisabled={busy || !ready}
          onPress={() => onAnswer({ type: "choose", key, other })}
        >
          Send answer
        </Button>
      </div>
    </div>
  );
}

/** A radio drawn as a card: the whole box is the hit area. */
const RADIO_CARD = {
  base: "m-0 w-full max-w-full items-start rounded-lg px-3 py-2.5 ring-1 ring-inset ring-foreground/10 data-[selected=true]:bg-primary/[0.06] data-[selected=true]:ring-primary/50",
  labelWrapper: "ml-2 min-w-0",
  description: "text-[12px] text-foreground/65",
};

function FormControl({
  control,
  busy,
  pending,
  onAnswer,
}: ControlsProps & { control: Extract<AskControlView, { mode: "form" }> }) {
  const [draft, setDraft] = useState<FormDraft>(() =>
    initialFormDraft(control.fields)
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(false);
  // Once a send was tried, the hints follow the typing.
  useEffect(() => {
    if (tried) setErrors(formFieldErrors(control.fields, draft));
  }, [tried, draft, control.fields]);
  const set = (key: string, value: string | boolean) =>
    setDraft((prev) => ({ ...prev, [key]: value }));
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        setErrors(onAnswer({ type: "form", draft }) ?? {});
      }}
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65">
        {control.title ?? "Your answer"}
      </div>
      {control.note && (
        <p className="text-[12.5px] text-foreground/75">{control.note}</p>
      )}
      {control.fields.map((f) => (
        <FieldInput
          key={f.key}
          field={f}
          value={draft[f.key]}
          error={errors[f.key]}
          disabled={busy}
          onChange={(v) => set(f.key, v)}
        />
      ))}
      <div>
        <Button
          type="submit"
          color="primary"
          className="min-h-10"
          isLoading={pending}
          isDisabled={busy}
        >
          Send answer
        </Button>
      </div>
    </form>
  );
}

function FieldInput({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: FormFieldView;
  value: string | boolean | undefined;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string | boolean) => void;
}) {
  const common = {
    label: field.label,
    description: field.help ?? undefined,
    isRequired: field.required,
    isInvalid: error !== undefined,
    errorMessage: error,
    isDisabled: disabled,
    size: "sm" as const,
  };
  switch (field.control) {
    case "switch":
      return (
        <Switch
          size="sm"
          isSelected={value === true}
          onValueChange={onChange}
          isDisabled={disabled}
        >
          <span className="text-[13px]">{field.label}</span>
        </Switch>
      );
    case "select":
      return (
        <Select
          {...common}
          selectedKeys={typeof value === "string" && value ? [value] : []}
          onSelectionChange={(keys) => {
            const v = Array.from(keys as Set<string>)[0];
            onChange(v ?? "");
          }}
        >
          {field.options.map((o) => (
            <SelectItem key={o}>{o}</SelectItem>
          ))}
        </Select>
      );
    case "textarea":
      return (
        <Textarea
          {...common}
          minRows={2}
          value={typeof value === "string" ? value : ""}
          onValueChange={onChange}
        />
      );
    case "number":
      return (
        <Input
          {...common}
          type="number"
          inputMode="decimal"
          min={field.min ?? undefined}
          max={field.max ?? undefined}
          value={typeof value === "string" ? value : ""}
          onValueChange={onChange}
        />
      );
    case "text":
      return (
        <Input
          {...common}
          type={field.inputType}
          value={typeof value === "string" ? value : ""}
          onValueChange={onChange}
        />
      );
  }
}

/** No typed ask: the answer in words, or "I did this" / "Not mine". */
function LegacyControl(props: ControlsProps) {
  const { busy, pending, onAnswer } = props;
  const [text, setText] = useState("");
  return (
    <div className="flex flex-col gap-3">
      <Textarea
        label="Your answer"
        placeholder="Write your answer for the agent"
        minRows={2}
        value={text}
        onValueChange={setText}
        isDisabled={busy}
      />
      <div>
        <Button
          color="primary"
          className="min-h-10"
          isLoading={pending}
          isDisabled={busy || text.trim().length === 0}
          onPress={() => onAnswer({ type: "text", text })}
        >
          Send answer
        </Button>
      </div>
      <p className="text-[12px] text-foreground/65">
        Or, if there is nothing to say:
      </p>
      <DidThisPair {...props} />
    </div>
  );
}
