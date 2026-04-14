/**
 * Notifications via Hero UI toast (session-scoped, non-blocking).
 */

import { toast } from "@heroui/react";

interface NotificationOptions {
  title?: string;
  message: string;
  duration?: number;
  autoClose?: boolean;
}

function timeoutMs(
  options: NotificationOptions,
  fallback: number
): number | undefined {
  if (options.autoClose === false) return 0;
  return options.duration ?? fallback;
}

export function showSuccessNotification(options: NotificationOptions): void {
  toast.success(options.title ?? "Success", {
    description: options.message,
    timeout: timeoutMs(options, 4000),
  });
}

export function showErrorNotification(options: NotificationOptions): void {
  toast.danger(options.title ?? "Error", {
    description: options.message,
    timeout: timeoutMs(options, 6000),
  });
}

export function showWarningNotification(options: NotificationOptions): void {
  toast.warning(options.title ?? "Warning", {
    description: options.message,
    timeout: timeoutMs(options, 5000),
  });
}

export function showInfoNotification(options: NotificationOptions): void {
  toast.info(options.title ?? "Info", {
    description: options.message,
    timeout: timeoutMs(options, 4000),
  });
}

export function showApiErrorNotification(
  error: unknown,
  options?: Omit<NotificationOptions, "message">
): void {
  let errorMessage = "An unexpected error occurred";

  if (error instanceof Error) {
    errorMessage = error.message;
  } else if (
    typeof error === "object" &&
    error !== null &&
    "message" in error
  ) {
    errorMessage = String((error as { message: unknown }).message);
  } else if (typeof error === "string") {
    errorMessage = error;
  }

  showErrorNotification({
    ...options,
    message: errorMessage,
  });
}
