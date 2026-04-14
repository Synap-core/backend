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
        aria-label="Open command palette"
        onPress={onPress}
      >
        <IconSearch size={18} />
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      className="justify-between"
      onPress={onPress}
      aria-label="Open command palette"
    >
      <span className="inline-flex items-center gap-2">
        <IconSearch size={16} />
        Search & Commands
      </span>
      <span className="inline-flex items-center gap-1 rounded-small bg-default-100 px-2 py-0.5 text-xs text-default-500">
        <IconCommand size={12} />K
      </span>
    </Button>
  );
}
