"use client";

/**
 * Copy text to the clipboard, and the one way a failure's technical detail
 * reaches the reader: never appended to the sentence (`HTTP 503`, a stack
 * message), only behind a small "Copy details" control they can paste into a
 * message to whoever runs the pod.
 */

import { useState } from "react";
import { Button } from "@heroui/react";
import { AlertCircle, Check, Copy } from "lucide-react";

export function CopyButton({
  text,
  label,
  copiedLabel = "Copied",
  size = "sm",
  variant = "flat",
  ariaLabel,
}: {
  text: string;
  label: string;
  copiedLabel?: string;
  size?: "sm" | "md";
  variant?: "flat" | "light";
  ariaLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // A rejected clipboard write must not say "Copied".
    }
  };
  const Icon = copied ? Check : Copy;
  return (
    <Button
      size={size}
      variant={variant}
      radius="md"
      startContent={<Icon className="h-3.5 w-3.5" />}
      onPress={() => void copy()}
      aria-label={ariaLabel}
    >
      {copied ? copiedLabel : label}
    </Button>
  );
}

/** A failure: one fixed human sentence + (optionally) the detail, copy-only. */
export function ErrorNote({
  message,
  detail,
}: {
  message: string;
  detail?: string | null;
}) {
  return (
    <div
      className="flex flex-col items-start gap-1.5 rounded-medium bg-danger/10 p-3 text-[13px] text-danger ring-1 ring-inset ring-danger/30"
      role="alert"
    >
      <span className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{message}</span>
      </span>
      {detail ? (
        <CopyButton
          text={detail}
          label="Copy details"
          variant="light"
          ariaLabel="Copy the technical details of this error"
        />
      ) : null}
    </div>
  );
}

/** The technical detail of a caught error, for "Copy details" only. */
export function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
