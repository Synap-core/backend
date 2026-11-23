/**
 * Pod-wide NUMBER settings the governance reads, each a `config_settings` row
 * (scope `default`, no workspace, `value: { value: n }`), seeded by 0451 with
 * the default below. A missing, revoked or out-of-range row reads as the
 * default; the closed list is what a person may set.
 *
 *   governance.own_work_fresh_hours  how long an agent's own work stays
 *                                    "fresh" for the own-organise class
 *                                    (`isOwnFreshWork`);
 *   governance.project_evidence_min  the entities an agent's project names
 *                                    as evidence before it is not MARKED
 *                                    for the reviewer (never a refusal).
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { configSettings } from "../schema/config-settings.js";

type DbHandle = typeof import("../client-pg.js").db;

export const POD_NUMBER_SETTINGS = {
  "governance.own_work_fresh_hours": { default: 24, min: 1, max: 168 },
  "governance.project_evidence_min": { default: 5, min: 0, max: 50 },
} as const satisfies Record<
  string,
  { default: number; min: number; max: number }
>;
export type PodNumberSettingKey = keyof typeof POD_NUMBER_SETTINGS;
export const POD_NUMBER_SETTING_KEYS = Object.keys(POD_NUMBER_SETTINGS) as [
  PodNumberSettingKey,
  ...PodNumberSettingKey[],
];

/** `created_by` of a seeded row (machine namespace, as the class defaults). */
export const POD_SETTING_SEED_CREATED_BY = "system:pod-setting-default";

const activeRow = (key: PodNumberSettingKey) =>
  and(
    eq(configSettings.key, key),
    eq(configSettings.scopeKind, "default"),
    isNull(configSettings.workspaceId),
    isNull(configSettings.revokedAt)
  );

function inRange(key: PodNumberSettingKey, value: unknown): value is number {
  const { min, max } = POD_NUMBER_SETTINGS[key];
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** The setting's value: the newest active row, else its default. */
export async function readPodNumberSetting(
  db: DbHandle,
  key: PodNumberSettingKey
): Promise<number> {
  const [row] = await db
    .select({ value: configSettings.value })
    .from(configSettings)
    .where(activeRow(key))
    .orderBy(desc(configSettings.createdAt))
    .limit(1);
  const value = (row?.value as { value?: unknown } | undefined)?.value;
  return inRange(key, value) ? value : POD_NUMBER_SETTINGS[key].default;
}

/** Every setting's value. */
export async function readPodNumberSettings(
  db: DbHandle
): Promise<Record<PodNumberSettingKey, number>> {
  const values = await Promise.all(
    POD_NUMBER_SETTING_KEYS.map((key) => readPodNumberSetting(db, key))
  );
  return Object.fromEntries(
    POD_NUMBER_SETTING_KEYS.map((key, i) => [key, values[i]!])
  ) as Record<PodNumberSettingKey, number>;
}

/**
 * Write a new version of the setting: the active row is revoked and a new one
 * written with `version + 1` and `supersedesId`, in one transaction (the
 * guideline store's versions, 0258). Called ONLY by the gov-config store-write
 * (`applyGovConfigChange`, api): the one door a person's Settings, an AI's
 * `settings.update` proposal and a recommender share. Refuses a value out of
 * range rather than storing one the read would ignore.
 */
export async function writePodNumberSetting(
  db: DbHandle,
  input: {
    key: PodNumberSettingKey;
    value: number;
    createdBy: string;
    source?: string;
  }
): Promise<{ id: string; value: number }> {
  if (!inRange(input.key, input.value)) {
    const { min, max } = POD_NUMBER_SETTINGS[input.key];
    throw new RangeError(
      `${input.key} must be a whole number from ${min} to ${max}.`
    );
  }
  return db.transaction(async (tx) => {
    const [previous] = await tx
      .update(configSettings)
      .set({ revokedAt: new Date() })
      .where(activeRow(input.key))
      .returning({ id: configSettings.id, version: configSettings.version });
    const [row] = await tx
      .insert(configSettings)
      .values({
        scopeKind: "default",
        key: input.key,
        value: { value: input.value },
        workspaceId: null,
        source: input.source ?? "user",
        createdBy: input.createdBy,
        version: (previous?.version ?? 0) + 1,
        supersedesId: previous?.id ?? null,
      })
      .returning({ id: configSettings.id });
    return { id: row!.id, value: input.value };
  });
}
