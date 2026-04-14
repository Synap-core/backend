import { useState } from "react";
import {
  Button,
  Card,
  Chip,
  Input,
  Label,
  Modal,
  Spinner,
  TextArea,
  Text,
  useOverlayState,
} from "@heroui/react";
import {
  IconBuildingCommunity,
  IconPlus,
  IconUsers,
  IconArrowRight,
} from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { trpc } from "../../lib/trpc";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { colors, spacing } from "../../theme/tokens";

const WORKSPACE_TYPE_COLORS: Record<string, "accent" | "success" | "warning"> =
  {
    personal: "accent",
    team: "success",
    enterprise: "warning",
  };

const ROLE_COLORS: Record<string, "accent" | "warning" | "accent" | "default"> =
  {
    owner: "accent",
    admin: "warning",
    editor: "accent",
    viewer: "default",
  };

export default function WorkspacesPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"personal" | "team" | "enterprise">("team");

  const createModal = useOverlayState({
    isOpen: createOpen,
    onOpenChange: setCreateOpen,
  });

  const {
    data: workspaces,
    isLoading,
    refetch,
  } = trpc.workspaces.list.useQuery();

  const createMutation = trpc.workspaces.create.useMutation({
    onSuccess: () => {
      refetch();
      setCreateOpen(false);
      setName("");
      setDescription("");
      setType("team");
      showSuccessNotification({ message: "Workspace created successfully" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  function handleCreate() {
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      description: description || undefined,
      type,
    });
  }

  return (
    <div style={{ padding: spacing[6] }}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <IconBuildingCommunity
              size={22}
              color={colors.eventTypes.created}
            />
            <Text className="text-xl font-bold">Workspaces</Text>
          </div>
          <Text className="text-sm text-default-500">
            Manage workspaces, members, and settings.
          </Text>
        </div>
        <Button variant="primary" onPress={() => createModal.open()}>
          <span className="inline-flex items-center gap-2">
            <IconPlus size={16} />
            New Workspace
          </span>
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner size="lg" color="accent" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces?.map((ws) => (
            <Card
              key={ws.id}
              className="cursor-pointer border border-divider transition-shadow hover:shadow-sm"
            >
              <div className="flex flex-col gap-3 p-5">
                <div className="flex items-start justify-between gap-2">
                  <Text className="flex-1 font-semibold">{ws.name}</Text>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={WORKSPACE_TYPE_COLORS[ws.type] ?? "default"}
                  >
                    {ws.type}
                  </Chip>
                </div>

                <Chip
                  size="sm"
                  variant="soft"
                  color={ROLE_COLORS[ws.role] ?? "default"}
                  className="self-start ring-1 ring-divider"
                >
                  {ws.role}
                </Chip>

                {ws.description && (
                  <Text className="line-clamp-2 text-sm text-default-500">
                    {ws.description}
                  </Text>
                )}

                <div className="flex flex-wrap items-center gap-4 text-xs text-default-500">
                  <div className="flex items-center gap-1">
                    <IconUsers size={14} color={colors.text.tertiary} />
                    <span>
                      {ws.settings?.intelligenceServiceId
                        ? "AI connected"
                        : "No AI service"}
                    </span>
                  </div>
                  <span>{new Date(ws.createdAt).toLocaleDateString()}</span>
                </div>

                <Link
                  to={`/workspaces/${ws.id}`}
                  className="mt-1 block w-full no-underline"
                >
                  <Button variant="ghost" fullWidth>
                    <span className="inline-flex w-full items-center justify-center gap-2">
                      Manage
                      <IconArrowRight size={14} />
                    </span>
                  </Button>
                </Link>
              </div>
            </Card>
          ))}

          {workspaces?.length === 0 && (
            <Text className="col-span-full py-10 text-center text-default-500">
              No workspaces found.
            </Text>
          )}
        </div>
      )}

      <Modal state={createModal}>
        <Modal.Backdrop isDismissable />
        <Modal.Container size="md" placement="center">
          <Modal.Dialog>
            <Modal.Header className="flex flex-col gap-1 border-b border-divider px-6 py-4">
              <Modal.Heading className="text-lg font-semibold">
                Create Workspace
              </Modal.Heading>
              <Modal.CloseTrigger className="absolute right-3 top-3" />
            </Modal.Header>
            <Modal.Body className="gap-4 px-6 py-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="ws-name">Name</Label>
                <Input
                  id="ws-name"
                  placeholder="My Team Workspace"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ws-desc">Description</Label>
                <TextArea
                  id="ws-desc"
                  placeholder="Optional description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ws-type">Type</Label>
                <select
                  id="ws-type"
                  className="border-default-200 bg-background text-foreground focus:border-accent focus:ring-accent w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  value={type}
                  onChange={(e) => setType(e.target.value as typeof type)}
                >
                  <option value="personal">Personal</option>
                  <option value="team">Team</option>
                  <option value="enterprise">Enterprise</option>
                </select>
              </div>
              <Button
                variant="primary"
                fullWidth
                onPress={handleCreate}
                isDisabled={!name.trim() || createMutation.isPending}
              >
                {createMutation.isPending ? (
                  <Spinner size="sm" color="current" />
                ) : (
                  "Create"
                )}
              </Button>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal>
    </div>
  );
}
