import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  WorkspaceMemberRepository,
} from "@synap/database";

export const workspaceMembersHandler = async ({
  event,
  step,
}: {
  event: any;
  step: any;
}) => {
  const action = event.name.split(".")[1] as "add" | "remove" | "updateRole";
  const { userId } = event.user;
  const data = event.data;

  const db = await getDb();
  const eventRepo = new EventRepository(db as any);
  const memberRepo = new WorkspaceMemberRepository(db, eventRepo);

  return await step.run("process-workspace-member", async () => {
    if (action === "add") {
      await memberRepo.add(
        {
          workspaceId: data.workspaceId,
          userId: data.targetUserId,
          role: data.role || "viewer",
          inviteId: data.inviteId,
        },
        userId
      );
    } else if (action === "remove") {
      await memberRepo.remove(
        {
          workspaceId: data.workspaceId,
          userId: data.targetUserId,
        },
        userId
      );
    } else if (action === "updateRole") {
      await memberRepo.updateRole(
        {
          workspaceId: data.workspaceId,
          userId: data.targetUserId,
          newRole: data.newRole,
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
