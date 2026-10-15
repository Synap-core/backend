/**
 * GitHub repositories through the public REST API, unauthenticated
 * (60 requests/hour per IP): the repo's metadata and its README as raw
 * markdown. Only a repo's own URL (optionally `/tree/<ref>`) is read here —
 * issues, PRs and files are server-rendered pages the article rung reads.
 */

import {
  fromGetFailure,
  isRecord,
  num,
  str,
  type SiteAdapter,
  type SiteRead,
} from "../adapter.js";
import { parseJson } from "../fetch.js";
import { httpUrlOrNull } from "../html.js";
import { BUILTIN_READ_TEXT_MAX } from "../limits.js";

/** First path segments that are GitHub's own pages, never an owner. */
const NOT_OWNERS = new Set([
  "about",
  "apps",
  "codespaces",
  "collections",
  "contact",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "pricing",
  "pulls",
  "readme",
  "search",
  "security",
  "settings",
  "site",
  "sponsors",
  "team",
  "topics",
  "trending",
]);

const API = "https://api.github.com";
const API_HEADERS = { "X-GitHub-Api-Version": "2022-11-28" };

export const githubAdapter: SiteAdapter = {
  id: "github",
  name: "GitHub",
  serviceId: "github",
  urls: ["github.com/*/*"],
  async read(url, ctx): Promise<SiteRead | null> {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    const [owner, rawRepo, third] = segs;
    if (!owner || !rawRepo || NOT_OWNERS.has(owner.toLowerCase())) return null;
    if (segs.length > 2 && third !== "tree") return null;
    if (segs.length > 2 && segs.length < 4) return null;
    const repo = rawRepo.replace(/\.git$/, "");
    const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    const [repoGot, readmeGot] = await Promise.all([
      ctx.get(base, {
        accept: "application/vnd.github+json",
        headers: API_HEADERS,
      }),
      ctx.get(`${base}/readme`, {
        accept: "application/vnd.github.raw+json",
        headers: API_HEADERS,
        maxBytes: 1_000_000,
      }),
    ]);
    if (!repoGot.ok) {
      // 404: not a repo we can see (a GitHub page, or a private repo) — the
      // page rung decides, and says not_found for a missing repo.
      if (repoGot.kind === "http" && repoGot.status === 404) return null;
      // Unauthenticated rate limit: the server-rendered repo page still reads.
      if (
        repoGot.kind === "http" &&
        (repoGot.status === 403 || repoGot.status === 429) &&
        /rate limit/i.test(repoGot.body)
      ) {
        return {
          status: "failed",
          error: "GitHub's API rate limit for the pod is spent",
        };
      }
      return fromGetFailure(repoGot, "GitHub's API");
    }
    const r = parseJson(repoGot.body);
    if (!isRecord(r) || !str(r.full_name)) {
      return { status: "failed", error: "GitHub answered no repository" };
    }
    const description = str(r.description);
    const readme = readmeGot.ok ? readmeGot.body.trim() : "";
    const text = [description, readme]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, BUILTIN_READ_TEXT_MAX);
    const ownerRec = isRecord(r.owner) ? r.owner : {};
    const license = isRecord(r.license) ? str(r.license.spdx_id) : undefined;
    const topics = Array.isArray(r.topics)
      ? r.topics.filter((t): t is string => typeof t === "string")
      : [];
    const fields: Record<string, string | number | boolean> = {};
    for (const [from, to] of [
      ["stargazers_count", "stars"],
      ["forks_count", "forks"],
      ["open_issues_count", "openIssues"],
    ] as const) {
      const n = num(r[from]);
      if (n !== undefined) fields[to] = n;
    }
    if (str(r.language)) fields.language = str(r.language)!;
    if (license && license !== "NOASSERTION") fields.license = license;
    if (topics.length) fields.topics = topics.join(", ");
    if (typeof r.archived === "boolean") fields.archived = r.archived;
    const homepage = httpUrlOrNull(str(r.homepage));
    if (homepage) fields.homepage = homepage;
    if (str(r.pushed_at)) fields.pushedAt = str(r.pushed_at)!;

    return {
      status: readme ? "ok" : "partial",
      siteName: "GitHub",
      title: str(r.full_name),
      ...(text ? { text } : {}),
      ...(str(ownerRec.login) ? { author: str(ownerRec.login) } : {}),
      ...(httpUrlOrNull(str(ownerRec.html_url))
        ? { authorUrl: httpUrlOrNull(str(ownerRec.html_url))! }
        : {}),
      ...(str(r.created_at) ? { publishedAt: str(r.created_at) } : {}),
      ...(httpUrlOrNull(str(r.html_url))
        ? { canonicalUrl: httpUrlOrNull(str(r.html_url))! }
        : {}),
      fields,
    };
  },
};
