/**
 * Loading skeletons — Hero UI Skeleton + shared layout classes.
 */

import { Card } from "@heroui/react";
import { Skeleton } from "@heroui/react";
import { borderRadius } from "../../theme/tokens";

export function MetricCardSkeleton() {
  return (
    <Card.Root className="border border-divider p-4">
      <div className="mb-2 flex items-center justify-between">
        <Skeleton className="h-4 w-24 rounded-medium" />
        <Skeleton className="h-5 w-5 rounded-full" />
      </div>
      <Skeleton className="mb-1 h-8 w-28 rounded-medium" />
      <Skeleton className="h-3 w-36 rounded-medium" />
    </Card.Root>
  );
}

export function EventListItemSkeleton() {
  return (
    <div
      className="flex items-center gap-3 rounded-medium border border-divider p-3"
      style={{ borderRadius: borderRadius.base }}
    >
      <Skeleton className="h-6 w-28 rounded-medium" />
      <div className="min-w-0 flex-1 space-y-1">
        <Skeleton className="h-3.5 w-[60%] rounded-medium" />
        <Skeleton className="h-3 w-[40%] rounded-medium" />
      </div>
      <Skeleton className="h-3 w-16 rounded-medium" />
    </div>
  );
}

export function SearchResultsSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <EventListItemSkeleton key={i} />
      ))}
    </div>
  );
}
