/**
 * The page HTML a person's browser sent with a link (Save page on a login-only
 * site, the extension). It is kept BESIDE the item in object storage — never
 * as the item's body, which stays the URL — and named on
 * `documents.metadata.importPage`. The light read prefers it over fetching the
 * URL (the pod would only see the login wall).
 */

import { documents, drizzleSql, eq } from "@synap/database";
import type { db as DbType } from "@synap/database";

/** `documents.metadata.importPage` — pod-internal. */
export interface LibraryPageMeta {
  htmlKey: string;
  chars: number;
  savedAt: string;
}

export const LIBRARY_PAGE_KEY = "importPage";

export function libraryPageHtmlKey(userId: string, itemId: string): string {
  return `library-page/${userId}/${itemId}.html`;
}

export function readLibraryPageMeta(metadata: unknown): LibraryPageMeta | null {
  const raw = (metadata as Record<string, unknown> | null)?.[LIBRARY_PAGE_KEY];
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<LibraryPageMeta>;
  return typeof p.htmlKey === "string" && p.htmlKey
    ? {
        htmlKey: p.htmlKey,
        chars: typeof p.chars === "number" ? p.chars : 0,
        savedAt: typeof p.savedAt === "string" ? p.savedAt : "",
      }
    : null;
}

/** Store the HTML beside the item and name it on the item. */
export async function keepLibraryPageHtml(args: {
  database: Pick<typeof DbType, "update">;
  userId: string;
  itemId: string;
  html: string;
  upload?: (key: string, html: string) => Promise<void>;
}): Promise<LibraryPageMeta> {
  const htmlKey = libraryPageHtmlKey(args.userId, args.itemId);
  const upload =
    args.upload ??
    (async (key: string, html: string) => {
      const { storage } = await import("@synap/storage");
      await storage.upload(key, html, {
        contentType: "text/html; charset=utf-8",
      });
    });
  await upload(htmlKey, args.html);
  const meta: LibraryPageMeta = {
    htmlKey,
    chars: args.html.length,
    savedAt: new Date().toISOString(),
  };
  await args.database
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(coalesce(${documents.metadata}, '{}'::jsonb), '{importPage}', ${JSON.stringify(meta)}::jsonb)`,
    })
    .where(eq(documents.id, args.itemId));
  return meta;
}
