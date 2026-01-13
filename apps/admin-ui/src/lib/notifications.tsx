/**
 * Notification System
 *
 * Centralized notification utilities using Mantine's notification system.
 * Provides type-safe wrappers for showing success, error, warning, and info notifications.
 */

import { notifications } from "@mantine/notifications";
import {
  IconCheck,
  IconX,
  IconAlertCircle,
  IconInfoCircle,
} from "@tabler/icons-react";

interface NotificationOptions {
  title?: string;
  message: string;
  duration?: number;
  autoClose?: boolean;
}

/**
 * Show a success notification
 */
export function showSuccessNotification(options: NotificationOptions): void {
  notifications.show({
    title: options.title || "Success",
    message: options.message,
    color: "green",
    icon: <IconCheck size={18} />,
    autoClose: options.duration ?? 4000,
  });
}

/**
 * Show an error notification
 */
export function showErrorNotification(options: NotificationOptions): void {
  notifications.show({
    title: options.title || "Error",
    message: options.message,
    color: "red",
    icon: <IconX size={18} />,
    autoClose: options.duration ?? 6000,
  });
}

/**
 * Show a warning notification
 */
export function showWarningNotification(options: NotificationOptions): void {
  notifications.show({
    title: options.title || "Warning",
    message: options.message,
    color: "yellow",
    icon: <IconAlertCircle size={18} />,
    autoClose: options.duration ?? 5000,
  });
}

/**
 * Show an info notification
 */
export function showInfoNotification(options: NotificationOptions): void {
  notifications.show({
    title: options.title || "Info",
    message: options.message,
    color: "blue",
    icon: <IconInfoCircle size={18} />,
    autoClose: options.duration ?? 4000,
  });
}

/**
 * Show a notification for API errors
 * Extracts error message from tRPC/API errors
 */
export function showApiErrorNotification(
  error: unknown,
  options?: Omit<NotificationOptions, "message">,
): void {
  let errorMessage = "An unexpected error occurred";

  if (error instanceof Error) {
    errorMessage = error.message;
  } else if (
    typeof error === "object" &&
    error !== null &&
    "message" in error
  ) {
    errorMessage = String(error.message);
  } else if (typeof error === "string") {
    errorMessage = error;
  }

  showErrorNotification({
    ...options,
    message: errorMessage,
  });
}
