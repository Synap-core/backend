/** A read that failed, said in one red line. */

import { AlertTriangle } from "lucide-react";

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-medium ring-1 ring-inset ring-status-down/30 bg-status-down/[0.06] px-3 py-2.5">
      <AlertTriangle
        className="h-3.5 w-3.5 shrink-0 text-status-down"
        strokeWidth={2}
        aria-hidden
      />
      <span className="text-[12.5px] font-medium text-status-down">
        {message}
      </span>
    </div>
  );
}
