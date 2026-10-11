/**
 * `/device` — the pure model behind the computer-approval page
 * (MACHINE-IDENTITY-PLAN W3). It is the ONE rule Relay's "Connect a computer"
 * (W6) also runs, so it lives in `@synap-core/types/device` and both surfaces
 * import it: which state a read lands in, the "reconnect or new" default, the
 * exact decision each button sends, whether approving is a hold. Tested there
 * (`packages/types/src/device/device.test.ts`).
 *
 * Re-exported here so the page keeps one local import; nothing is decided in
 * this file.
 */
export * from "@synap-core/types/device";
