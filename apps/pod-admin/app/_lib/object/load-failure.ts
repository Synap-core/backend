/**
 * Shared by every object page, console or `/open` receiver card, so a failed
 * read says the same thing in both.
 */

export type TrpcErrorLike =
  { data?: { code?: string | null } | null } | null | undefined;

export interface LoadFailure {
  title: string;
  message: string;
  chip: string;
}

/**
 * How a page words its failures when the default does not fit. An object
 * with no page in the Synap app (a computer, a connected app — the console is
 * the only place they are drawn) passes `inApp: false`, so no sentence sends
 * the reader there; the frame then drops its "Open in app" too
 * (`ObjectFrame.failure`'s `openIn`). `notFound` / `forbidden` replace those
 * two sentences when the page knows where the reader should look instead.
 */
export interface FailureWording {
  inApp?: boolean;
  notFound?: string;
  forbidden?: string;
  /** The sentence for a read that failed (not a not-found or a refusal). */
  failed?: string;
  /**
   * The titles, for a page that speaks the reader's language: the defaults
   * are English templates around the noun.
   */
  titles?: { notFound?: string; forbidden?: string; failed?: string };
}

/**
 * A failed object read, in words. `noun` is the registry noun ("Rule"), read
 * lowercase inside the sentences. Null when there is no error.
 */
export function loadFailure(
  error: TrpcErrorLike,
  noun: string,
  wording: FailureWording = {}
): LoadFailure | null {
  if (!error) return null;
  const n = noun.toLowerCase();
  switch (error.data?.code) {
    case "UNAUTHORIZED":
      return {
        title: "Signing you in",
        message: "Your session expired. Taking you to sign in…",
        chip: "Sign in required",
      };
    case "NOT_FOUND":
      return notFound(noun, wording);
    case "FORBIDDEN":
      return {
        title:
          wording.titles?.forbidden ?? `You don’t have access to this ${n}`,
        message:
          wording.forbidden ??
          (wording.inApp === false
            ? `You’re signed in, but this ${n} isn’t visible to you. Ask the owner to share it.`
            : `You’re signed in, but this ${n} isn’t visible to you. Ask the owner to share it, or open it in the Synap app if you have access there.`),
        chip: "No access",
      };
    default:
      return couldNotLoad(noun, wording);
  }
}

/**
 * Not there — also what a successful read that does not hold the object (a
 * list without that id) reads as.
 */
export function notFound(
  noun: string,
  wording: FailureWording = {}
): LoadFailure {
  return {
    title:
      wording.titles?.notFound ??
      `This ${noun.toLowerCase()} couldn’t be found`,
    message:
      wording.notFound ??
      (wording.inApp === false
        ? "It may have been deleted, or the link is stale."
        : "It may have been deleted, or the link is stale. You can still try opening it in the Synap app."),
    chip: "Not found",
  };
}

/** The generic failure — also what an empty successful read reads as. */
export function couldNotLoad(
  noun: string,
  wording: FailureWording = {}
): LoadFailure {
  const n = noun.toLowerCase();
  return {
    title: wording.titles?.failed ?? `This ${n} couldn’t be loaded`,
    message:
      wording.failed ??
      (wording.inApp === false
        ? `Something went wrong while loading this ${n}. Try again.`
        : `Something went wrong while loading this ${n}. Try again, or open it in the Synap app.`),
    chip: "Couldn’t load",
  };
}
