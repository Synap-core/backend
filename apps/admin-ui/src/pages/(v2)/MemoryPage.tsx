import { useState, useCallback } from "react";
import {
  Text,
  Button,
  TextInput,
  Modal,
  Table,
  ActionIcon,
  Group,
  Slider,
  Stack,
  Loader,
  Badge,
} from "@mantine/core";
import {
  IconBrain,
  IconPlus,
  IconTrash,
  IconSearch,
} from "@tabler/icons-react";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { colors, spacing } from "../../theme/tokens";

const API_URL = import.meta.env.VITE_API_URL || "";

interface MemoryFact {
  id: string;
  fact: string;
  confidence: number;
  userId: string;
  createdAt: string;
}

async function fetchFacts(
  userId: string,
  query: string,
  limit = 50
): Promise<MemoryFact[]> {
  const params = new URLSearchParams({ userId, limit: String(limit) });
  if (query.trim()) params.append("query", query.trim());
  const res = await fetch(`${API_URL}/api/hub/memory?${params}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Memory API error: ${res.statusText}`);
  return res.json();
}

async function deleteFact(factId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/hub/memory/${factId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Delete error: ${res.statusText}`);
}

async function createFact(
  userId: string,
  fact: string,
  confidence: number
): Promise<void> {
  const res = await fetch(`${API_URL}/api/hub/memory`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, fact, confidence }),
  });
  if (!res.ok) throw new Error(`Create error: ${res.statusText}`);
}

export default function MemoryPage() {
  const [userId, setUserId] = useState("");
  const [query, setQuery] = useState("");
  const [facts, setFacts] = useState<MemoryFact[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newFact, setNewFact] = useState("");
  const [newConfidence, setNewConfidence] = useState(0.8);
  const [addLoading, setAddLoading] = useState(false);

  const load = useCallback(async () => {
    if (!userId.trim()) return;
    setLoading(true);
    try {
      const data = await fetchFacts(userId.trim(), query);
      setFacts(data);
    } catch (err) {
      showErrorNotification({
        message:
          err instanceof Error ? err.message : "Failed to load memory facts",
      });
    } finally {
      setLoading(false);
    }
  }, [userId, query]);

  async function handleDelete(factId: string) {
    try {
      await deleteFact(factId);
      setFacts((prev) => prev?.filter((f) => f.id !== factId) ?? null);
      showSuccessNotification({ message: "Fact deleted" });
    } catch (err) {
      showErrorNotification({
        message: err instanceof Error ? err.message : "Failed to delete fact",
      });
    }
  }

  async function handleAdd() {
    if (!userId.trim() || !newFact.trim()) return;
    setAddLoading(true);
    try {
      await createFact(userId.trim(), newFact.trim(), newConfidence);
      showSuccessNotification({ message: "Fact added" });
      setAddOpen(false);
      setNewFact("");
      setNewConfidence(0.8);
      await load();
    } catch (err) {
      showErrorNotification({
        message: err instanceof Error ? err.message : "Failed to add fact",
      });
    } finally {
      setAddLoading(false);
    }
  }

  function confidenceColor(c: number) {
    if (c >= 0.8) return "green";
    if (c >= 0.5) return "yellow";
    return "red";
  }

  return (
    <div style={{ padding: spacing[6] }}>
      {/* Header */}
      <Group mb={spacing[6]}>
        <IconBrain size={22} color={colors.eventTypes.created} />
        <div>
          <Text size="xl" fw={700}>
            Memory
          </Text>
          <Text size="sm" c="dimmed">
            Inspect and manage AI knowledge facts.
          </Text>
        </div>
      </Group>

      {/* Search Bar */}
      <Group mb={spacing[4]} align="flex-end">
        <TextInput
          label="User ID"
          placeholder="user_..."
          value={userId}
          onChange={(e) => setUserId(e.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <TextInput
          label="Keyword search"
          placeholder="Search facts..."
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          leftSection={<IconSearch size={16} />}
          style={{ flex: 2 }}
        />
        <Button onClick={load} disabled={!userId.trim()} loading={loading}>
          Search
        </Button>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => setAddOpen(true)}
          disabled={!userId.trim()}
          color="violet"
        >
          Add Fact
        </Button>
      </Group>

      {/* Results */}
      {loading ? (
        <Loader />
      ) : facts === null ? (
        <Text c="dimmed" ta="center" py={spacing[10]}>
          Enter a user ID and search to view memory facts.
        </Text>
      ) : facts.length === 0 ? (
        <Text c="dimmed" ta="center" py={spacing[10]}>
          No facts found for this user.
        </Text>
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Fact</Table.Th>
              <Table.Th>Confidence</Table.Th>
              <Table.Th>Created</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {facts.map((f) => (
              <Table.Tr key={f.id}>
                <Table.Td style={{ maxWidth: 480 }}>
                  <Text size="sm">{f.fact}</Text>
                </Table.Td>
                <Table.Td>
                  <Badge size="xs" color={confidenceColor(f.confidence)}>
                    {Math.round(f.confidence * 100)}%
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {new Date(f.createdAt).toLocaleDateString()}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="red"
                    onClick={() => handleDelete(f.id)}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {/* Add Fact Modal */}
      <Modal
        opened={addOpen}
        onClose={() => setAddOpen(false)}
        title={
          <Text fw={600} size="lg">
            Add Memory Fact
          </Text>
        }
        size="md"
      >
        <Stack gap={spacing[4]}>
          <TextInput label="User ID" value={userId} readOnly disabled />
          <TextInput
            label="Fact"
            placeholder="Enter a fact about this user..."
            value={newFact}
            onChange={(e) => setNewFact(e.currentTarget.value)}
            required
          />
          <div>
            <Text size="sm" fw={500} mb={spacing[2]}>
              Confidence: {Math.round(newConfidence * 100)}%
            </Text>
            <Slider
              value={newConfidence * 100}
              onChange={(v) => setNewConfidence(v / 100)}
              min={0}
              max={100}
              step={5}
              marks={[
                { value: 0, label: "0%" },
                { value: 50, label: "50%" },
                { value: 100, label: "100%" },
              ]}
            />
          </div>
          <Button
            onClick={handleAdd}
            loading={addLoading}
            disabled={!newFact.trim()}
            fullWidth
          >
            Add Fact
          </Button>
        </Stack>
      </Modal>
    </div>
  );
}
