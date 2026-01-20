import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  ProjectMemberRepository,
} from "@synap/database";

export const projectMembersHandler = async ({
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
  const memberRepo = new ProjectMemberRepository(db, eventRepo);

  return await step.run("process-project-member", async () => {
    if (action === "add") {
      await memberRepo.add(
        {
          projectId: data.projectId,
          userId: data.targetUserId,
          role: data.role || "viewer",
        },
        userId
      );
    } else if (action === "remove") {
      await memberRepo.remove(
        {
          projectId: data.projectId,
          userId: data.targetUserId,
        },
        userId
      );
    } else if (action === "updateRole") {
      await memberRepo.updateRole(
        {
          projectId: data.projectId,
          userId: data.targetUserId,
          newRole: data.newRole,
        },
        userId
      );
    }

    return { success: true, action };
  });
};

export const projectMembersExecutor = inngest.createFunction(
  {
    id: "project-members-executor",
    name: "Execute Project Member Operations",
    concurrency: { limit: 10 },
  },
  { event: "projectMembers.*.validated" },
  projectMembersHandler
);
