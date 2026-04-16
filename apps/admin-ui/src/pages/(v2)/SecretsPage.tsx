import { useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Chip,
  Spinner,
  Table,
  Tabs,
  Text,
} from "@heroui/react";
import { IconKey, IconShieldLock } from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";

/** Routers present at runtime but not yet in published `@synap-core/api-types`. */
const trpcX = trpc as any;

export default function SecretsPage() {
  const navigate = useNavigate();
  const systemKeysQuery = trpc.apiKeys.listSystemKeys.useQuery(undefined, {
    retry: false,
  });

  const hasVaultQuery = trpcX.secretsVault.hasVault.useQuery();
  const secretsListQuery = trpcX.secretsVault.list.useQuery(
    { limit: 100, offset: 0 },
    { enabled: hasVaultQuery.data === true }
  );
  const securityStatsQuery = trpcX.secretsVault.getSecurityStats.useQuery(
    undefined,
    { enabled: hasVaultQuery.data === true }
  );

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-8 p-8">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <IconShieldLock className="text-primary" size={24} />
          <Text className="text-2xl font-semibold tracking-tight text-foreground">
            Secrets & keys
          </Text>
        </div>
        <Text className="max-w-3xl text-small text-default-500">
          Metadata-only overview. Plaintext keys and vault ciphertext are never
          shown here. Pod-wide API key listing requires pod-admin access.
        </Text>
      </header>

      <Tabs.Root defaultSelectedKey="keys" orientation="horizontal">
        <Tabs.ListContainer>
          <Tabs.List className="mb-4 gap-1">
            <Tabs.Tab id="keys" className="px-3 py-2 text-sm">
              <span className="inline-flex items-center gap-1">
                <IconKey size={14} />
                API keys
              </span>
            </Tabs.Tab>
            <Tabs.Tab id="vault" className="px-3 py-2 text-sm">
              <span className="inline-flex items-center gap-1">
                <IconShieldLock size={14} />
                Personal vault
              </span>
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel id="keys" className="pt-1">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              onPress={() => {
                navigate("/api-keys");
              }}
            >
              Open Hub API keys
            </Button>
            <Text className="text-xs text-default-500">
              Create, rotate, and revoke keys in the full editor.
            </Text>
          </div>

          {systemKeysQuery.isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner color="accent" />
            </div>
          ) : systemKeysQuery.isError ? (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>Pod-wide key list restricted</Alert.Title>
                <Alert.Description>
                  Only members of the pod-admin workspace can list all API keys
                  on this pod. You can still manage your own keys on the Hub API
                  keys page.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : (
            <Table variant="secondary">
              <Table.ScrollContainer>
                <Table.Content aria-label="System keys table">
                  <Table.Header>
                    <Table.Column>Name</Table.Column>
                    <Table.Column>Prefix</Table.Column>
                    <Table.Column>Owner</Table.Column>
                    <Table.Column>Active</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {(systemKeysQuery.data ?? []).map((k) => (
                      <Table.Row key={k.id} id={k.id}>
                        <Table.Cell>
                          <span className="font-medium">{k.keyName}</span>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="font-mono text-xs">
                            {k.keyPrefix}
                          </span>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="text-xs text-default-600">
                            {k.user.email}
                          </span>
                        </Table.Cell>
                        <Table.Cell>
                          <Chip
                            size="sm"
                            variant="soft"
                            color={k.isActive ? "success" : "default"}
                          >
                            {k.isActive ? "active" : "inactive"}
                          </Chip>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          )}
        </Tabs.Panel>

        <Tabs.Panel id="vault" className="pt-1">
          {hasVaultQuery.isLoading ? (
            <Spinner color="accent" />
          ) : !hasVaultQuery.data ? (
            <Alert status="default">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>No vault for this account</Alert.Title>
                <Alert.Description>
                  When you create a vault in Synap Browser, metadata and
                  security stats will appear here. Secret values stay
                  client-encrypted.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : (
            <div className="flex flex-col gap-6">
              {securityStatsQuery.data ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Card.Root className="border border-divider p-3">
                    <Text className="text-xs text-default-500">
                      Compromised
                    </Text>
                    <Text className="text-xl font-semibold">
                      {securityStatsQuery.data.compromised}
                    </Text>
                  </Card.Root>
                  <Card.Root className="border border-divider p-3">
                    <Text className="text-xs text-default-500">
                      Weak passwords
                    </Text>
                    <Text className="text-xl font-semibold">
                      {securityStatsQuery.data.weakPasswords}
                    </Text>
                  </Card.Root>
                  <Card.Root className="border border-divider p-3">
                    <Text className="text-xs text-default-500">
                      Old (&gt;90d)
                    </Text>
                    <Text className="text-xl font-semibold">
                      {securityStatsQuery.data.oldPasswords}
                    </Text>
                  </Card.Root>
                  <Card.Root className="border border-divider p-3">
                    <Text className="text-xs text-default-500">
                      Listed (sample)
                    </Text>
                    <Text className="text-xl font-semibold">
                      {(secretsListQuery.data ?? []).length}
                    </Text>
                  </Card.Root>
                </div>
              ) : null}

              <Card.Root className="border border-divider">
                <Card.Header>
                  <Card.Title>Secret entries (metadata)</Card.Title>
                  <Card.Description>
                    Names and categories only — no encrypted payloads
                  </Card.Description>
                </Card.Header>
                <Card.Content>
                  {secretsListQuery.isLoading ? (
                    <Spinner size="sm" color="accent" />
                  ) : (
                    <ul className="max-h-80 space-y-2 overflow-y-auto">
                      {(secretsListQuery.data ?? []).map((s) => (
                        <li
                          key={s.id}
                          className="rounded-medium border border-divider px-3 py-2 text-sm"
                        >
                          <div className="font-medium">{s.name}</div>
                          <div className="text-xs text-default-500">
                            {s.type}
                            {s.category ? ` · ${s.category}` : ""}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card.Content>
              </Card.Root>
            </div>
          )}
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
