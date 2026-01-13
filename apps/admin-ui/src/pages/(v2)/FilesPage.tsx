import { useState } from "react";
import {
  Title,
  Text,
  Stack,
  Card,
  Group,
  Button,
  Table,
  Badge,
  ActionIcon,
  Breadcrumbs,
  Anchor,
  Loader,
  Alert,
  ScrollArea,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import {
  IconFolder,
  IconFile,
  IconDownload,
  IconTrash,
  IconRefresh,
  IconCloud,
  IconChevronRight,
  IconHome,
  IconAlertCircle,
} from "@tabler/icons-react";
import { colors, typography, spacing, borderRadius } from "../../theme/tokens";
import { trpc } from "../../lib/trpc";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";

// Format file size
function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// Format date
function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function FilesPage() {
  const [currentBucket, setCurrentBucket] = useState("synap-storage");
  const [currentPath, setCurrentPath] = useState<string[]>([]);

  // Fetch buckets
  const { data: bucketsData, isLoading: isLoadingBuckets } =
    trpc.storage.listBuckets.useQuery();

  // Fetch files
  const prefix = currentPath.length > 0 ? currentPath.join("/") + "/" : "";
  const {
    data: filesData,
    isLoading: isLoadingFiles,
    refetch,
  } = trpc.storage.listFiles.useQuery({
    bucket: currentBucket,
    prefix,
  });

  // Delete mutation
  const deleteMutation = trpc.storage.deleteFile.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: "File deleted successfully" });
      refetch();
    },
    onError: (err) => {
      showErrorNotification({ message: err.message });
    },
  });

  const handleNavigate = (folderName: string) => {
    setCurrentPath([...currentPath, folderName]);
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index < 0) {
      setCurrentPath([]);
    } else {
      setCurrentPath(currentPath.slice(0, index + 1));
    }
  };

  const handleDownload = async (path: string) => {
    // Open download URL in new tab
    window.open(
      `${import.meta.env.VITE_API_URL || ""}/api/files/download?path=${encodeURIComponent(path)}`,
      "_blank",
    );
  };

  const handleDelete = (path: string) => {
    if (confirm("Are you sure you want to delete this file?")) {
      deleteMutation.mutate({ path });
    }
  };

  const buckets = bucketsData?.buckets || [];
  const items = filesData?.items || [];
  const hasError = "error" in (filesData || {});

  return (
    <div style={{ width: "100%", padding: spacing[8] }}>
      <Stack gap={spacing[6]}>
        {/* Header */}
        <Group justify="space-between">
          <div>
            <Title
              order={1}
              style={{
                fontFamily: typography.fontFamily.sans,
                color: colors.text.primary,
              }}
            >
              Files
            </Title>
            <Text size="sm" style={{ color: colors.text.secondary }}>
              Browse and manage files in storage
            </Text>
          </div>
          <Button
            variant="light"
            leftSection={<IconRefresh size={16} />}
            onClick={() => refetch()}
            loading={isLoadingFiles}
          >
            Refresh
          </Button>
        </Group>

        {/* Main Content */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "200px 1fr",
            gap: spacing[4],
          }}
        >
          {/* Buckets Sidebar */}
          <Card
            padding="md"
            radius={borderRadius.lg}
            style={{ border: `1px solid ${colors.border.default}` }}
          >
            <Text size="sm" fw={600} mb="sm">
              Buckets
            </Text>
            {isLoadingBuckets ? (
              <Loader size="sm" />
            ) : (
              <Stack gap={4}>
                {buckets.length > 0 ? (
                  buckets.map((bucket) => (
                    <Button
                      key={bucket.name}
                      variant={
                        currentBucket === bucket.name ? "light" : "subtle"
                      }
                      size="xs"
                      fullWidth
                      justify="flex-start"
                      leftSection={<IconCloud size={14} />}
                      onClick={() => {
                        setCurrentBucket(bucket.name);
                        setCurrentPath([]);
                      }}
                    >
                      {bucket.name}
                    </Button>
                  ))
                ) : (
                  <Text size="xs" c="dimmed">
                    No buckets found
                  </Text>
                )}
              </Stack>
            )}
          </Card>

          {/* Files Area */}
          <Card
            padding="md"
            radius={borderRadius.lg}
            style={{ border: `1px solid ${colors.border.default}` }}
          >
            {/* Breadcrumbs */}
            <Group mb="md">
              <Breadcrumbs separator={<IconChevronRight size={14} />}>
                <Anchor
                  size="sm"
                  onClick={() => handleBreadcrumbClick(-1)}
                  style={{ cursor: "pointer" }}
                >
                  <Group gap={4}>
                    <IconHome size={14} />
                    {currentBucket}
                  </Group>
                </Anchor>
                {currentPath.map((segment, index) => (
                  <Anchor
                    key={index}
                    size="sm"
                    onClick={() => handleBreadcrumbClick(index)}
                    style={{ cursor: "pointer" }}
                  >
                    {segment}
                  </Anchor>
                ))}
              </Breadcrumbs>
            </Group>

            {/* Error Alert */}
            {hasError && (
              <Alert icon={<IconAlertCircle size={16} />} color="red" mb="md">
                {(filesData as any).error || "Failed to load files"}
              </Alert>
            )}

            {/* Files Table */}
            {isLoadingFiles ? (
              <Group justify="center" py="xl">
                <Loader />
              </Group>
            ) : (
              <ScrollArea style={{ maxHeight: "500px" }}>
                <Table highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Name</Table.Th>
                      <Table.Th>Size</Table.Th>
                      <Table.Th>Modified</Table.Th>
                      <Table.Th style={{ width: "100px" }}>Actions</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {items.length > 0 ? (
                      items.map((item) => (
                        <Table.Tr
                          key={item.path}
                          style={{
                            cursor:
                              item.type === "folder" ? "pointer" : "default",
                          }}
                          onClick={() =>
                            item.type === "folder" && handleNavigate(item.name)
                          }
                        >
                          <Table.Td>
                            <Group gap="xs">
                              <ThemeIcon
                                size={24}
                                radius="sm"
                                color={item.type === "folder" ? "blue" : "gray"}
                                variant="light"
                              >
                                {item.type === "folder" ? (
                                  <IconFolder size={14} />
                                ) : (
                                  <IconFile size={14} />
                                )}
                              </ThemeIcon>
                              <Text
                                size="sm"
                                fw={item.type === "folder" ? 500 : 400}
                              >
                                {item.name}
                              </Text>
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm" c="dimmed">
                              {item.type === "file"
                                ? formatSize((item as any).size || 0)
                                : "-"}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm" c="dimmed">
                              {item.type === "file"
                                ? formatDate((item as any).lastModified)
                                : "-"}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            {item.type === "file" && (
                              <Group gap={4}>
                                <Tooltip label="Download">
                                  <ActionIcon
                                    variant="subtle"
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDownload(item.path);
                                    }}
                                  >
                                    <IconDownload size={14} />
                                  </ActionIcon>
                                </Tooltip>
                                <Tooltip label="Delete">
                                  <ActionIcon
                                    variant="subtle"
                                    color="red"
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDelete(item.path);
                                    }}
                                    loading={deleteMutation.isPending}
                                  >
                                    <IconTrash size={14} />
                                  </ActionIcon>
                                </Tooltip>
                              </Group>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))
                    ) : (
                      <Table.Tr>
                        <Table.Td colSpan={4}>
                          <Text ta="center" c="dimmed" py="xl">
                            No files in this location
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}

            {/* Stats */}
            <Group mt="md" gap="xs">
              <Badge variant="light" color="gray">
                {items.filter((i) => i.type === "folder").length} folders
              </Badge>
              <Badge variant="light" color="gray">
                {items.filter((i) => i.type === "file").length} files
              </Badge>
            </Group>
          </Card>
        </div>
      </Stack>
    </div>
  );
}
