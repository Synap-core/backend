import { useEffect, useRef, useState } from "react";
import { Card, Title, Text, Stack, Alert } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import cytoscape from "cytoscape";
import type { Core, EdgeDataDefinition, NodeSingular } from "cytoscape";

interface CorrelationGraphProps {
  events: Array<{
    id: string;
    type: string;
    timestamp: string;
    causationId?: string | null;
    correlationId?: string | null;
  }>;
  onEventClick?: (eventId: string) => void;
  highlightedEventId?: string;
}

export default function CorrelationGraph({
  events,
  onEventClick,
  highlightedEventId,
}: CorrelationGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [stats, setStats] = useState({ nodes: 0, edges: 0 });

  useEffect(() => {
    if (!containerRef.current || events.length === 0) return;

    // Build graph data
    const nodes = events.map((event) => ({
      data: {
        id: event.id,
        label: event.type,
        timestamp: event.timestamp,
      },
    }));

    const edges: Array<{ data: EdgeDataDefinition }> = [];
    events.forEach((event) => {
      if (event.causationId) {
        // Check if causation event exists in the set
        const causationExists = events.some((e) => e.id === event.causationId);
        if (causationExists) {
          edges.push({
            data: {
              id: `${event.causationId}-${event.id}`,
              source: event.causationId,
              target: event.id,
              label: "caused",
            },
          });
        }
      }
    });

    // Initialize Cytoscape
    const cy = cytoscape({
      container: containerRef.current,
      elements: [...nodes, ...edges],
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#228BE6",
            label: "data(label)",
            "text-valign": "center",
            "text-halign": "center",
            color: "#fff",
            "font-size": "10px",
            width: "60px",
            height: "60px",
            "text-wrap": "wrap",
            "text-max-width": "50px",
          },
        },
        {
          selector: "node:selected",
          style: {
            "background-color": "#fd7e14",
            "border-width": 3,
            "border-color": "#f76707",
          },
        },
        {
          selector: "edge",
          style: {
            width: 2,
            "line-color": "#dee2e6",
            "target-arrow-color": "#dee2e6",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": "8px",
            color: "#868e96",
            "text-rotation": "autorotate",
          },
        },
      ],
      layout: {
        name: "breadthfirst",
        directed: true,
        spacingFactor: 1.5,
        animate: true,
        animationDuration: 500,
      },
    });

    // Event handlers
    cy.on("tap", "node", (evt) => {
      const node = evt.target as NodeSingular;
      const eventId = node.id();
      if (onEventClick) {
        onEventClick(eventId);
      }
    });

    cyRef.current = cy;
    setStats({ nodes: nodes.length, edges: edges.length });

    // Cleanup
    return () => {
      cy.destroy();
    };
  }, [events, onEventClick]);

  // Highlight selected node
  useEffect(() => {
    if (!cyRef.current || !highlightedEventId) return;

    cyRef.current.nodes().unselect();
    const node = cyRef.current.getElementById(highlightedEventId);
    if (node.length > 0) {
      node.select();
      cyRef.current.center(node);
    }
  }, [highlightedEventId]);

  if (events.length === 0) {
    return (
      <Alert icon={<IconInfoCircle size={16} />} title="No Events" color="blue">
        No events to visualize. Search for events by correlation ID to see the
        event flow graph.
      </Alert>
    );
  }

  return (
    <Card withBorder padding="md">
      <Stack gap="md">
        <div>
          <Title order={4}>Event Flow Graph</Title>
          <Text size="sm" c="dimmed">
            {stats.nodes} events, {stats.edges} causal relationships
          </Text>
        </div>
        <div
          ref={containerRef}
          style={{
            width: "100%",
            height: "500px",
            border: "1px solid #dee2e6",
            borderRadius: "4px",
          }}
        />
        <Text size="xs" c="dimmed">
          Click on a node to view event details. Arrows show causation
          relationships (A → B means "A caused B").
        </Text>
      </Stack>
    </Card>
  );
}
