/**
 * A failed app read, in words. Titles and chips are the shared object ones
 * (`loadFailure`); the sentence is the app's own, because the shared one
 * offers "open it in the Synap app" and a connected app has no page there —
 * this console page is the only one.
 */

import {
  couldNotLoad,
  loadFailure,
  type LoadFailure,
  type TrpcErrorLike,
} from "../../../_lib/object/load-failure";

const NOUN = "App";

export function appLoadFailure(error: TrpcErrorLike): LoadFailure {
  const base = loadFailure(error, NOUN) ?? couldNotLoad(NOUN);
  switch (error?.data?.code) {
    case "UNAUTHORIZED":
      return base;
    case "NOT_FOUND":
      return {
        ...base,
        message:
          "It may have been removed for good, or the link is stale. Every app still connected is on the Apps list.",
      };
    case "FORBIDDEN":
      return {
        ...base,
        message:
          "An app's page is for pod admins. Your own apps are on your Connected page.",
      };
    default:
      return {
        ...base,
        message: "Something went wrong while loading this app. Try again.",
      };
  }
}
