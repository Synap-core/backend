"use client";

/**
 * The Pod Console's language, mounted ONCE in `app/providers.tsx`, inside the
 * tRPC and query providers (rule i18n §4).
 *
 * - The locale is `users.me.locale` (`consoleLocaleOf`); English until it
 *   answers, and on a page outside sign-in, where the read fails.
 * - It sets the ambient catalog locale (`setAmbientCatalogLocale`), so the
 *   vocabulary door and every `copy.ts` read without a `locale` argument
 *   speak it too, and `<html lang>` follows it. The root layout is a server
 *   component that cannot read the person's session, so `lang` is set here,
 *   on the client.
 * - A change of language remounts the pages below (`key`), so no memoised
 *   word outlives it.
 *
 * pod-admin does not depend on synap-app, so this is the console's own small
 * twin of `@synap-core/hooks/i18n` (`useT`, `useCatalogLocale`), over the same
 * `@synap-core/types/i18n` door: no second resolver.
 */

import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import {
  DEFAULT_LOCALE,
  createT,
  setAmbientCatalogLocale,
  type Catalogs,
  type Locale,
  type MessageCatalog,
  type TFunction,
} from "@synap-core/types/i18n";
import { trpc } from "../trpc";
import { consoleLocaleOf } from "./locale";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function ConsoleLocaleProvider({ children }: { children: ReactNode }) {
  // A public page (sign-in, invite) has no session: the read fails once and
  // the console stays English, never retried.
  const me = trpc.users.me.useQuery(undefined, {
    staleTime: 300_000,
    retry: false,
  });
  const locale = consoleLocaleOf(me.data);
  // Before the pages below render: they read the ambient locale as they draw.
  setAmbientCatalogLocale(locale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <LocaleContext.Provider value={locale}>
      <Fragment key={locale}>{children}</Fragment>
    </LocaleContext.Provider>
  );
}

/** The console's catalog language (`"en" | "fr"`): for value formatters. */
export function useConsoleLocale(): Locale {
  return useContext(LocaleContext);
}

/** The translator for a `copy.ts`'s catalogs, in the console's language. */
export function useT<T extends MessageCatalog>(
  catalogs: Catalogs<T>
): TFunction<T> {
  const locale = useConsoleLocale();
  return useMemo(() => createT(locale, catalogs), [locale, catalogs]);
}
