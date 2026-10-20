import { db, and, eq, drizzleSql, automations } from "@synap/database";

/**
 * `automations.metadata.installedByPackage` — the package that installed the
 * row, and so may re-install over it (`assertNoNamedClash`). Server-owned:
 * only a package apply stamps it, from the package's own `_meta.slug`
 * ({@link stampInstalledByPackage}). No author or client metadata write
 * carries it ({@link withoutServerOwnedAutomationMetadata}): a forged stamp
 * would let any package take over the row.
 */
export const INSTALLED_BY_PACKAGE_KEY = "installedByPackage";

/** A client/author metadata bag with every server-owned key dropped. Pure. */
export function withoutServerOwnedAutomationMetadata<
  T extends Record<string, unknown> | undefined,
>(metadata: T): T {
  if (!metadata || !(INSTALLED_BY_PACKAGE_KEY in metadata)) return metadata;
  const { [INSTALLED_BY_PACKAGE_KEY]: _dropped, ...rest } = metadata;
  return rest as T;
}

/**
 * Stamp the installing package on an automation that has none yet: the first
 * package that installed a row keeps it.
 */
export async function stampInstalledByPackage(
  automationId: string,
  packageSlug: string
): Promise<void> {
  await db
    .update(automations)
    .set({
      metadata: drizzleSql`COALESCE(${automations.metadata}, '{}'::jsonb) || jsonb_build_object(${INSTALLED_BY_PACKAGE_KEY}::text, ${packageSlug}::text)`,
    })
    .where(
      and(
        eq(automations.id, automationId),
        drizzleSql`NOT (COALESCE(${automations.metadata}, '{}'::jsonb) ? ${INSTALLED_BY_PACKAGE_KEY})`
      )
    );
}
