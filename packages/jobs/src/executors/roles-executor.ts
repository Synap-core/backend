import { inngest } from "../client.js";
import { getDb, EventRepository, RoleRepository } from "@synap/database";

export const rolesHandler = async ({
  event,
  step,
}: {
  event: any;
  step: any;
}) => {
  const action = event.name.split(".")[1] as "create" | "update" | "delete";
  const { userId } = event.user;
  const data = event.data;

  const db = await getDb();
  const eventRepo = new EventRepository(db.$client);
  const roleRepo = new RoleRepository(db, eventRepo);

  if (action === "create") {
    await step.run("create-role", async () => {
      return roleRepo.create(
        {
          name: data.name,
          description: data.description,
          workspaceId: data.workspaceId,
          permissions: data.permissions,
          filters: data.filters,
          createdBy: userId,
        },
        userId
      );
    });
  } else if (action === "update") {
    await step.run("update-role", async () => {
      return roleRepo.update(
        data.id,
        {
          name: data.name,
          description: data.description,
          permissions: data.permissions,
          filters: data.filters,
        },
        userId
      );
    });
  } else if (action === "delete") {
    await step.run("delete-role", async () => {
      return roleRepo.delete(data.id, userId);
    });
  }

  return { success: true, action };
};

export const rolesExecutor = inngest.createFunction(
  {
    id: "roles-executor",
    name: "Execute Role Operations",
    concurrency: { limit: 20 },
  },
  { event: "roles.*.validated" },
  rolesHandler
);
