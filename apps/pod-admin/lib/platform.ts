/**
 * Is the reader on a PHONE?
 *
 * It matters for one reason: on a phone the `synap://` scheme opens the mobile
 * app (Relay), not the desktop one, and Relay opens a different set of things
 * (`open-in.ts` `placeExit`). A tablet or a desktop browser is not a phone —
 * their `synap://` goes to the desktop app, or to nothing.
 *
 * `mobileHint` is `navigator.userAgentData.mobile` where the browser has it
 * (Chromium): the browser's own answer, so it wins over sniffing. Everywhere
 * else (Safari, Firefox) the user agent string is all there is; the pattern is
 * the conventional phone set — iPhone/iPod, Android WITH "Mobile" (an Android
 * tablet omits it), and the long tail that still says "Mobi".
 */
export function isPhone(userAgent: string, mobileHint?: boolean): boolean {
  if (typeof mobileHint === "boolean") return mobileHint;
  if (/iPad/i.test(userAgent)) return false;
  return /iPhone|iPod|Android.*Mobile|Windows Phone|IEMobile|Opera Mini|Mobi/i.test(
    userAgent
  );
}
