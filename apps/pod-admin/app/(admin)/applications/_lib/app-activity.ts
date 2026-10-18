/**
 * An app's Activity rows in words. A key app's lifecycle is recorded on the
 * app (`app.{request,approve,issue_key,revoke,rename,remove_for_good}`,
 * `services/app-connect`) and on its keys; a Claude/MCP client's on its
 * client id (each consent, and the admin revoke). Anything else falls back to
 * its event type, humanized — the same fallback a computer's rows use.
 */

import type { SubjectEventLike } from "../../../_lib/object/subject-activity";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const stopped = (n: unknown, lead: string) =>
  typeof n === "number" && n > 0
    ? `${lead} — ${plural(n, "key")} stopped working`
    : lead;

export function appActivityLine(
  e: SubjectEventLike,
  humanize: (token: string) => string
): string {
  const data = (e.data ?? {}) as Record<string, unknown>;
  if (data.kind === "pod_oauth_authorization")
    return data.approve === false
      ? "Turned down on the consent screen"
      : "Approved on the consent screen";
  const [subject, action] = e.eventType.split(".");
  if (subject === "app") {
    switch (action) {
      case "request":
        return "Asked for access";
      case "approve":
        return "Access approved";
      case "issue_key":
        return stopped(data.replacedKeys, "New key issued");
      case "revoke":
        return stopped(data.revokedKeys, "Revoked");
      case "rename":
        return typeof data.to === "string"
          ? `Renamed to “${data.to}”`
          : "Renamed";
      case "remove_for_good":
        return "Removed for good";
    }
  }
  if (subject === "api_keys" && action === "revoke" && data.oauthClientId)
    return stopped(data.revokedKeys, "Revoked");
  if (subject === "apiKey") {
    switch (action) {
      case "create":
        return typeof data.keyName === "string"
          ? `Key “${data.keyName}” created`
          : "Key created";
      case "revoke":
        return "Key revoked";
      case "rotate":
        return "Key rotated";
    }
  }
  return humanize(e.eventType.split(".").slice(0, 2).join(" "));
}
