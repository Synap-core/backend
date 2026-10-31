"use client";

/**
 * The "All tools" switch: whether an admin's nav shows every operator group
 * after the client places (`navFor`, audit a48761f2 PA-G-06). Off by default, for everyone:
 * a client's founder IS `pod_admin`, so the client view is the default and
 * the operator turns this on once.
 *
 * Remembered in this browser, per person (the key carries the signed-in
 * email): no user-preference door on the pod holds a console setting today
 * (`preferences.updateReview` is typed to Review's own choices), so this
 * is a per-viewer convenience, like the nav's collapse. Storage can be
 * absent or throw: the switch then starts off and still works.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const KEY_PREFIX = "pod-console.all-tools";

function storageKey(email: string | undefined): string {
  return `${KEY_PREFIX}:${email ?? "anonymous"}`;
}

type AllTools = [on: boolean, set: (next: boolean) => void];

const AllToolsContext = createContext<AllTools>([false, () => {}]);

export function AllToolsProvider({
  email,
  children,
}: {
  email: string | undefined;
  children: ReactNode;
}) {
  // Off on the server and on the first client paint alike (no hydration
  // mismatch); the remembered choice is read once mounted.
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      setOn(window.localStorage.getItem(storageKey(email)) === "1");
    } catch {
      // Not remembered: the switch starts off.
    }
  }, [email]);
  const set = useCallback(
    (next: boolean) => {
      setOn(next);
      try {
        window.localStorage.setItem(storageKey(email), next ? "1" : "0");
      } catch {
        // Not remembered this time; the switch still works.
      }
    },
    [email]
  );
  return (
    <AllToolsContext.Provider value={[on, set]}>
      {children}
    </AllToolsContext.Provider>
  );
}

export function useAllTools(): AllTools {
  return useContext(AllToolsContext);
}
