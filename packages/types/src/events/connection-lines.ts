/**
 * CONNECTION EVENT LINES — the ONE rule that turns a connection's lifecycle
 * event into a human line.
 *
 * `parseRecordChange` reads the CRUD half of the events log ("Created person").
 * Everything a connection does that is NOT a record change — a key revoked or
 * replaced, an app asking for access, a sync, a sign-in that expired, a
 * messaging account connected, a message arriving, a webhook delivery, a
 * session or track moving — is read HERE, so no surface hand-writes those
 * words. Every word goes through the vocabulary (`resolveActionLabel` past
 * mood, `resolveObjectNoun`, `resolveConnectionStateLabel`) and the service
 * names through `resolveServiceName`; this module only arranges them.
 *
 * Input is the event's `type` (`${subjectType}.${action}.completed`, or the
 * two-segment connector form) and, when the reader has it, its `data`. Every
 * line reads without `data` too (a surface that only holds the type still
 * gets words); `data` adds the name and the detail.
 *
 * Null = not a connection lifecycle event (a record change, an unknown
 * family, a governance phase, or an in-flight sync tick that is not a fact).
 */

import {
  resolveActionLabel,
  resolveActionProgressive,
  resolveConnectionStateLabel,
  resolveObjectNoun,
  resolveStatusLabel,
  sentenceCaseLabel,
} from "../vocabulary/index.js";
import { resolveServiceName } from "../service-marks/index.js";

/** One lifecycle event, as a line. */
export interface ConnectionEventLine {
  /** Vocabulary action token (`revoke`, `sync`, `receive`, …). */
  action: string;
  /** Vocabulary object kind (`apiKey`, `app`, `messaging_account`, …). */
  objectKind: string;
  /**
   * The thing's own name when the event carries one — a key's name, the
   * service ("WhatsApp"), the sender, the stage. Already words.
   */
  name: string | null;
  /** A short trailing fact ("42 new"), or a message preview. Already words. */
  detail: string | null;
  /** The act failed (a failed sync or delivery, an expired sign-in). */
  failed: boolean;
  /** The whole line, composed: "Synced Gmail · 42 new". */
  text: string;
}

type EventData = Readonly<Record<string, unknown>> | null | undefined;

/** The phases a lifecycle event is read at. Governance phases are not facts. */
const READ_PHASES = new Set(["completed"]);

