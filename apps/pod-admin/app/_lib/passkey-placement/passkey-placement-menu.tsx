"use client";

/**
 * The button that creates a passkey, as ONE question (ui-composition §12):
 * pressing it opens "Where should this passkey live?" with its two answers,
 * and the answer runs the ceremony at once (the press is the user gesture
 * WebAuthn needs). No answer is pre-selected: none is declared.
 *
 * Every pod-admin place that creates a passkey draws this (Settings ›
 * Security, the invite page); the answer reaches `createPasskey`, the one
 * helper that merges it onto Kratos' options (`lib/passkey.ts` `placePasskey`).
 */

import type { ReactNode } from "react";
import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownSection,
  DropdownTrigger,
  type ButtonProps,
} from "@heroui/react";
import { ChevronDown, Fingerprint, KeyRound } from "lucide-react";
import type { PasskeyPlacement } from "../../../lib/passkey";
import { useT } from "../../../lib/i18n/locale-provider";
import { en, fr } from "./copy";

const CATALOGS = { en, fr };

export function PasskeyPlacementMenu({
  children,
  onChoose,
  isLoading,
  isDisabled,
  button,
}: {
  /** The button's words ("Add a passkey", "Create the passkey"). */
  children: ReactNode;
  onChoose: (placement: PasskeyPlacement) => void;
  isLoading?: boolean;
  isDisabled?: boolean;
  /** The trigger's look, as the place draws its other buttons. */
  button?: Pick<ButtonProps, "color" | "variant" | "size" | "radius">;
}) {
  const t = useT(CATALOGS);
  return (
    <Dropdown placement="bottom-start">
      <DropdownTrigger>
        <Button
          {...button}
          isLoading={isLoading}
          isDisabled={isDisabled}
          startContent={isLoading ? null : <KeyRound className="h-3.5 w-3.5" />}
          endContent={<ChevronDown className="h-3.5 w-3.5" />}
        >
          {children}
        </Button>
      </DropdownTrigger>
      <DropdownMenu
        aria-label={t("placement.question")}
        className="max-w-[340px]"
        onAction={(key) => onChoose(key as PasskeyPlacement)}
      >
        <DropdownSection title={t("placement.question")}>
          <DropdownItem
            key="device"
            startContent={<Fingerprint className="h-4 w-4" />}
            description={t("placement.device.hint")}
            classNames={{ description: "whitespace-normal" }}
          >
            {t("placement.device.label")}
          </DropdownItem>
          <DropdownItem
            key="manager"
            startContent={<KeyRound className="h-4 w-4" />}
            description={t("placement.manager.hint")}
            classNames={{ description: "whitespace-normal" }}
          >
            {t("placement.manager.label")}
          </DropdownItem>
        </DropdownSection>
      </DropdownMenu>
    </Dropdown>
  );
}
