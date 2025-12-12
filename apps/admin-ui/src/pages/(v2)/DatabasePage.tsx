import { useState, useEffect } from 'react';
import {
  Title,
  Text,
  Stack,
  Card,
  Group,
  Select,
  Table,
  Button,
  Drawer,
  ScrollArea,
  Badge,
  Loader,
  Alert,
  Code,
  Tabs,
  SimpleGrid,
  ThemeIcon,
  Divider,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { 
  IconDatabase, IconRefresh, IconEye, IconAlertCircle,
  IconTable, IconSchema, IconLink, IconKey
} from '@tabler/icons-react';
import { colors, typography, spacing, borderRadius } from '../../theme/tokens';
import { AdminSDK } from '../../lib/sdk';

export default function DatabasePage() {
  const [activeTab, setActiveTab] = useState<string | null>('browse');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [selectedRow, setSelectedRow] = useState<any | null>(null);
  const pageSize = 50;

  // 1. Fetch list of tables
  const { data: tables, isLoading: isLoadingTables } = useQuery({
    queryKey: ['database', 'tables'],
    queryFn: () => AdminSDK.database.listTables(),
  });

  // Set default table on load
  useEffect(() => {
    if (tables && tables.length > 0 && !selectedTable) {
      setSelectedTable(tables[0].name as string);
    }
  }, [tables, selectedTable]);

  // 2. Fetch table data
  const { 
    data: tableRows, 
    isLoading: isLoadingRows, 
    isError: isErrorRows,
    error: rowsError,
    refetch 
  } = useQuery({
    queryKey: ['database', 'rows', selectedTable, page],
    queryFn: () => AdminSDK.database.getTableData(selectedTable!, (page - 1) * pageSize),
    enabled: !!selectedTable,
  });

  // Get current table info
  const currentTable = tables?.find((t: any) => t.name === selectedTable);
  
  // Extract columns from first row
  const columns = tableRows && tableRows.length > 0 
    ? Object.keys(tableRows[0]).slice(0, 5)
    : [];

  // Get all columns for schema view
  const allColumns = tableRows && tableRows.length > 0 
    ? Object.keys(tableRows[0])
    : [];

  return (
    <div style={{ width: '100%', padding: spacing[8] }}>
      <Stack gap={spacing[6]}>
        {/* Header */}
        <Group justify="space-between">
          <div>
            <Title order={1} style={{ fontFamily: typography.fontFamily.sans, color: colors.text.primary }}>
              Data
            </Title>
            <Text size="sm" style={{ color: colors.text.secondary }}>
              Database tables, schema & vectors
            </Text>
          </div>
          <Group>
            {isLoadingTables ? (
              <Loader size="sm" />
            ) : (
              <Select
                value={selectedTable}
                onChange={(val) => {
                  setSelectedTable(val);
                  setPage(1);
                }}
                data={tables?.map((t: any) => ({ 
                  value: t.name, 
                  label: `${t.name} (${t.estimated_rows ?? '0'} rows)` 
                })) || []}
                leftSection={<IconDatabase size={16} />}
                searchable
                placeholder="Select table"
                style={{ minWidth: 280 }}
              />
            )}
            <Button 
              variant="light" 
              leftSection={<IconRefresh size={16} />}
              onClick={() => refetch()}
              loading={isLoadingRows}
            >
              Refresh
            </Button>
          </Group>
        </Group>

        {isErrorRows && (
          <Alert icon={<IconAlertCircle size={16}/>} color="red" title="Error">
            {(rowsError as Error)?.message || 'Failed to fetch table data'}
          </Alert>
        )}

        {/* Tabs */}
        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            <Tabs.Tab value="browse" leftSection={<IconTable size={16} />}>
              Browse Data
            </Tabs.Tab>
            <Tabs.Tab value="schema" leftSection={<IconSchema size={16} />}>
              Schema
            </Tabs.Tab>
          </Tabs.List>

          {/* Browse Data Tab */}
          <Tabs.Panel value="browse" pt="md">
            <Card
              padding="md"
              radius={borderRadius.lg}
              style={{ border: `1px solid ${colors.border.default}`, minHeight: '400px' }}
            >
              {isLoadingRows ? (
                <Group justify="center" p="xl"><Loader /></Group>
              ) : (
                <Stack>
                  <ScrollArea>
                    <Table striped highlightOnHover>
                      <Table.Thead>
                        <Table.Tr>
                          {columns.map(col => (
                            <Table.Th key={col} style={{ whiteSpace: 'nowrap' }}>{col}</Table.Th>
                          ))}
                          <Table.Th>Actions</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {tableRows && tableRows.length > 0 ? (
                          tableRows.map((row: any, idx: number) => (
                            <Table.Tr key={idx}>
                              {columns.map(col => (
                                <Table.Td key={col}>
                                  <Text size="xs" truncate="end" style={{ maxWidth: '200px' }}>
                                    {typeof row[col] === 'object' ? JSON.stringify(row[col]) : String(row[col] ?? '')}
                                  </Text>
                                </Table.Td>
                              ))}
                              <Table.Td>
                                <Button 
                                  variant="subtle" 
                                  size="xs" 
                                  leftSection={<IconEye size={14} />}
                                  onClick={() => setSelectedRow(row)}
                                >
                                  View
                                </Button>
                              </Table.Td>
                            </Table.Tr>
                          ))
                        ) : (
                          <Table.Tr>
                            <Table.Td colSpan={columns.length + 1}>
                              <Text ta="center" c="dimmed" p="md">No data found</Text>
                            </Table.Td>
                          </Table.Tr>
                        )}
                      </Table.Tbody>
                    </Table>
                  </ScrollArea>
                  
                  {/* Pagination */}
                  <Group justify="flex-end">
                    <Button variant="subtle" size="xs" disabled={page === 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
                      Previous
                    </Button>
                    <Badge variant="light">Page {page}</Badge>
                    <Button variant="subtle" size="xs" disabled={!tableRows || tableRows.length < pageSize} onClick={() => setPage(p => p + 1)}>
                      Next
                    </Button>
                  </Group>
                </Stack>
              )}
            </Card>
          </Tabs.Panel>

          {/* Schema Tab */}
          <Tabs.Panel value="schema" pt="md">
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
              {/* Table Info */}
              <Card padding="md" radius={borderRadius.lg} style={{ border: `1px solid ${colors.border.default}` }}>
                <Group gap="sm" mb="md">
                  <ThemeIcon size={32} radius="md" color="blue" variant="light">
                    <IconDatabase size={18} />
                  </ThemeIcon>
                  <div>
                    <Text size="lg" fw={600}>{selectedTable}</Text>
                    <Text size="xs" c="dimmed">{String(currentTable?.estimated_rows ?? 0)} estimated rows</Text>
                  </div>
                </Group>

                <Divider mb="md" />

                <Text size="sm" fw={600} mb="sm">Columns ({allColumns.length})</Text>
                <Stack gap={4}>
                  {allColumns.map((col, idx) => (
                    <Group key={col} gap="xs" style={{
                      padding: `${spacing[2]} ${spacing[3]}`,
                      background: idx % 2 === 0 ? colors.background.secondary : 'transparent',
                      borderRadius: borderRadius.base,
                    }}>
                      {col === 'id' && <IconKey size={12} color={colors.eventTypes.created} />}
                      <Code style={{ fontSize: typography.fontSize.xs }}>{col}</Code>
                      {(col.endsWith('_id') || col.endsWith('Id')) && col !== 'id' && (
                        <Badge size="xs" variant="light" color="orange" leftSection={<IconLink size={8} />}>
                          FK
                        </Badge>
                      )}
                    </Group>
                  ))}
                  {allColumns.length === 0 && (
                    <Text size="sm" c="dimmed">Select a table to view schema</Text>
                  )}
                </Stack>
              </Card>

              {/* Tables Overview */}
              <Card padding="md" radius={borderRadius.lg} style={{ border: `1px solid ${colors.border.default}` }}>
                <Text size="sm" fw={600} mb="sm">All Tables ({tables?.length || 0})</Text>
                <ScrollArea style={{ maxHeight: 400 }}>
                  <Stack gap={4}>
                    {tables?.map((table: any) => (
                      <Group 
                        key={table.name} 
                        justify="space-between"
                        style={{
                          padding: `${spacing[2]} ${spacing[3]}`,
                          background: table.name === selectedTable ? `${colors.eventTypes.created}15` : colors.background.secondary,
                          borderRadius: borderRadius.base,
                          cursor: 'pointer',
                        }}
                        onClick={() => setSelectedTable(table.name)}
                      >
                        <Group gap="xs">
                          <IconTable size={14} color={table.name === selectedTable ? colors.eventTypes.created : colors.text.tertiary} />
                          <Text size="sm" fw={table.name === selectedTable ? 600 : 400}>{table.name}</Text>
                        </Group>
                        <Badge size="xs" variant="light" color="gray">{table.estimated_rows || 0}</Badge>
                      </Group>
                    ))}
                  </Stack>
                </ScrollArea>
              </Card>
            </SimpleGrid>
          </Tabs.Panel>
        </Tabs>
      </Stack>

      {/* Row Details Drawer */}
      <Drawer
        opened={!!selectedRow}
        onClose={() => setSelectedRow(null)}
        position="right"
        size="lg"
        title={
          <Group>
            <IconDatabase size={20} />
            <Text size="lg" fw={600}>Row Details</Text>
            <Badge>{selectedTable}</Badge>
          </Group>
        }
      >
        {selectedRow && (
          <ScrollArea style={{ height: 'calc(100vh - 100px)' }}>
            <Code block>{JSON.stringify(selectedRow, null, 2)}</Code>
          </ScrollArea>
        )}
      </Drawer>
    </div>
  );
}
