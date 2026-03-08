import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import ReactFlow, {
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  BackgroundVariant,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  Stack,
  Title,
  Text,
  Group,
  Badge,
  Loader,
  Card,
  Drawer,
  Button,
} from "@mantine/core";
import { IconRefresh, IconArrowRight } from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import {
  EventNode,
  WorkerNode,
  N8nNode,
  ResourceNode,
  LangFlowNode,
} from "../../components/flow/CustomNodes";
import { colors, spacing, borderRadius } from "../../theme/tokens";

// Custom node types
const nodeTypes = {
  event: EventNode,
  worker: WorkerNode,
  n8n: N8nNode,
  resource: ResourceNode,
  langflow: LangFlowNode,
};

export default function FlowPageV3() {
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  // Fetch data
  const {
    data: system,
    isLoading: systemLoading,
    refetch,
  } = trpc.system.getCapabilities.useQuery();

  const { data: webhooks } = trpc.integrations.list.useQuery(undefined, {
    retry: false,
  });

  interface Worker {
    name: string;
    triggers?: string[];
  }
  interface Webhook {
    id: string;
    name: string;
    url?: string;
  }

  const webhookList = webhooks as Webhook[] | undefined;

  // Build nodes and edges
  const { initialNodes, initialEdges } = useMemo(() => {
    if (!system) return { initialNodes: [], initialEdges: [] };

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const yPosition = 50;

    // Event nodes (column 1)
    system.eventTypes.slice(0, 6).forEach((et, i) => {
      nodes.push({
        id: `event-${et.type}`,
        type: "event",
        position: { x: 50, y: yPosition + i * 70 },
        data: {
          label: et.type.split(".").slice(-2).join("."),
          fullType: et.type,
          category: "event",
        },
      });
    });

    // Worker nodes (column 2)
    const workers: Worker[] = (system as { workers?: Worker[] }).workers || [];
    workers.slice(0, 4).forEach((w, i) => {
      const nodeId = `worker-${w.name}`;
      nodes.push({
        id: nodeId,
        type: "worker",
        position: { x: 280, y: yPosition + i * 90 },
        data: {
          label: w.name,
          triggers: w.triggers,
          category: "worker",
        },
      });

      // Connect events to workers
      (w.triggers || []).forEach((t: string) => {
        if (nodes.find((n) => n.id === `event-${t}`)) {
          edges.push({
            id: `e-${t}-${w.name}`,
            source: `event-${t}`,
            target: nodeId,
            animated: true,
            style: { stroke: colors.eventTypes.created },
          });
        }
      });
    });

    // Resource nodes (column 3)
    const resources = [
      { id: "database", label: "PostgreSQL", type: "resource" },
      { id: "storage", label: "MinIO (S3)", type: "resource" },
      { id: "vector", label: "Vector DB", type: "resource" },
    ];
    resources.forEach((r, i) => {
      nodes.push({
        id: `resource-${r.id}`,
        type: "resource",
        position: { x: 520, y: yPosition + 50 + i * 100 },
        data: { label: r.label, category: "resource" },
      });
    });

    // n8n nodes (column 4)
    const n8nHooks = (webhookList || []).filter(
      (w) => w.url?.includes("n8n") || w.name?.toLowerCase().includes("n8n")
    );
    n8nHooks.slice(0, 3).forEach((wh, i) => {
      nodes.push({
        id: `n8n-${wh.id}`,
        type: "n8n",
        position: { x: 750, y: yPosition + 80 + i * 100 },
        data: {
          label: wh.name.replace(/n8n\s*[-:]/i, "").trim() || "Workflow",
          workflowUrl: "http://localhost:5678",
          webhookId: wh.id,
          category: "n8n",
        },
      });
    });

    // Connect workers to resources
    workers.slice(0, 3).forEach((_w, i) => {
      if (i < resources.length) {
        edges.push({
          id: `e-w${i}-r${i}`,
          source: `worker-${workers[i].name}`,
          target: `resource-${resources[i].id}`,
          style: { stroke: "#6c757d", strokeDasharray: "5,5" },
        });
      }
    });

    return { initialNodes: nodes, initialEdges: edges };
  }, [system, webhookList]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useMemo(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
    setDrawerOpen(true);
  }, []);

  const navigateToDetail = () => {
    if (!selectedNode) return;
    const category = selectedNode.data.category;
    switch (category) {
      case "event":
        navigate("/events");
        break;
      case "worker":
        navigate("/automation");
        break;
      case "resource":
        navigate("/data");
        break;
      case "n8n":
        window.open(selectedNode.data.workflowUrl, "_blank");
        break;
    }
    setDrawerOpen(false);
  };

  if (systemLoading) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          height: "80vh",
        }}
      >
        <Loader size="lg" />
      </div>
    );
  }

  return (
    <div style={{ width: "100%", padding: spacing[8] }}>
      <Stack gap={spacing[6]}>
        {/* Header */}
        <Group justify="space-between">
          <div>
            <Title order={1}>Data Pod Architecture</Title>
            <Text c="dimmed" size="sm">
              Visual overview of your event-driven system
            </Text>
          </div>
          <Button
            variant="light"
            leftSection={<IconRefresh size={16} />}
            onClick={() => refetch()}
          >
            Refresh
          </Button>
        </Group>

        {/* Flow Graph */}
        <Card
          padding={0}
          radius={borderRadius.lg}
          style={{
            border: `1px solid ${colors.border.default}`,
            height: "500px",
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.5}
            maxZoom={1.5}
          >
            <Controls position="bottom-left" />
            <MiniMap
              position="bottom-right"
              style={{ background: colors.background.secondary }}
              nodeBorderRadius={4}
            />
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          </ReactFlow>
        </Card>

        {/* Legend */}
        <Group gap="lg" justify="center">
          <Group gap={6}>
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: colors.eventTypes.created,
              }}
            />
            <Text size="xs">Events</Text>
          </Group>
          <Group gap={6}>
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: 4,
                background: colors.eventTypes.ai,
              }}
            />
            <Text size="xs">Workers</Text>
          </Group>
          <Group gap={6}>
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: 4,
                background: colors.semantic.success,
              }}
            />
            <Text size="xs">n8n</Text>
          </Group>
          <Group gap={6}>
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: 4,
                background: "#6c757d",
              }}
            />
            <Text size="xs">Resources</Text>
          </Group>
        </Group>
      </Stack>

      {/* Node Detail Drawer */}
      <Drawer
        opened={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={selectedNode?.data?.label || "Node Details"}
        position="right"
        size="md"
      >
        {selectedNode && (
          <Stack gap="md">
            <Card
              padding="md"
              radius="md"
              style={{ background: colors.background.secondary }}
            >
              <Text size="sm" fw={600} mb={4}>
                Type
              </Text>
              <Badge>{selectedNode.data.category}</Badge>
            </Card>

            {selectedNode.data.fullType && (
              <Card
                padding="md"
                radius="md"
                style={{ background: colors.background.secondary }}
              >
                <Text size="sm" fw={600} mb={4}>
                  Full Event Type
                </Text>
                <Text size="sm" c="dimmed">
                  {selectedNode.data.fullType}
                </Text>
              </Card>
            )}

            {selectedNode.data.triggers && (
              <Card
                padding="md"
                radius="md"
                style={{ background: colors.background.secondary }}
              >
                <Text size="sm" fw={600} mb={4}>
                  Triggers
                </Text>
                <Stack gap={4}>
                  {selectedNode.data.triggers.map((t: string) => (
                    <Badge key={t} variant="outline" size="sm">
                      {t}
                    </Badge>
                  ))}
                </Stack>
              </Card>
            )}

            <Button
              fullWidth
              rightSection={<IconArrowRight size={16} />}
              onClick={navigateToDetail}
            >
              {selectedNode.data.category === "n8n"
                ? "Open in n8n"
                : "Go to Details"}
            </Button>
          </Stack>
        )}
      </Drawer>
    </div>
  );
}
