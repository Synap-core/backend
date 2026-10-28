/**
 * `fetch` step executor — makes an HTTP request and returns status + body.
 */
import { resolveTemplate } from "../template-resolve.js";
import { resolveAuthoredVaultRefs } from "../../utils/authored-vault-refs.js";
import {
  guardProducerEffect,
  PolicyBlockedError,
} from "../../utils/automation-governance.js";
import { validateExternalUrl, safePublicFetch } from "@synap/shared-utils";
import type { StepContext } from "../automation-executor-types.js";

export async function executeFetchStep(
  data: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  },
  context: StepContext,
  ownerId: string,
  opts: {
    workspaceId: string;
    /** The causal-chain producer (see the webhook node's guard in output.ts). */
    producerAgentUserId?: string | null;
  }
): Promise<Record<string, unknown>> {
  // CONFUSED-DEPUTY GUARD, the same one the `webhook` node runs: a fetch sends
  // the owner's vault secrets and run data to a URL the run may have chosen.
  // When an agent produced the trigger of a human-owned automation, it fails
  // closed BEFORE any URL, template or vault work (pre-launch audit
  // 2026-10-28, governance F3: `fetch` with method POST was the same effect
  // through an unguarded door).
  const guard = await guardProducerEffect({
    producerAgentUserId: opts.producerAgentUserId,
    principalUserId: ownerId,
    workspaceId: opts.workspaceId,
    subjectType: "webhook",
    action: "send",
  });
  if ("block" in guard) {
    throw new PolicyBlockedError(
      guard.kind,
      guard.kind === "deny"
        ? `fetch denied by producer-agent governance (confused-deputy guard): ${guard.reason ?? "denied"}`
        : `fetch cannot auto-execute: an agent produced this trigger, so a human-owned automation may not send a request with the owner's credentials ungoverned (confused-deputy guard).`
    );
  }

  // Resolve template variables in url, headers, body
  const resolvedUrl = resolveTemplate(data.url, context);
  const resolvedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.headers ?? {})) {
    resolvedHeaders[k] = resolveTemplate(v, context);
  }
  const resolvedBody = data.body
    ? resolveTemplate(data.body, context)
    : undefined;

  if (!resolvedUrl) throw new Error("fetch node: url is required");

  // SSRF guard: the URL is content/template-derived, so an untrusted source
  // could otherwise steer it at an internal address. Checked BEFORE any secret
  // is resolved; `safePublicFetch` then resolves the name, refuses a private
  // answer and pins the address it vetted. Any port: the author names it (a
  // self-hosted n8n on :5678).
  const fetchUrlCheck = validateExternalUrl(resolvedUrl, {
    allowedPorts: "any",
  });
  if (!fetchUrlCheck.valid) {
    throw new Error(`fetch node blocked: ${fetchUrlCheck.reason}`);
  }

  // Vault references (`Authorization: vault://secret-id`) are resolved only
  // where the author wrote them; one that came out of a template is refused.
  const finalHeaders = await resolveAuthoredVaultRefs(
    data.headers ?? {},
    resolvedHeaders,
    ownerId,
    "fetch node"
  );

  // Parse body as JSON if valid, else send as raw string
  let bodyPayload: string | undefined;
  if (resolvedBody) {
    bodyPayload = resolvedBody;
    if (!finalHeaders["Content-Type"] && !finalHeaders["content-type"]) {
      try {
        JSON.parse(resolvedBody);
        finalHeaders["Content-Type"] = "application/json";
      } catch {
        // Not JSON — leave Content-Type unset
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await safePublicFetch(
      resolvedUrl,
      {
        method: data.method ?? "GET",
        headers: finalHeaders,
        body: bodyPayload,
        signal: controller.signal,
      },
      0,
      { allowedPorts: "any" }
    );
    clearTimeout(timer);

    // Collect response headers as a plain record
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Parse body as JSON if content-type indicates it, else raw string
    const contentType = response.headers.get("content-type") ?? "";
    let responseBody: unknown;
    if (contentType.includes("application/json")) {
      try {
        responseBody = await response.json();
      } catch {
        responseBody = await response.text();
      }
    } else {
      responseBody = await response.text();
    }

    if (!response.ok) {
      throw new Error(
        `fetch node: HTTP ${response.status} ${response.statusText} from ${resolvedUrl}`
      );
    }

    return {
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
