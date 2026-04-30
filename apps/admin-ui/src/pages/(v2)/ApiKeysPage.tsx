import { useState } from "react";
import {
  Button,
  Checkbox,
  Card,
  Chip,
  Input,
  Label,
  Modal,
  useOverlayState,
} from "@heroui/react";
import {
  IconKey,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconCopy,
  IconAlertCircle,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { spacing, typography } from "../../theme/tokens";

const HUB_SCOPES = [
  { value: "hub-protocol.read", label: "Hub: Read", group: "Hub" },
  { value: "hub-protocol.write", label: "Hub: Write", group: "Hub" },
  { value: "hub-protocol.admin", label: "Hub: Admin", group: "Hub" },
  { value: "data.read", label: "Data: Read", group: "Data" },
  { value: "data.write", label: "Data: Write", group: "Data" },
  { value: "mcp.read", label: "MCP: Read", group: "MCP" },
  { value: "mcp.write", label: "MCP: Write", group: "MCP" },
  { value: "mcp.connect", label: "MCP: Connect", group: "MCP" },
  { value: "setup.agent", label: "Setup: Agent provisioning", group: "Admin" },
];

/** Presets for common integrations — map to the exact scopes each needs. */
const INTEGRATION_PRESETS: {
  id: string;
  label: string;
  description: string;
  keyName: string;
  scopes: string[];
}[] = [
  {
    id: "raycast",
    label: "Raycast / launcher",
    description: "Hub read/write for quick actions against your pod",
    keyName: "Raycast",
    scopes: ["hub-protocol.read", "hub-protocol.write", "data.read"],
  },
  {
    id: "cli",
    label: "CLI / scripts",
    description: "Automation with Hub + data read/write",
    keyName: "CLI",
    scopes: [
      "hub-protocol.read",
      "hub-protocol.write",
      "data.read",
      "data.write",
    ],
  },
  {
    id: "openclaw",
    label: "OpenClaw / agents",
    description: "MCP + Hub for tool-using agents",
    keyName: "OpenClaw",
    scopes: [
      "hub-protocol.read",
      "hub-protocol.write",
      "mcp.connect",
      "data.read",
    ],
  },
  {
    id: "automation",
    label: "Automation provider",
    description:
      "For n8n, Zapier, custom scripts — can provision agents on this pod without PROVISIONING_TOKEN or Synap CP",
    keyName: "Automation provider",
    scopes: [
      "hub-protocol.read",
      "hub-protocol.write",
      "data.read",
      "setup.agent",
    ],
  },
];

function KeyPrefix({ prefix }: { prefix: string }) {
  return (
    <code className="rounded bg-default-100 px-1.5 py-0.5 font-mono text-xs text-default-600">
      {prefix}••••
    </code>
  );
}

function ScopeBadges({ scopes }: { scopes: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <Chip key={s} size="sm" variant="soft" color="accent">
          {s}
        </Chip>
      ))}
    </div>
  );
}

function SectionHeader({
  title,
  className,
}: {
  title: string;
  className?: string;
}) {
  return (
    <h2
      className={`mb-3 border-b border-divider pb-2 text-small font-semibold uppercase tracking-wide text-default-500 ${className ?? ""}`}
    >
      {title}
    </h2>
  );
}

