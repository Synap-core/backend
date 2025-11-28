import { useState, useEffect } from 'react';
import {
  Modal,
  TextInput,
  Button,
  Stack,
  Group,
  Text,
  Badge,
  ScrollArea,
  ActionIcon,
} from '@mantine/core';
import { IconSearch, IconX, IconClock } from '@tabler/icons-react';
import { colors, spacing, typography } from '../../theme/tokens';

interface SearchModalProps {
  opened: boolean;
  onClose: () => void;
  onSearch: (value: string) => void;
  title?: string;
  placeholder?: string;
  label?: string;
  type?: 'user' | 'event' | 'mixed';
  history?: string[];
  presets?: Array<{ label: string; value: string }>;
}

export default function SearchModal({
  opened,
  onClose,
  onSearch,
  title = 'Search',
  placeholder = 'Enter search term...',
  label = 'Search',
  type = 'mixed',
  history = [],
  presets = [],
}: SearchModalProps) {
  const [searchValue, setSearchValue] = useState('');
  const [localHistory, setLocalHistory] = useState<string[]>([]);

  // Load history from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(`search-history-${type}`);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setLocalHistory(parsed);
      } catch {
        // Ignore parse errors
      }
    }
  }, [type]);

  // Combine localStorage history with prop history
  const allHistory = [...new Set([...localHistory, ...history])].slice(0, 10);

  const handleSearch = () => {
    if (!searchValue.trim()) return;

    // Save to history
    const newHistory = [searchValue, ...localHistory.filter((h) => h !== searchValue)].slice(0, 10);
    setLocalHistory(newHistory);
    localStorage.setItem(`search-history-${type}`, JSON.stringify(newHistory));

    onSearch(searchValue);
    setSearchValue('');
    onClose();
  };

  const handleHistoryClick = (value: string) => {
    setSearchValue(value);
  };

  const handlePresetClick = (value: string) => {
    setSearchValue(value);
  };

  const clearHistory = () => {
    setLocalHistory([]);
    localStorage.removeItem(`search-history-${type}`);
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={title}
      size="md"
      styles={{
        header: {
          borderBottom: `1px solid ${colors.border.default}`,
        },
      }}
    >
      <Stack gap={spacing[4]}>
        <TextInput
          label={label}
          placeholder={placeholder}
          value={searchValue}
          onChange={(e) => setSearchValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              handleSearch();
            }
          }}
          leftSection={<IconSearch size={16} />}
          rightSection={
            searchValue && (
              <ActionIcon
                variant="subtle"
                size="sm"
                onClick={() => setSearchValue('')}
                aria-label="Clear search"
              >
                <IconX size={14} />
              </ActionIcon>
            )
          }
          autoFocus
        />

        {presets.length > 0 && (
          <div>
            <Text size="xs" fw={typography.fontWeight.semibold} c={colors.text.tertiary} mb={spacing[2]}>
              PRESETS
            </Text>
            <Group gap={spacing[2]}>
              {presets.map((preset) => (
                <Badge
                  key={preset.value}
                  variant="light"
                  style={{ cursor: 'pointer' }}
                  onClick={() => handlePresetClick(preset.value)}
                >
                  {preset.label}
                </Badge>
              ))}
            </Group>
          </div>
        )}

        {allHistory.length > 0 && (
          <div>
            <Group justify="space-between" mb={spacing[2]}>
              <Text size="xs" fw={typography.fontWeight.semibold} c={colors.text.tertiary}>
                RECENT SEARCHES
              </Text>
              <Button
                variant="subtle"
                size="xs"
                onClick={clearHistory}
                aria-label="Clear history"
              >
                Clear
              </Button>
            </Group>
            <ScrollArea style={{ maxHeight: '200px' }}>
              <Stack gap={spacing[1]}>
                {allHistory.map((item, index) => (
                  <Group
                    key={index}
                    justify="space-between"
                    style={{
                      padding: spacing[2],
                      borderRadius: '4px',
                      cursor: 'pointer',
                      backgroundColor: colors.background.secondary,
                    }}
                    onClick={() => handleHistoryClick(item)}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = colors.background.secondary;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = colors.background.secondary;
                    }}
                  >
                    <Group gap={spacing[2]}>
                      <IconClock size={14} color={colors.text.tertiary} />
                      <Text size="sm">{item}</Text>
                    </Group>
                  </Group>
                ))}
              </Stack>
            </ScrollArea>
          </div>
        )}

        <Group justify="flex-end" mt={spacing[2]}>
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSearch} disabled={!searchValue.trim()}>
            Search
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

