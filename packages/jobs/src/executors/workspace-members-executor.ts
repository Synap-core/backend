import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  WorkspaceMemberRepository,
  sql,
} from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const workspaceMembersHandler = async ({
  event,
  step,
}: {
  event: { name: string; data: UnifiedEventData; user: { id: string } };
  step: any;
}) => {
  const eventInfo = extractEventInfo(event.name);
  const { phase } = eventInfo;
  // Extract custom action (members have add/remove/updateRole which aren't in EventAction)
  const action = event.name.split(".")[1] as "add" | "remove" | "updateRole";

  if (phase !== "validated") {
    console.warn(
      `[workspaceMembersExecutor] Received non-validated event: ${event.name}`
    );
    return { success: false, reason: "Not a validated event" };
  }

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const memberRepo = new WorkspaceMemberRepository(db, eventRepo);

  const userId = event.user.id;
  const data = event.data;

  return await step.run("process-workspace-member", async () => {
    if (action === "add") {
      // Note: WorkspaceMemberRepository methods may emit events manually
      await memberRepo.add(
        {
          workspaceId: data.workspaceId as string,
          userId: (data.targetUserId as string) || (data.userId as string),
          role: ((data.role as string) || "viewer") as
            | "owner"
            | "editor"
            | "viewer",
          inviteId: (data.inviteId as string) || undefined,
        },
        userId
      );
    } else if (action === "remove") {
      await memberRepo.remove(
        {
          workspaceId: data.workspaceId as string,
          userId: (data.targetUserId as string) || (data.userId as string),
        },
        userId
      );
    } else if (action === "updateRole") {
      await memberRepo.updateRole(
        {
          workspaceId: data.workspaceId as string,
          userId: (data.targetUserId as string) || (data.userId as string),
          newRole: data.newRole as "owner" | "editor" | "viewer",
        },
        userId
      );
    }

    return { success: true, action };
  });
};

export const workspaceMembersExecutor = inngest.createFunction(
  {
    id: "workspace-members-executor",
    name: "Execute Workspace Member Operations",
    concurrency: { limit: 10 },
  },
  { event: "workspaceMembers.*.validated" },
  workspaceMembersHandler
);
