import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  ProjectMemberRepository,
  sql,
} from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const projectMembersHandler = async ({
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
      `[projectMembersExecutor] Received non-validated event: ${event.name}`
    );
    return { success: false, reason: "Not a validated event" };
  }

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const memberRepo = new ProjectMemberRepository(db, eventRepo);

  const userId = event.user.id;
  const data = event.data;

  return await step.run("process-project-member", async () => {
    if (action === "add") {
      // Note: ProjectMemberRepository methods may emit events manually
      await memberRepo.add(
        {
          projectId: data.projectId as string,
          userId: (data.targetUserId as string) || (data.userId as string),
          role: ((data.role as string) || "viewer") as
            | "owner"
            | "editor"
            | "viewer",
        },
        userId
      );
    } else if (action === "remove") {
      await memberRepo.remove(
        {
          projectId: data.projectId as string,
          userId: (data.targetUserId as string) || (data.userId as string),
        },
        userId
      );
    } else if (action === "updateRole") {
      await memberRepo.updateRole(
        {
          projectId: data.projectId as string,
          userId: (data.targetUserId as string) || (data.userId as string),
          newRole: data.newRole as "owner" | "editor" | "viewer",
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
  { event: "projectMember.*" },
  projectMembersHandler
);
