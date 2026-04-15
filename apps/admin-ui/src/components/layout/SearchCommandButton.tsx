import { Button } from "@heroui/react";
import { IconCommand, IconSearch } from "@tabler/icons-react";

interface SearchCommandButtonProps {
  onPress?: () => void;
  /** Icon-only trigger (header). */
  compact?: boolean;
  /** Narrow sidebar rail: same as compact. */
  railOnly?: boolean;
}

export default function SearchCommandButton({
  onPress,
  compact = false,
  railOnly = false,
}: SearchCommandButtonProps) {
  if (compact || railOnly) {
    return (
      <Button
        isIconOnly
        variant="ghost"
        className="h-10 w-10 rounded-2xl border border-divider bg-default-50 text-default-600 shadow-sm hover:bg-default-100"
        aria-label="Open command palette"
        onPress={onPress}
      >
        <IconSearch size={18} />
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      className="h-10 w-full justify-between rounded-2xl border border-divider bg-default-50 px-3 text-default-700 shadow-sm hover:bg-default-100"
      onPress={onPress}
      aria-label="Open command palette"
    >
      <span className="inline-flex items-center gap-2">
        <IconSearch size={16} />
        Search
      </span>
      <span className="inline-flex items-center gap-1 rounded-lg border border-divider bg-content1 px-1.5 py-0.5 text-[10px] text-default-500">
        <IconCommand size={11} />K
      </span>
    </Button>
  );
}
