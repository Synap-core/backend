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
 * A failed object read, in words. `noun` is the registry noun ("Rule"), read
 * lowercase inside the sentences. Null when there is no error.
 */
export function loadFailure(
  error: TrpcErrorLike,
  noun: string
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
      return {
        title: `This ${n} couldn’t be found`,
        message:
          "It may have been deleted, or the link is stale. You can still try opening it in the Synap app.",
        chip: "Not found",
      };
    case "FORBIDDEN":
      return {
        title: `You don’t have access to this ${n}`,
        message: `You’re signed in, but this ${n} isn’t visible to you. Ask the owner to share it, or open it in the Synap app if you have access there.`,
        chip: "No access",
      };
    default:
      return couldNotLoad(noun);
  }
}

/** The generic failure — also what an empty successful read reads as. */
export function couldNotLoad(noun: string): LoadFailure {
  const n = noun.toLowerCase();
  return {
    title: `This ${n} couldn’t be loaded`,
    message: `Something went wrong while loading this ${n}. Try again, or open it in the Synap app.`,
    chip: "Couldn’t load",
  };
}
