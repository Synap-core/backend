/**
 * One bounded HTTPS GET to an already-validated public IP.
 *
 * The request half of every SSRF-safe outbound fetch: the caller first runs
 * `resolvePublicIssuerEndpoint` (issuer-url-safety.ts), which refuses local
 * hostnames and non-public DNS answers and returns the public IP it checked;
 * this function connects to THAT IP, with Host + SNI set to the real hostname
 * so TLS certificate validation stays intact. There is no second DNS lookup, so
 * no rebinding window opens between validation and the request.
 *
 * Bounds, all enforced here so no caller can forget one:
 *   - redirects are never followed (node's `https.request` does not, and the
 *     3xx comes back to the caller as a status to refuse);
 *   - the body is cut off past `maxBytes`;
 *   - `timeoutMs` bounds the WHOLE exchange, not just socket idleness, so a
 *     server dribbling one byte at a time cannot hold the request open.
 */

import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import type { ResolvedIssuerEndpoint } from "./issuer-url-safety.js";

export interface PinnedHttpsGetOptions {
  timeoutMs: number;
  maxBytes: number;
  accept?: string;
}

export interface PinnedHttpsGetResult {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export function pinnedHttpsGet(
  target: ResolvedIssuerEndpoint,
  path: string,
  opts: PinnedHttpsGetOptions
): Promise<PinnedHttpsGetResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // Declared before the request: a response can arrive (and settle) before
    // the timer line below runs.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (err: Error | null, result?: PinnedHttpsGetResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err);
      else resolve(result!);
    };

    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: target.address,
        port: target.port,
        path,
        method: "GET",
        headers: {
          accept: opts.accept ?? "application/json",
          host: target.hostHeader,
        },
        servername: isIP(target.hostname) === 0 ? target.hostname : undefined,
        timeout: opts.timeoutMs,
        agent: false,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const headers = response.headers ?? {};
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          finish(null, { statusCode, headers, body: "" });
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > opts.maxBytes) {
            const error = new Error(
              `Response exceeded ${opts.maxBytes} bytes from ${target.hostHeader}`
            );
            response.destroy(error);
            finish(error);
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", (err: Error) => finish(err));
        response.once("end", () => {
          finish(null, {
            statusCode,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    if (!settled) {
      deadline = setTimeout(() => {
        const error = new Error(`Request timed out after ${opts.timeoutMs}ms`);
        req.destroy(error);
        finish(error);
      }, opts.timeoutMs);
    }

    req.once("timeout", () => {
      const error = new Error(`Request timed out after ${opts.timeoutMs}ms`);
      req.destroy(error);
      finish(error);
    });
    req.once("error", (err: Error) => finish(err));
    req.end();
  });
}