function str(data: EventData, ...keys: string[]): string | null {
  if (!data) return null;
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const past = (action: string): string => resolveActionLabel(action, "past");

/**
 * A noun inside a line: lower-cased when it is a plain word ("session"),
 * kept when it carries deliberate casing ("API key", "MCP server").
 */
function nounInLine(kind: string): string {
  const noun = resolveObjectNoun(kind);
  return /^[A-Z][a-z]/.test(noun)
    ? noun.charAt(0).toLowerCase() + noun.slice(1)
    : noun;
}

function quoted(name: string): string {
  return `"${name}"`;
}

/** The service a provider token names ("whatsapp" → "WhatsApp"), or null. */
function serviceOf(data: EventData): string | null {
  const provider = str(data, "provider", "providerName", "connectorName");
  return provider ? resolveServiceName(provider) : null;
}

/** Where a webhook went: its own name, else the destination host's brand. */
function destinationOf(data: EventData): string | null {
  const named = str(data, "subscriptionName", "name");
  if (named) return named;
  const url = str(data, "url", "targetUrl");
  if (!url) return null;
  try {
    const labels = new URL(url).hostname.split(".").filter(Boolean);
    const brand = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    return brand ? resolveServiceName(brand) : null;
  } catch {
    return null;
  }
}

function line(
  action: string,
  objectKind: string,
  text: string,
  opts: { name?: string | null; detail?: string | null; failed?: boolean } = {}
): ConnectionEventLine {
  const detail = opts.detail ?? null;
  return {
    action,
    objectKind,
    name: opts.name ?? null,
    detail,
    failed: opts.failed ?? false,
    text,
  };
}

/** `<Verb> <noun> "<name>"` — the record-change sentence, noun in line case. */
function verbNoun(action: string, kind: string, name: string | null): string {
  const head = `${past(action)} ${nounInLine(kind)}`;
  return name ? `${head} ${quoted(name)}` : head;
}

function withDetail(text: string, detail: string | null): string {
  return detail ? `${text} · ${detail}` : text;
}

function failedTo(action: string, target: string): string {
  // "Failed to sync Gmail" — the imperative is the bare verb.
  const verb = resolveActionLabel(action, "imperative").toLowerCase();
  return `${resolveStatusLabel("failed")} to ${verb} ${target}`;
}

/** "Synced Gmail · 42 new" — `counts.created` when the run found any. */
function syncedLine(
  service: string | null,
  created: number | null,
  extra: string | null = null
): ConnectionEventLine {
  const target = service ?? nounInLine("connection");
  const detail =
    extra ?? (created && created > 0 ? `${created} new` : null);
  return line("sync", "connection", withDetail(`${past("sync")} ${target}`, detail), {
    name: service,
    detail,
  });
}

function syncFailedLine(service: string | null): ConnectionEventLine {
  return line("sync", "connection", failedTo("sync", service ?? nounInLine("connection")), {
    name: service,
    failed: true,
  });
}

function signInExpiredLine(kind: string, service: string | null): ConnectionEventLine {
  const words = resolveConnectionStateLabel("needs_signin", "account");
  return line("expire", kind, withDetail(words, service), {
    name: service,
    failed: true,
  });
}

function appLine(action: string, data: EventData): ConnectionEventLine | null {
  const name = str(data, "name");
  switch (action) {
    case "request":
      return line("request_access", "app", past("request_access"), { name });
    case "approve":
      // An app's request is approved by its owner, and only its owner reads
      // the app's timeline — the approver is "you" by construction.
      return line("approve", "app", `${past("approve")} by you`, { name });
    case "issue_key":
      return line("issue_key", "app", past("issue_key"), { name });
    case "revoke":
      return line("revoke", "app", resolveConnectionStateLabel("revoked"), { name });
    case "rename": {
      const to = str(data, "to");
      return line(
        "rename",
        "app",
        to ? `${past("rename")} to ${quoted(to)}` : verbNoun("rename", "app", null),
        { name: to ?? name }
      );
    }
    case "remove_for_good":
      return line("remove_for_good", "app", past("remove_for_good"), { name });
    default:
      return null;
  }
}

function messagingAccountLine(
  action: string,
  data: EventData
): ConnectionEventLine | null {
  const service = serviceOf(data);
  const target = service ?? nounInLine("messaging_account");
  const status = action === "updated" ? str(data, "status") : action;
  switch (status) {
    case "created":
    case "connected":
      return line(
        action === "created" ? "connect" : "reconnect",
        "messaging_account",
        `${past(action === "created" ? "connect" : "reconnect")} ${target}`,
        { name: service }
      );
    case "disconnected":
      return line("disconnect", "messaging_account", `${past("disconnect")} ${target}`, {
        name: service,
      });
    case "reconnection_required":
      return signInExpiredLine("messaging_account", service);
    default:
      return action === "updated"
        ? line("update", "messaging_account", `${past("update")} ${target}`, { name: service })
        : null;
  }
}

function sessionOrTrackLine(
  kind: "focus_session" | "track",
  action: string,
  data: EventData
): ConnectionEventLine | null {
  switch (action) {
    case "stage_changed": {
      const to = str(data, "toStage", "toStageLabel");
      const stage = to ? sentenceCaseLabel(to) : null;
      const text = stage
        ? `${past("move")} ${nounInLine(kind)} to ${quoted(stage)}`
        : `${past("move")} ${nounInLine(kind)}`;
      return line("move", kind, text, { name: stage });
    }
    case "closed":
      return line("close", kind, verbNoun("close", kind, null));
    default:
      break;
  }
  if (kind !== "focus_session") return null;
  const label = str(data, "label", "slotLabel", "title");
  switch (action) {
    case "slot_asked":
      return line("ask", "question", verbNoun("ask", "question", label), { name: label });
    case "slot_answered":
      return line("answer", "question", verbNoun("answer", "question", label), {
        name: label,
      });
    case "slot_attested": {
      const text = label ? `${past("attest")} ${quoted(label)}` : past("attest");
      return line("attest", "output", text, { name: label });
    }
    default:
      return null;
  }
}

/**
 * Read one event as a connection lifecycle line, or null.
 *
 * Families (the action is the segment between subject and phase):
 *   apiKey.{revoke,rotate}                     "Revoked API key "Vercel production""
 *   app.{request,approve,issue_key,revoke,rename,remove_for_good}
 *   messaging_account.{created,disconnected,reconnection_required,updated}
 *   external_channel.created                   "Created channel on Telegram"
 *   external_message.received                  "Message from Ada on Telegram"
 *   channel_message.created                    "Posted message"
 *   connector_sync.complete                    "Synced Gmail · 42 new" / "Failed to sync Gmail"
 *   connection_sync.progress                   terminal phases only (synced / review_ready / failed)
 *   connector.auth_expire                      "Sign-in expired · Gmail"
 *   webhooks.deliver                           "Sent to Zapier" / "Failed to send to Zapier"
 *   focus_session.{stage_changed,slot_asked,slot_answered,slot_attested,closed}
 *   track.{stage_changed,closed}
 */
export function parseConnectionEvent(
  type: string,
  data?: EventData
): ConnectionEventLine | null {
  const parts = type.split(".");
  if (parts.length < 2 || parts.length > 3) return null;
  const subject = parts[0]!;
  const action = parts[1]!;
  const phase = parts[2];
  if (!subject || !action) return null;
  // `webhooks.deliver.requested` is the delivery's own record (the worker has
  // no completion event); every other family is read at `completed` or as the
  // bare two-segment connector form.
  const isWebhook = subject === "webhooks" || subject === "webhook";
  if (phase !== undefined && !READ_PHASES.has(phase) && !(isWebhook && phase === "requested")) {
    return null;
  }

  switch (subject) {
    case "apiKey":
    case "api_key":
    case "apikey":
      if (action !== "revoke" && action !== "rotate") return null;
      return line(action, "apiKey", verbNoun(action, "apiKey", str(data, "keyName", "name")), {
        name: str(data, "keyName", "name"),
      });

    case "app":
      return appLine(action, data);

    case "messaging_account":
      return messagingAccountLine(action, data);

    case "external_channel": {
      if (action !== "created" && action !== "create") return null;
      const service = serviceOf(data);
      const text = verbNoun("create", "channel", str(data, "name", "channelName"));
      return line("create", "channel", service ? `${text} on ${service}` : text, {
        name: service,
      });
    }

    case "external_message": {
      if (action !== "received") return null;
      const from = str(data, "participantName", "senderName", "from");
      const service = serviceOf(data);
      const preview = str(data, "messagePreview");
      const noun = resolveObjectNoun("message");
      const text =
        from || service
          ? `${noun}${from ? ` from ${from}` : ""}${service ? ` on ${service}` : ""}`
          : verbNoun("received", "message", null);
      return line("receive", "message", text, { name: from, detail: preview });
    }

    case "channel_message":
      if (action !== "created" && action !== "create") return null;
      return line("post", "message", verbNoun("post", "message", null));

    case "connector_sync": {
      if (action !== "complete") return null;
      const service = serviceOf(data);
      if (str(data, "syncStatus") === "error") return syncFailedLine(service);
      const counts = data?.["counts"] as Record<string, unknown> | undefined;
      return syncedLine(service, num(counts?.["created"]));
    }

    case "connection_sync": {
      if (action !== "progress") return null;
      const service = serviceOf(data);
      const counts = data?.["counts"] as Record<string, unknown> | undefined;
      switch (str(data, "phase")) {
        case "synced":
          return syncedLine(service, num(counts?.["created"]));
        case "review_ready":
          return syncedLine(service, null, resolveStatusLabel("review_ready"));
        case "failed":
          return syncFailedLine(service);
        default:
          // fetching / mapping / not_connected / unknown: a tick in flight is
          // not a fact; the run's own `connector_sync.complete` line is.
          return null;
      }
    }

    case "connector":
      if (action !== "auth_expire") return null;
      return signInExpiredLine("connection", serviceOf(data));

    case "webhooks":
    case "webhook": {
      if (action !== "deliver") return null;
      const dest = destinationOf(data);
      const target = dest ? `to ${dest}` : nounInLine("webhook");
      const status = str(data, "status");
      if (status === "failed") {
        return line("send", "webhook", failedTo("send", target), { name: dest, failed: true });
      }
      const verb =
        status === "success" ? past("send") : resolveActionProgressive("send");
      return line("send", "webhook", `${verb} ${target}`, { name: dest });
    }

    case "focus_session":
    case "track":
      return sessionOrTrackLine(subject, action, data);

    default:
      return null;
  }
}
