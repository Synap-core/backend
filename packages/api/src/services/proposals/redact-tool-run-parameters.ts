/**
 * A tool run's credential-like arguments never leave the pod on a read.
 *
 * `redactSecretParams` masks an INSTALL's `data.params`; a `capability.run`
 * keeps its arguments at `data.parameters` and its revision entries carry them
 * in `before.parameters` / `patch.parameters`, so both used to reach the
 * browser (pod admin, relay, the browser app) whole: the card drew a mark in
 * place of a credential while `data`, `request.data`, `review.changes` and
 * `revisionHistory` held its value. One rule, applied to every place the read
 * door serializes them. A credential is an argument the verb's schema marks
 * (`secretKeys`, from `describeToolRun`) or whose name reads as one
 * (`isSecretParamName`, the pod's one heuristic).
 */

import { isSecretParamName } from "../capabilities/capability-catalog.js";
import { REDACTED_PARAM } from "./proposal-setup.js";
import { parseVaultReference } from "@synap-core/types/vault";

type Bag = Record<string, unknown>;

const isBag = (v: unknown): v is Bag =>
  !!v && typeof v === "object" && !Array.isArray(v);

function maskParameters(
  parameters: unknown,
  secretKeys: ReadonlySet<string>
): unknown {
  if (!isBag(parameters)) return parameters;
  let touched = false;
  const next: Bag = { ...parameters };
  for (const key of Object.keys(parameters)) {
    if (!secretKeys.has(key) && !isSecretParamName(key)) continue;
    const v = parameters[key];
    if (v === null || v === undefined || v === "") continue;
    if (parseVaultReference(v)) continue; // a pointer, not a value
    next[key] = REDACTED_PARAM;
    touched = true;
  }
  return touched ? next : parameters;
}

/** A `capability.run` envelope with `parameters` masked; any other data as is. */
export function redactToolRunData<T>(
  data: T,
  secretKeys: ReadonlySet<string>
): T {
  if (!isBag(data) || !("parameters" in data)) return data;
  const masked = maskParameters(data.parameters, secretKeys);
  return masked === data.parameters
    ? data
    : ({ ...data, parameters: masked } as T);
}

/** Every revision entry with the arguments it carries masked the same way. */
export function redactRevisionHistory<T>(
  history: T,
  secretKeys: ReadonlySet<string>
): T {
  if (!Array.isArray(history)) return history;
  return history.map((entry) => {
    if (!isBag(entry)) return entry;
    let out: Bag = entry;
    for (const side of ["before", "patch"] as const) {
      const part = entry[side];
      if (isBag(part) && "parameters" in part) {
        const masked = maskParameters(part.parameters, secretKeys);
        if (masked !== part.parameters) {
          out = { ...out, [side]: { ...part, parameters: masked } };
        }
      }
    }
    return out;
  }) as unknown as T;
}
