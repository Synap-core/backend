"use client";

/**
 * "Preview member menu" (plan W4): a pod admin sees the console as a member
 * does — the nav, Home and the ⌘K palette — without signing in as one.
 *
 * It is a CLIENT-ONLY override of `ConsoleRoleProvider`'s value, and it can
 * only shrink the role (`effectiveConsoleRole`): a member can never preview
 * their way into the admin console. It changes what the console OFFERS,
 * never what the pod returns: the choice lives in this tab's
 * `sessionStorage` (never a cookie, so no request carries it), the proxy
 * still stamps the real role from its own probe, and every read is still
 * re-checked server-side as the operator. So the data on screen is the
 * operator's own, never a member's, and the banner says so.
 *
 * Remembered per tab, not per browser: a preview left on must not greet the
 * operator in a new window as if they had lost their tools. Storage can be
 * absent or throw: the preview then starts off and still works.
 */

import { Button } from "@heroui/react";
import { Eye } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ConsoleRole } from "../../../lib/route-policy";
import { useT } from "../../../lib/i18n/locale-provider";
import { en, fr } from "./copy";
import { ConsoleRoleProvider } from "./side-nav-role";

const CATALOGS = { en, fr };

/** The tab's remembered choice. The ONE place it is named (tripwire). */
export const MEMBER_PREVIEW_KEY = "pod-console.member-preview";

/**
 * The role the console offers. Preview only ever SHRINKS it: an admin
 * previewing sees the member console; a member stays a member.
 */
export function effectiveConsoleRole(
  real: ConsoleRole,
  preview: boolean
): ConsoleRole {
  return preview ? (real === "admin" ? "member" : "admin") : real;
}

export interface MemberPreview {
  /** The viewer may preview (their real role is admin). */
  available: boolean;
  /** The preview is on. */
  on: boolean;
  set: (next: boolean) => void;
}

const MemberPreviewContext = createContext<MemberPreview>({
  available: false,
  on: false,
  set: () => {},
});

export function MemberPreviewProvider({
  realRole,
  initialOn = false,
  children,
}: {
  /** The role the proxy found (`x-pod-console-role`). */
  realRole: ConsoleRole;
  /** Test seam: the state before the tab's choice is read. */
  initialOn?: boolean;
  children: ReactNode;
}) {
  // Off on the server and on the first client paint alike (no hydration
  // mismatch); the tab's choice is read once mounted.
  const [on, setOn] = useState(initialOn);
  useEffect(() => {
    try {
      setOn(window.sessionStorage.getItem(MEMBER_PREVIEW_KEY) === "1");
    } catch {
      // Not remembered: the preview starts off.
    }
  }, []);
  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      window.sessionStorage.setItem(MEMBER_PREVIEW_KEY, next ? "1" : "0");
    } catch {
      // Not remembered this time; the preview still works.
    }
  }, []);
  const available = realRole === "admin";
  const value = useMemo<MemberPreview>(
    () => ({ available, on: available && on, set }),
    [available, on, set]
  );
  return (
    <MemberPreviewContext.Provider value={value}>
      <ConsoleRoleProvider role={effectiveConsoleRole(realRole, value.on)}>
        {children}
      </ConsoleRoleProvider>
    </MemberPreviewContext.Provider>
  );
}

export function useMemberPreview(): MemberPreview {
  return useContext(MemberPreviewContext);
}

/**
 * Over every page while the preview is on: what this is, that the data is
 * the operator's own, and the way out. Nothing when it is off.
 */
export function MemberPreviewBanner() {
  const t = useT(CATALOGS);
  const preview = useMemberPreview();
  if (!preview.on) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-foreground/[0.06] bg-content2 px-4 py-2"
    >
      <Eye className="h-4 w-4 shrink-0 text-foreground/65" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] font-medium text-foreground">
          {t("memberPreview.title")}
        </span>
        <span className="text-[12px] text-foreground/65">
          {t("memberPreview.body")}
        </span>
      </div>
      <Button
        size="sm"
        variant="flat"
        radius="md"
        onPress={() => preview.set(false)}
      >
        {t("memberPreview.stop")}
      </Button>
    </div>
  );
}