export default function ApiKeysPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState("");
  const createModal = useOverlayState({
    isOpen: createOpen,
    onOpenChange: setCreateOpen,
  });

  const {
    data: myKeys,
    isLoading: myKeysLoading,
    refetch: refetchMy,
  } = trpc.apiKeys.list.useQuery();

  const {
    data: systemKeys,
    isLoading: systemKeysLoading,
    refetch: refetchSystem,
  } = trpc.apiKeys.listSystemKeys.useQuery();

  const createMutation = trpc.apiKeys.create.useMutation({
    onSuccess: (data) => {
      setNewKey(data.key);
      refetchMy();
      refetchSystem();
      showSuccessNotification({ message: "API key created successfully" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const revokeMutation = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      refetchMy();
      refetchSystem();
      showSuccessNotification({ message: "Key revoked" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const rotateMutation = trpc.apiKeys.rotate.useMutation({
    onSuccess: () => {
      refetchMy();
      refetchSystem();
      showSuccessNotification({
        message: "Key rotated — new key is shown once in the response",
      });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  function handleCreate() {
    if (!keyName.trim() || scopes.length === 0) return;
    createMutation.mutate({
      keyName: keyName.trim(),
      scope: scopes,
      expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
    });
  }

  function handleCloseCreate() {
    setCreateOpen(false);
    setNewKey(null);
    setKeyName("");
    setScopes([]);
    setExpiresInDays("");
  }

  function formatDate(d: Date | null | undefined) {
    if (!d) return "—";
    return new Date(d).toLocaleDateString();
  }

  const isHubKey = (prefix: string) => prefix.startsWith("synap_hub_");

  const allKeys = [
    ...(systemKeys ?? []),
    ...(myKeys ?? []).filter((k) => !systemKeys?.find((s) => s.id === k.id)),
  ];

  const hubKeys = allKeys.filter((k) => isHubKey(k.keyPrefix));
  const userKeys = allKeys.filter((k) => !isHubKey(k.keyPrefix));

  const isLoading = myKeysLoading || systemKeysLoading;

  function applyPreset(preset: (typeof INTEGRATION_PRESETS)[number]) {
    setKeyName(preset.keyName);
    setScopes([...preset.scopes]);
  }

  return (
    <div className="p-8" style={{ padding: spacing[8] }}>
      <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <IconKey size={22} className="text-secondary" />
            <h1 className="text-2xl font-bold text-foreground">API keys</h1>
          </div>
          <p className="max-w-xl text-small text-default-500">
            Create keys while signed in to this pod (Kratos session). They are
            user-scoped — use presets for common integrations, then refine
            scopes as needed.
          </p>
        </div>
        <Button
          variant="primary"
          onPress={() => setCreateOpen(true)}
          className="shrink-0"
        >
          <span className="inline-flex items-center gap-2">
            <IconPlus size={16} />
            Create key
          </span>
        </Button>
      </div>

      <Card.Root className="mb-8 border border-divider">
        <Card.Header>
          <Card.Title>Quick presets</Card.Title>
          <Card.Description>
            Same keys as you would mint from integrations — no separate agent
            provisioning endpoint required (Option A).
          </Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {INTEGRATION_PRESETS.map((p) => (
            <Button
              key={p.id}
              variant="outline"
              className="h-auto min-h-14 flex-col items-start gap-1 py-3 text-left"
              onPress={() => {
                applyPreset(p);
                setCreateOpen(true);
              }}
            >
              <span className="font-semibold">{p.label}</span>
              <span className="max-w-xs text-xs font-normal text-default-500">
                {p.description}
              </span>
            </Button>
          ))}
        </Card.Content>
      </Card.Root>

      {isLoading ? (
        <div className="flex justify-center py-16 text-default-400">
          Loading…
        </div>
      ) : (
        <div className="flex flex-col gap-10">
          {hubKeys.length > 0 && (
            <div>
              <SectionHeader title="Hub protocol keys" />
              <div className="overflow-x-auto rounded-large border border-divider">
                <table className="w-full min-w-[720px] text-left text-small">
                  <thead className="border-b border-divider bg-default-100 text-xs uppercase text-default-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">Prefix</th>
                      <th className="px-3 py-2 font-medium">Scopes</th>
                      <th className="px-3 py-2 font-medium">Usage</th>
                      <th className="px-3 py-2 font-medium">Last used</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hubKeys.map((k) => (
                      <tr
                        key={k.id}
                        className="border-b border-divider last:border-0"
                      >
                        <td className="px-3 py-2 font-medium">{k.keyName}</td>
                        <td className="px-3 py-2">
                          <KeyPrefix prefix={k.keyPrefix} />
                        </td>
                        <td className="px-3 py-2">
                          <ScopeBadges scopes={k.scope} />
                        </td>
                        <td className="px-3 py-2 text-default-500">
                          {k.usageCount}
                        </td>
                        <td className="px-3 py-2 text-default-500">
                          {formatDate(k.lastUsedAt)}
                        </td>
                        <td className="px-3 py-2">
                          <Chip
                            size="sm"
                            variant="soft"
                            color={k.isActive ? "success" : "danger"}
                          >
                            {k.isActive ? "Active" : "Revoked"}
                          </Chip>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex gap-1">
                            {k.isActive ? (
                              <>
                                <Button
                                  isIconOnly
                                  size="sm"
                                  variant="ghost"
                                  aria-label="Rotate key"
                                  isDisabled={rotateMutation.isPending}
                                  onPress={() =>
                                    rotateMutation.mutate({ keyId: k.id })
                                  }
                                >
                                  <IconRefresh size={14} />
                                </Button>
                                <Button
                                  isIconOnly
                                  size="sm"
                                  variant="ghost"
                                  aria-label="Revoke key"
                                  isDisabled={revokeMutation.isPending}
                                  onPress={() =>
                                    revokeMutation.mutate({ keyId: k.id })
                                  }
                                >
                                  <IconTrash size={14} />
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {userKeys.length > 0 && (
            <div>
              <SectionHeader title="Other keys" />
              <div className="overflow-x-auto rounded-large border border-divider">
                <table className="w-full min-w-[720px] text-left text-small">
                  <thead className="border-b border-divider bg-default-100 text-xs uppercase text-default-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">Prefix</th>
                      <th className="px-3 py-2 font-medium">Scopes</th>
                      <th className="px-3 py-2 font-medium">Usage</th>
                      <th className="px-3 py-2 font-medium">Last used</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userKeys.map((k) => (
                      <tr
                        key={k.id}
                        className="border-b border-divider last:border-0"
                      >
                        <td className="px-3 py-2 font-medium">{k.keyName}</td>
                        <td className="px-3 py-2">
                          <KeyPrefix prefix={k.keyPrefix} />
                        </td>
                        <td className="px-3 py-2">
                          <ScopeBadges scopes={k.scope} />
                        </td>
                        <td className="px-3 py-2 text-default-500">
                          {k.usageCount}
                        </td>
                        <td className="px-3 py-2 text-default-500">
                          {formatDate(k.lastUsedAt)}
                        </td>
                        <td className="px-3 py-2">
                          <Chip
                            size="sm"
                            variant="soft"
                            color={k.isActive ? "success" : "danger"}
                          >
                            {k.isActive ? "Active" : "Revoked"}
                          </Chip>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex gap-1">
                            {k.isActive ? (
                              <>
                                <Button
                                  isIconOnly
                                  size="sm"
                                  variant="ghost"
                                  aria-label="Rotate key"
                                  isDisabled={rotateMutation.isPending}
                                  onPress={() =>
                                    rotateMutation.mutate({ keyId: k.id })
                                  }
                                >
                                  <IconRefresh size={14} />
                                </Button>
                                <Button
                                  isIconOnly
                                  size="sm"
                                  variant="ghost"
                                  aria-label="Revoke key"
                                  isDisabled={revokeMutation.isPending}
                                  onPress={() =>
                                    revokeMutation.mutate({ keyId: k.id })
                                  }
                                >
                                  <IconTrash size={14} />
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {hubKeys.length === 0 && userKeys.length === 0 && (
            <p className="py-16 text-center text-default-400">
              No API keys yet. Use a preset or create a custom key.
            </p>
          )}
        </div>
      )}

      <Modal state={createModal}>
        <Modal.Backdrop isDismissable>
          <Modal.Container size="md" placement="center">
            <Modal.Dialog>
              <Modal.Header className="border-b border-divider px-5 py-4">
                <Modal.Heading className="text-lg font-semibold">
                  Create API key
                </Modal.Heading>
                <Modal.CloseTrigger className="absolute right-3 top-3" />
              </Modal.Header>
              <Modal.Body className="px-5 py-4">
                {newKey ? (
                  <div className="flex flex-col gap-4">
                    <div className="flex gap-2 rounded-medium border border-warning/30 bg-warning/10 p-3 text-warning">
                      <IconAlertCircle size={18} className="shrink-0" />
                      <div>
                        <p className="font-semibold">Save this key now</p>
                        <p className="text-xs opacity-90">
                          This key is shown only once. Copy it before you close.
                        </p>
                      </div>
                    </div>
                    <pre
                      className="overflow-x-auto rounded-medium border border-warning/30 bg-warning/10 p-4 font-mono text-sm text-warning"
                      style={{ fontFamily: typography.fontFamily.mono }}
                    >
                      {newKey}
                    </pre>
                    <Button
                      variant="outline"
                      onPress={() => {
                        void navigator.clipboard.writeText(newKey);
                        showSuccessNotification({
                          message: "Key copied to clipboard",
                        });
                      }}
                    >
                      <span className="inline-flex items-center gap-2">
                        <IconCopy size={16} />
                        Copy key
                      </span>
                    </Button>
                    <Button variant="primary" onPress={handleCloseCreate}>
                      Done
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-4">
                    <div>
                      <Label className="mb-1 block text-small font-medium">
                        Key name
                      </Label>
                      <Input
                        className="w-full"
                        value={keyName}
                        onChange={(e) => setKeyName(e.target.value)}
                        placeholder="e.g. Production Hub Key"
                      />
                    </div>
                    <div>
                      <Label className="mb-1 block text-small font-medium">
                        Scopes
                      </Label>
                      <div className="max-h-48 space-y-1 overflow-y-auto rounded-medium border border-divider p-2">
                        {HUB_SCOPES.map((s) => (
                          <div
                            key={s.value}
                            className="rounded-small px-2 py-1.5 hover:bg-default-100"
                          >
                            <Checkbox
                              isSelected={scopes.includes(s.value)}
                              onChange={(e) => {
                                if (e) {
                                  setScopes([...scopes, s.value]);
                                } else {
                                  setScopes(
                                    scopes.filter((x) => x !== s.value)
                                  );
                                }
                              }}
                            >
                              <span className="text-small">{s.label}</span>
                            </Checkbox>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <Label className="mb-1 block text-small font-medium">
                        Expires in days (optional)
                      </Label>
                      <Input
                        type="number"
                        min={1}
                        max={3650}
                        className="w-full"
                        value={expiresInDays}
                        onChange={(e) => setExpiresInDays(e.target.value)}
                        placeholder="No expiry"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="ghost" onPress={handleCloseCreate}>
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        isDisabled={
                          !keyName.trim() ||
                          scopes.length === 0 ||
                          createMutation.isPending
                        }
                        onPress={handleCreate}
                      >
                        {createMutation.isPending ? "Creating…" : "Create key"}
                      </Button>
                    </div>
                  </div>
                )}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}
