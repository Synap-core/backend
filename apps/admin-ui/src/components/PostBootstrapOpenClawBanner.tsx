import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card } from "@heroui/react";
import { trpc } from "../lib/trpc";

export const POST_BOOTSTRAP_OPENCLAW_SESSION_KEY =
  "synap_post_bootstrap_openclaw_prompt";

/**
 * One-time card after token-based /admin/bootstrap → Kratos registration.
 * Offers OpenClaw setup or dismiss; auto-hides if OpenClaw already looks provisioned.
 */
export default function PostBootstrapOpenClawBanner() {
  const navigate = useNavigate();
  const [show, setShow] = useState(false);

  const overviewQuery = trpc.openclawAdmin.getOverview.useQuery(undefined, {
    enabled: show,
    staleTime: 60_000,
  });

  useEffect(() => {
    try {
      if (sessionStorage.getItem(POST_BOOTSTRAP_OPENCLAW_SESSION_KEY) === "1") {
        setShow(true);
      }
    } catch {
      // private mode / blocked storage
    }
  }, []);

  useEffect(() => {
    if (!show) return;
    const openclaw = overviewQuery.data?.openclaw;
    if (openclaw?.provisioned) {
      try {
        sessionStorage.removeItem(POST_BOOTSTRAP_OPENCLAW_SESSION_KEY);
      } catch {
        /* ignore */
      }
      setShow(false);
    }
  }, [show, overviewQuery.data?.openclaw]);

  if (!show) return null;

  const dismiss = () => {
    try {
      sessionStorage.removeItem(POST_BOOTSTRAP_OPENCLAW_SESSION_KEY);
    } catch {
      /* ignore */
    }
    setShow(false);
  };

  return (
    <Card.Root className="border border-primary-200 bg-primary-50/40 dark:border-primary-800 dark:bg-primary-950/30">
      <Card.Header className="flex flex-col items-start gap-1 pb-0">
        <Card.Title className="text-base">OpenClaw (optional)</Card.Title>
        <Card.Description className="text-sm text-default-600">
          You completed token bootstrap. If you want agent tooling on this pod,
          set up the OpenClaw add-on now, or skip and configure it later from
          the sidebar.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-wrap gap-2 pt-3">
        <Button
          variant="primary"
          size="sm"
          onPress={() => navigate("/openclaw")}
        >
          Open OpenClaw setup
        </Button>
        <Button variant="outline" size="sm" onPress={dismiss}>
          Skip for now
        </Button>
      </Card.Content>
    </Card.Root>
  );
}
