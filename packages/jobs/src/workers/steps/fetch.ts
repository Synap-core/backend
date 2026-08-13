/**
 * `fetch` step executor — makes an HTTP request and returns status + body.
 */
import { resolveTemplate } from "../template-resolve.js";
import {
  resolveVaultReferences,
  isVaultReference,
} from "../../utils/vault-resolver.js";
import { validateExternalUrl, safeExternalFetch } from "@synap/shared-utils";
import type { StepContext } from "../automation-executor-types.js";

export async function executeFetchStep(
  data: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  },
  context: StepContext,
  ownerId: string
): Promise<Record<string, unknown>> {
  // Resolve template variables in url, headers, body
  const resolvedUrl = resolveTemplate(data.url, context);
  const resolvedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.headers ?? {})) {
    resolvedHeaders[k] = resolveTemplate(v, context);
  }
  const resolvedBody = data.body
    ? resolveTemplate(data.body, context)
    : undefined;

  // Resolve vault references in header values (e.g., Authorization: vault://secret-id)
  const hasVaultHeaders = Object.values(resolvedHeaders).some(isVaultReference);
  const finalHeaders = hasVaultHeaders
    ? await resolveVaultReferences(resolvedHeaders, ownerId)
    : resolvedHeaders;

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

  if (!resolvedUrl) throw new Error("fetch node: url is required");

  // SSRF guard: the URL is content/template-derived, so an untrusted source
  // could otherwise steer it at an internal address.
  const fetchUrlCheck = validateExternalUrl(resolvedUrl);
  if (!fetchUrlCheck.valid) {
    throw new Error(`fetch node blocked: ${fetchUrlCheck.reason}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await safeExternalFetch(resolvedUrl, {
      method: data.method ?? "GET",
      headers: finalHeaders,
      body: bodyPayload,
      signal: controller.signal,
    });
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
