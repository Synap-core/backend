import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import {
  Alert,
  Button,
  Card,
  Chip,
  Input,
  Separator,
  Spinner,
  Switch,
  Text,
} from "@heroui/react";
import {
  IconChevronRight,
  IconFileText,
  IconLink as IconLinkTabler,
  IconSearch,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import { useWorkspace } from "../../lib/workspace";

function isProbablyExternal(href: string) {
  return /^https?:\/\//i.test(href);
}

/** Routers present at runtime but not yet in published `@synap-core/api-types`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const trpcX = trpc as any;

export default function DocumentsPage() {
  const { documentId } = useParams<{ documentId?: string }>();
  const navigate = useNavigate();
  const { workspaceName } = useWorkspace();
  const [markdownOnly, setMarkdownOnly] = useState(true);
  const [query, setQuery] = useState("");

  const listQuery = trpcX.documents.listGlobal.useQuery(
    { markdownOnly, limit: 150 },
    { retry: false }
  );

  const detailQuery = trpcX.documents.getGlobal.useQuery(
    { documentId: documentId! },
    { enabled: !!documentId, retry: false }
  );

  const filtered = useMemo(() => {
    const rows = listQuery.data?.documents ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        d.type.toLowerCase().includes(q) ||
        d.id.toLowerCase().includes(q)
    );
  }, [listQuery.data?.documents, query]);

  const activeTitle = detailQuery.data?.document.title;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 p-6 md:p-8">
      <header className="space-y-2">
        <nav
          aria-label="Breadcrumb"
          className="flex flex-wrap items-center gap-2 text-sm text-default-500"
        >
          <Link
            to="/documents"
            className="text-default-600 transition-colors hover:text-primary"
          >
            Documents
          </Link>
          {documentId && activeTitle ? (
            <>
              <IconChevronRight size={14} className="shrink-0 opacity-50" />
              <span className="min-w-0 truncate font-medium text-foreground">
                {activeTitle}
              </span>
            </>
          ) : null}
        </nav>
        <div className="flex items-center gap-2">
          <IconFileText className="text-primary" size={26} />
          <Text className="text-2xl font-semibold tracking-tight text-foreground">
            Documents
          </Text>
        </div>
        <Text className="max-w-3xl text-small text-default-500">
          Browse file-backed notes across this pod. Markdown and plain text open
          in the viewer; PDFs and other binaries stay in Synap Browser.
          {workspaceName ? (
            <>
              {" "}
              Current workspace context:{" "}
              <span className="font-medium text-default-700">
                {workspaceName}
              </span>
              .
            </>
          ) : null}
        </Text>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
        <Card.Root className="border border-divider">
          <Card.Header className="flex flex-col gap-3 border-b border-divider px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <Card.Title className="text-base">Library</Card.Title>
              <Chip size="sm" variant="soft" color="default">
                {filtered.length}
              </Chip>
            </div>
            <div className="relative">
              <IconSearch
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-default-400"
              />
              <Input
                className="border-default-200 bg-background pl-9 text-foreground"
                placeholder="Filter by title or id…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Text className="text-xs text-default-500">
                Prefer markdown &amp; text titles
              </Text>
              <Switch
                size="sm"
                isSelected={markdownOnly}
                onChange={(v) => setMarkdownOnly(Boolean(v))}
              >
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch>
            </div>
          </Card.Header>
          <Card.Content className="max-h-[min(560px,60vh)] overflow-y-auto p-2">
            {listQuery.isLoading ? (
              <div className="flex justify-center py-12">
                <Spinner color="accent" />
              </div>
            ) : listQuery.isError ? (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>Could not load documents</Alert.Title>
                  <Alert.Description>
                    {listQuery.error.message}
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : filtered.length === 0 ? (
              <Text className="px-2 py-8 text-center text-sm text-default-500">
                No documents match this filter.
              </Text>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {filtered.map((doc) => {
                  const active = doc.id === documentId;
                  return (
                    <li key={doc.id}>
                      <Button
                        variant={active ? "secondary" : "ghost"}
                        className="h-auto min-h-0 w-full justify-start gap-2 px-3 py-2 text-left"
                        onPress={() => navigate(`/documents/${doc.id}`)}
                      >
                        <IconFileText
                          size={18}
                          className={
                            active ? "text-primary" : "text-default-400"
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {doc.title}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-default-500">
                            <Chip size="sm" variant="soft" color="default">
                              {doc.type}
                            </Chip>
                            <span className="font-mono text-[10px] opacity-70">
                              {doc.id.slice(0, 8)}…
                            </span>
                          </span>
                        </span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card.Content>
        </Card.Root>

        <Card.Root className="min-h-[320px] border border-divider">
          {!documentId ? (
            <Card.Content className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <IconFileText size={40} className="text-default-300" />
              <Text className="text-sm text-default-500">
                Select a document to preview markdown or text.
              </Text>
            </Card.Content>
          ) : detailQuery.isLoading ? (
            <Card.Content className="flex justify-center py-16">
              <Spinner color="accent" />
            </Card.Content>
          ) : detailQuery.isError ? (
            <Card.Content className="p-4">
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>Preview unavailable</Alert.Title>
                  <Alert.Description>
                    {detailQuery.error.message}
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            </Card.Content>
          ) : (
            <>
              <Card.Header className="flex flex-col gap-1 border-b border-divider px-4 py-3">
                <Card.Title className="text-lg leading-snug">
                  {detailQuery.data?.document.title}
                </Card.Title>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip size="sm" variant="soft" color="accent">
                    {detailQuery.data?.document.type}
                  </Chip>
                  {detailQuery.data?.document.language ? (
                    <Chip size="sm" variant="soft" color="default">
                      {detailQuery.data.document.language}
                    </Chip>
                  ) : null}
                </div>
              </Card.Header>
              <Card.Content className="p-4">
                <Separator className="mb-4" />
                <article className="admin-md prose-docs max-h-[min(640px,65vh)] overflow-y-auto pr-1">
                  {detailQuery.data?.document.type === "markdown" ||
                  /\.md$/i.test(detailQuery.data?.document.title ?? "") ||
                  /\.markdown$/i.test(
                    detailQuery.data?.document.title ?? ""
                  ) ? (
                    <ReactMarkdown
                      components={{
                        a({ href, children, ...props }) {
                          if (!href) return <span {...props}>{children}</span>;
                          if (isProbablyExternal(href)) {
                            return (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                                {...props}
                              >
                                {children}
                                <IconLinkTabler
                                  size={12}
                                  className="inline shrink-0 opacity-70"
                                />
                              </a>
                            );
                          }
                          return (
                            <Link
                              to={href}
                              className="text-primary underline-offset-2 hover:underline"
                              {...props}
                            >
                              {children}
                            </Link>
                          );
                        },
                      }}
                    >
                      {detailQuery.data?.content ?? ""}
                    </ReactMarkdown>
                  ) : (
                    <pre className="whitespace-pre-wrap rounded-lg border border-divider bg-default-50 p-4 font-mono text-xs leading-relaxed text-foreground">
                      {detailQuery.data?.content ?? ""}
                    </pre>
                  )}
                </article>
              </Card.Content>
            </>
          )}
        </Card.Root>
      </div>
    </div>
  );
}
