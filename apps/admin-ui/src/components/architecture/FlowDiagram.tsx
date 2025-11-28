import { useEffect, useRef, useState } from 'react';
import { Card, Title, Text, Stack, TextInput, Group, Badge, SegmentedControl } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import cytoscape from 'cytoscape';
import type { Core, NodeSingular, NodeDataDefinition, EdgeDataDefinition } from 'cytoscape';


interface Capability {
  eventTypes: Array<{ type: string; hasSchema: boolean }>;
  handlers: Array<{ eventType: string; handlers: Array<{ name: string }> }>;
  tools: Array<{ name: string; description?: string }>;
}

interface FlowDiagramProps {
  capabilities: Capability;
}

export default function FlowDiagram({ capabilities }: FlowDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [layoutType, setLayoutType] = useState<'cose' | 'breadthfirst' | 'circle'>('cose');
  const [stats, setStats] = useState({ nodes: 0, edges: 0 });

  useEffect(() => {
    if (!containerRef.current) return;

    // Build graph data
    const nodes: Array<{ data: NodeDataDefinition }> = [];
    const edges: Array<{ data: EdgeDataDefinition }> = [];

    // Add event type nodes
    capabilities.eventTypes.forEach((et) => {
      nodes.push({
        data: {
          id: `event:${et.type}`,
          label: et.type,
          type: 'event',
          hasSchema: et.hasSchema,
        },
      });
    });

    // Add handler nodes and edges
    capabilities.handlers.forEach((handler) => {
      handler.handlers.forEach((h, idx) => {
        const handlerId = `handler:${handler.eventType}:${h.name}:${idx}`;
        nodes.push({
          data: {
            id: handlerId,
            label: h.name,
            type: 'handler',
          },
        });

        // Connect event to handler
        edges.push({
          data: {
            id: `${handler.eventType}-${handlerId}`,
            source: `event:${handler.eventType}`,
            target: handlerId,
            label: 'handles',
          },
        });
      });
    });

    // Add tool nodes (we'll infer connections based on naming conventions)
    capabilities.tools.forEach((tool) => {
      nodes.push({
        data: {
          id: `tool:${tool.name}`,
          label: tool.name,
          type: 'tool',
          description: tool.description,
        },
      });

      // Heuristic: Connect handlers to tools if handler name contains "AI" or similar patterns
      // This is a simplified approach - in production, you'd want explicit metadata
      capabilities.handlers.forEach((handler) => {
        handler.handlers.forEach((h, idx) => {
          const handlerId = `handler:${handler.eventType}:${h.name}:${idx}`;
          // If handler seems to use AI (contains "AI", "Chat", "Assistant" in name)
          if (
            h.name.toLowerCase().includes('ai') ||
            h.name.toLowerCase().includes('chat') ||
            h.name.toLowerCase().includes('assistant') ||
            h.name.toLowerCase().includes('conversation')
          ) {
            edges.push({
              data: {
                id: `${handlerId}-${tool.name}`,
                source: handlerId,
                target: `tool:${tool.name}`,
                label: 'uses',
              },
            });
          }
        });
      });
    });

    // Initialize Cytoscape
    const cy = cytoscape({
      container: containerRef.current,
      elements: [...nodes, ...edges],
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'text-valign': 'center',
            'text-halign': 'center',
            color: '#000',
            'font-size': '10px',
            width: '80px',
            height: '80px',
            'text-wrap': 'wrap',
            'text-max-width': '70px',
            'border-width': 2,
            'border-color': '#fff',
          },
        },
        {
          selector: 'node[type="event"]',
          style: {
            'background-color': '#228BE6',
            shape: 'ellipse',
            color: '#fff',
          },
        },
        {
          selector: 'node[type="handler"]',
          style: {
            'background-color': '#40C057',
            shape: 'rectangle',
            color: '#fff',
          },
        },
        {
          selector: 'node[type="tool"]',
          style: {
            'background-color': '#FD7E14',
            shape: 'diamond',
            color: '#fff',
          },
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': 4,
            'border-color': '#f76707',
          },
        },
        {
          selector: 'node.highlighted',
          style: {
            'background-color': '#E64980',
            'border-width': 4,
            'border-color': '#c2255c',
          },
        },
        {
          selector: 'edge',
          style: {
            width: 2,
            'line-color': '#ced4da',
            'target-arrow-color': '#ced4da',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            label: 'data(label)',
            'font-size': '8px',
            color: '#868e96',
            'text-rotation': 'autorotate',
          },
        },
        {
          selector: 'edge.highlighted',
          style: {
            'line-color': '#E64980',
            'target-arrow-color': '#E64980',
            width: 3,
          },
        },
      ],
      layout: {
        name: layoutType,
        animate: true,
        animationDuration: 500,
        padding: 50,
      },
    });

    // Event handlers - show tooltip on hover
    cy.on('tap', 'node', (evt) => {
      const node = evt.target as NodeSingular;
      // Highlight connected nodes and edges
      cy.elements().removeClass('highlighted');
      node.addClass('highlighted');
      node.connectedEdges().addClass('highlighted');
      node.neighborhood('node').addClass('highlighted');
    });

    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        // Clicked on background - clear highlights
        cy.elements().removeClass('highlighted');
      }
    });

    cyRef.current = cy;
    setStats({ nodes: nodes.length, edges: edges.length });

    // Cleanup
    return () => {
      cy.destroy();
    };
  }, [capabilities, layoutType]);

  // Search/filter functionality
  useEffect(() => {
    if (!cyRef.current) return;

    if (searchTerm.trim() === '') {
      cyRef.current.nodes().style('display', 'element');
      cyRef.current.edges().style('display', 'element');
      cyRef.current.elements().removeClass('highlighted');
      return;
    }

    const searchLower = searchTerm.toLowerCase();

    // Hide all nodes and edges first
    cyRef.current.elements().removeClass('highlighted');
    cyRef.current.nodes().style('display', 'none');
    cyRef.current.edges().style('display', 'none');

    // Show matching nodes
    const matchingNodes = cyRef.current.nodes().filter((node) => {
      const label = node.data('label')?.toLowerCase() || '';
      const description = node.data('description')?.toLowerCase() || '';
      return label.includes(searchLower) || description.includes(searchLower);
    });

    matchingNodes.style('display', 'element');
    matchingNodes.addClass('highlighted');

    // Show connected nodes and edges
    matchingNodes.neighborhood().style('display', 'element');
    matchingNodes.connectedEdges().style('display', 'element');
  }, [searchTerm]);

  return (
    <Card withBorder padding="md">
      <Stack gap="md">
        <Group justify="space-between">
          <div>
            <Title order={4}>Event Flow Architecture</Title>
            <Text size="sm" c="dimmed">
              {stats.nodes} components, {stats.edges} relationships
            </Text>
          </div>
          <SegmentedControl
            value={layoutType}
            onChange={(value) => setLayoutType(value as 'cose' | 'breadthfirst' | 'circle')}
            data={[
              { label: 'Auto', value: 'cose' },
              { label: 'Tree', value: 'breadthfirst' },
              { label: 'Circle', value: 'circle' },
            ]}
            size="xs"
          />
        </Group>

        <TextInput
          placeholder="Search events, handlers, or tools..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.currentTarget.value)}
          leftSection={<IconSearch size={16} />}
        />

        <Group gap="xs">
          <Badge variant="light" color="blue" leftSection="●">
            Events
          </Badge>
          <Badge variant="light" color="green" leftSection="■">
            Handlers
          </Badge>
          <Badge variant="light" color="orange" leftSection="◆">
            AI Tools
          </Badge>
        </Group>

        <div
          ref={containerRef}
          style={{
            width: '100%',
            height: '600px',
            border: '1px solid #dee2e6',
            borderRadius: '4px',
          }}
        />

        <Text size="xs" c="dimmed">
          Click on a node to highlight its connections. Use the search box to filter components.
          Layout can be changed using the controls above.
        </Text>
      </Stack>
    </Card>
  );
}
