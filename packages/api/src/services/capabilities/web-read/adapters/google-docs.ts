/**
 * Google Docs shared "anyone with the link": the document's own plain-text
 * export (`/export?format=txt`). The export redirects to a
 * googleusercontent.com download; every hop goes back through the SSRF door.
 * A document that is not public redirects to a Google sign-in PAGE (HTML) —
 * that is a private document, never its text.
 */

import {
  fromGetFailure,
  siteBlocked,
  type SiteAdapter,
  type SiteRead,
} from "../adapter.js";
import { BUILTIN_READ_TEXT_MAX } from "../limits.js";

const EXPORT_REDIRECT_HOPS = 5;

export const googleDocsAdapter: SiteAdapter = {
  id: "google-docs",
  name: "Google Docs",
  urls: ["docs.google.com/document/d/*"],
  async read(url, ctx): Promise<SiteRead | null> {
    const id = /^\/document\/d\/([A-Za-z0-9_-]{10,})/.exec(
      new URL(url).pathname
    )?.[1];
    // `/document/d/e/<pub id>/pub` is a published page: the article rung reads it.
    if (!id) return null;
    const got = await ctx.get(
      `https://docs.google.com/document/d/${id}/export?format=txt`,
      {
        accept: "text/plain",
        redirects: EXPORT_REDIRECT_HOPS,
        maxBytes: 2_000_000,
      }
    );
    if (!got.ok) {
      if (got.kind === "http" && (got.status === 401 || got.status === 403)) {
        return siteBlocked(
          "private",
          "open_in_my_browser",
          "the document is not shared with anyone who has the link"
        );
      }
      return fromGetFailure(got, "Google Docs");
    }
    if (!got.contentType.toLowerCase().startsWith("text/plain")) {
      return siteBlocked(
        "private",
        "open_in_my_browser",
        "Google asked to sign in: the document is not shared publicly"
      );
    }
    const text = got.body
      .replace(/^\ufeff/, "")
      .replace(/\r\n/g, "\n")
      .trim();
    if (!text) {
      return {
        status: "partial",
        siteName: "Google Docs",
        fields: { documentId: id },
      };
    }
    const firstLine = text
      .split("\n")
      .find((l) => l.trim())
      ?.trim();
    return {
      status: "ok",
      siteName: "Google Docs",
      ...(firstLine ? { title: firstLine.slice(0, 200) } : {}),
      text: text.slice(0, BUILTIN_READ_TEXT_MAX),
      canonicalUrl: `https://docs.google.com/document/d/${id}`,
      fields: { documentId: id },
    };
  },
};
