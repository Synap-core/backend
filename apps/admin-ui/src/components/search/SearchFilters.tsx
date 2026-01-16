import {
  Card,
  Stack,
  TextInput,
  Select,
  Group,
  Button,
  NumberInput,
  Grid,
  Collapse,
  Text,
} from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import {
  IconSearch,
  IconFilterOff,
  IconChevronDown,
  IconChevronUp,
} from "@tabler/icons-react";
import { useState } from "react";

export interface SearchFiltersState {
  userId?: string;
  eventType?: string;
  subjectType?: string;
  subjectId?: string;
  correlationId?: string;
  fromDate?: Date;
  toDate?: Date;
  limit: number;
  offset: number;
}

interface SearchFiltersProps {
  onSearch: (filters: SearchFiltersState) => void;
  onReset: () => void;
  isLoading?: boolean;
  eventTypes: string[];
}

export default function SearchFilters({
  onSearch,
  onReset,
  isLoading,
  eventTypes,
}: SearchFiltersProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [filters, setFilters] = useState<SearchFiltersState>({
    limit: 50,
    offset: 0,
  });

  const handleSearch = () => {
    onSearch(filters);
  };

  const handleReset = () => {
    setFilters({
      limit: 50,
      offset: 0,
    });
    onReset();
  };

  const updateFilter = <K extends keyof SearchFiltersState>(
    key: K,
    value: SearchFiltersState[K]
  ) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <Card withBorder padding="md">
      <Stack gap="md">
        <Text fw={500} size="sm">
          Search Filters
        </Text>

        {/* Basic Filters */}
        <Grid>
          <Grid.Col span={{ base: 12, sm: 6 }}>
            <TextInput
              label="User ID"
              placeholder="Enter user ID..."
              value={filters.userId || ""}
              onChange={(e) =>
                updateFilter("userId", e.currentTarget.value || undefined)
              }
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6 }}>
            <Select
              label="Event Type"
              placeholder="Select event type..."
              data={eventTypes.map((et) => ({ value: et, label: et }))}
              value={filters.eventType || null}
              onChange={(value) =>
                updateFilter("eventType", value || undefined)
              }
              searchable
              clearable
            />
          </Grid.Col>
        </Grid>

        {/* Advanced Filters Toggle */}
        <Button
          variant="subtle"
          size="xs"
          onClick={() => setShowAdvanced(!showAdvanced)}
          rightSection={
            showAdvanced ? (
              <IconChevronUp size={14} />
            ) : (
              <IconChevronDown size={14} />
            )
          }
        >
          {showAdvanced ? "Hide" : "Show"} Advanced Filters
        </Button>

        <Collapse in={showAdvanced}>
          <Stack gap="md">
            <Grid>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <TextInput
                  label="Aggregate Type"
                  placeholder="e.g., note, task, conversation..."
                  value={filters.subjectType || ""}
                  onChange={(e) =>
                    updateFilter(
                      "subjectType",
                      e.currentTarget.value || undefined
                    )
                  }
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <TextInput
                  label="Aggregate ID"
                  placeholder="Enter aggregate ID..."
                  value={filters.subjectId || ""}
                  onChange={(e) =>
                    updateFilter(
                      "subjectId",
                      e.currentTarget.value || undefined
                    )
                  }
                />
              </Grid.Col>
            </Grid>

            <TextInput
              label="Correlation ID"
              placeholder="Enter correlation ID..."
              value={filters.correlationId || ""}
              onChange={(e) =>
                updateFilter(
                  "correlationId",
                  e.currentTarget.value || undefined
                )
              }
            />

            <Grid>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <DateTimePicker
                  label="From Date"
                  placeholder="Select start date..."
                  value={filters.fromDate || null}
                  onChange={(value) =>
                    updateFilter(
                      "fromDate",
                      value as unknown as Date | undefined
                    )
                  }
                  clearable
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <DateTimePicker
                  label="To Date"
                  placeholder="Select end date..."
                  value={filters.toDate || null}
                  onChange={(value) =>
                    updateFilter("toDate", value as unknown as Date | undefined)
                  }
                  clearable
                />
              </Grid.Col>
            </Grid>

            <Grid>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <NumberInput
                  label="Result Limit"
                  description="Max results to return (1-1000)"
                  placeholder="50"
                  value={filters.limit}
                  onChange={(value) =>
                    updateFilter("limit", Number(value) || 50)
                  }
                  min={1}
                  max={1000}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <NumberInput
                  label="Result Offset"
                  description="Skip first N results"
                  placeholder="0"
                  value={filters.offset}
                  onChange={(value) =>
                    updateFilter("offset", Number(value) || 0)
                  }
                  min={0}
                />
              </Grid.Col>
            </Grid>
          </Stack>
        </Collapse>

        {/* Action Buttons */}
        <Group justify="flex-end">
          <Button
            variant="subtle"
            onClick={handleReset}
            leftSection={<IconFilterOff size={16} />}
            disabled={isLoading}
          >
            Reset
          </Button>
          <Button
            onClick={handleSearch}
            leftSection={<IconSearch size={16} />}
            loading={isLoading}
          >
            Search
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
