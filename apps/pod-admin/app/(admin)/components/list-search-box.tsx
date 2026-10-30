"use client";

/**
 * The search box over a list that loads whole. The typed value is debounced
 * (`SEARCH_DEBOUNCE_MS`, as Marketplace's) before it reaches the list, so
 * typing never re-filters a long list on each key. The filtering itself is
 * `filterBySearch` (`list-search.ts`).
 */

import { Input } from "@heroui/react";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { SEARCH_DEBOUNCE_MS } from "./list-search";

/** The text to filter by, trailing the box by the debounce. */
export function useDebouncedQuery(): {
  input: string;
  setInput: (value: string) => void;
  query: string;
} {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);
  return { input, setInput, query };
}

export function ListSearch({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Placeholder and accessible name: the catalog's `listSearch.<list>`. */
  label: string;
}) {
  return (
    <Input
      aria-label={label}
      placeholder={label}
      value={value}
      onValueChange={onChange}
      size="sm"
      radius="md"
      variant="bordered"
      startContent={<Search size={14} className="text-foreground/40" />}
      className="mb-3 max-w-md"
    />
  );
}
