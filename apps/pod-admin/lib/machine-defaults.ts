/** `apiKeys.getMachineDefaults` — the pod default computer key lifetime. */
export interface MachineDefaults {
  keyTtlDays: number;
  /** A pod admin set it (otherwise `keyTtlDays` is the built-in default). */
  stored: boolean;
  defaultKeyTtlDays: number;
  minKeyTtlDays: number;
  maxKeyTtlDays: number;
}
