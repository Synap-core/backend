import { useState } from "react";
import { IconSearch, IconX, IconClock } from "@tabler/icons-react";
import { Button } from "@heroui/react";
import { spacing } from "../../theme/tokens";

interface SearchModalProps {
  opened: boolean;
  onClose: () => void;
  onSearch: (value: string) => void;
  title?: string;
  placeholder?: string;
  label?: string;
  type?: "user" | "event" | "mixed";
  history?: string[];
  presets?: Array<{ label: string; value: string }>;
}

export default function SearchModal({
  opened,
  onClose,
  onSearch,
  title = "Search",
  placeholder = "Enter search term...",
  label = "Search",
  type = "mixed",
  history = [],
  presets = [],
}: SearchModalProps) {
  const [searchValue, setSearchValue] = useState("");
  const [localHistory, setLocalHistory] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(`search-history-${type}`);
      return stored ? (JSON.parse(stored) as string[]) : [];
    } catch {
      return [];
    }
  });

  const allHistory = [...new Set([...localHistory, ...history])].slice(0, 10);

  const handleSearch = () => {
    if (!searchValue.trim()) return;

    const newHistory = [
      searchValue,
      ...localHistory.filter((h) => h !== searchValue),
    ].slice(0, 10);
    setLocalHistory(newHistory);
    localStorage.setItem(`search-history-${type}`, JSON.stringify(newHistory));

    onSearch(searchValue);
    setSearchValue("");
    onClose();
  };

  const clearHistory = () => {
    setLocalHistory([]);
    localStorage.removeItem(`search-history-${type}`);
  };

  if (!opened) return null;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-divider bg-content1 p-0 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="border-b border-divider px-5 py-4"
          style={{ padding: `${spacing[4]} ${spacing[5]}` }}
        >
          <h2
            id="search-modal-title"
            className="text-lg font-semibold text-foreground"
          >
            {title}
          </h2>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="search-modal-input"
              className="text-small font-medium text-default-600"
            >
              {label}
            </label>
            <div className="relative flex items-center">
              <IconSearch
                className="pointer-events-none absolute left-3 text-default-400"
                size={16}
              />
              <input
                id="search-modal-input"
                type="text"
                className="w-full rounded-medium border border-divider bg-default-100 py-2 pl-9 pr-10 text-small text-foreground outline-none ring-primary focus:border-primary focus:ring-2"
                placeholder={placeholder}
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSearch();
                }}
                autoFocus
              />
              {searchValue ? (
                <button
                  type="button"
                  className="absolute right-2 rounded-full p-1 text-default-400 hover:bg-default-200"
                  aria-label="Clear search"
                  onClick={() => setSearchValue("")}
                >
                  <IconX size={14} />
                </button>
              ) : null}
            </div>
          </div>

          {presets.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-default-400">
                Presets
              </p>
              <div className="flex flex-wrap gap-2">
                {presets.map((preset) => (
                  <Button
                    key={preset.value}
                    size="sm"
                    variant="outline"
                    onPress={() => setSearchValue(preset.value)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          {allHistory.length > 0 ? (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-default-400">
                  Recent
                </p>
                <Button size="sm" variant="ghost" onPress={clearHistory}>
                  Clear
                </Button>
              </div>
              <div
                className="max-h-[200px] space-y-1 overflow-y-auto rounded-medium border border-divider bg-default-50 p-1"
                style={{ maxHeight: 200 }}
              >
                {allHistory.map((item, index) => (
                  <button
                    key={index}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-small px-2 py-2 text-left text-small text-default-700 hover:bg-default-100"
                    onClick={() => setSearchValue(item)}
                  >
                    <IconClock
                      size={14}
                      className="shrink-0 text-default-400"
                    />
                    <span className="truncate">{item}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onPress={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onPress={handleSearch}
              isDisabled={!searchValue.trim()}
            >
              Search
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
