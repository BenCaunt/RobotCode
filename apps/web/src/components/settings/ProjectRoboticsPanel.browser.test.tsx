import {
  AuthTerminalReadScope,
  EnvironmentId,
  ProjectId,
  type RoboticsJobListInput,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ProjectRoboticsControls } from "./ProjectRoboticsPanel";

vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentScope: (_id: EnvironmentId, scope: string) => scope === AuthTerminalReadScope,
}));

vi.mock("@t3tools/client-runtime/state/robotics", async (original) => {
  const robotics = await original<typeof import("@t3tools/client-runtime/state/robotics")>();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const definitions = Atom.make(AsyncResult.success([]));
  const job = { label: "City simulator", hostId: "lab", state: "stopped", resourceClaims: [] };
  const jobPage = (id: string, nextBefore: number | null) =>
    Atom.make(
      AsyncResult.success({
        jobs: [{ ...job, jobId: id, threadId: id }],
        nextBefore,
        hasArchived: true,
      }),
    );
  const current = jobPage("latest", null);
  const archived = jobPage("previous", 2);
  const oldest = jobPage("first", null);
  const logs = Atom.family((id: string) =>
    Atom.make(AsyncResult.success({ output: `output from ${id}` })),
  );
  return {
    ...robotics,
    createRoboticsEnvironmentAtoms: (
      ...args: Parameters<typeof robotics.createRoboticsEnvironmentAtoms>
    ) => ({
      ...robotics.createRoboticsEnvironmentAtoms(...args),
      definitions: () => definitions,
      jobs: ({ input }: { input: RoboticsJobListInput }) => {
        if (input.before !== undefined) return oldest;
        return input.view === "archived" ? archived : current;
      },
      logs: ({ input }: { input: { jobId: string } }) => logs(input.jobId),
    }),
  };
});

it("opens an archived run's logs and returns to the current list from an older archive page", async () => {
  await using screen = await render(
    <ProjectRoboticsControls
      environmentId={EnvironmentId.make("bench")}
      projectId={ProjectId.make("city")}
    />,
  );
  await expect.element(screen.getByText("Conversation latest")).toBeVisible();
  await screen.getByRole("button", { name: "Archived runs" }).click();
  await expect.element(screen.getByText("Conversation previous")).toBeVisible();
  await screen.getByRole("button", { name: "Older" }).click();
  await screen.getByRole("button", { name: "Logs" }).click();
  await expect.element(screen.getByText("output from first")).toBeVisible();
  await screen.getByRole("button", { name: "Current runs" }).click();
  await expect.element(screen.getByText("Conversation latest")).toBeVisible();
  await expect.element(screen.getByText("output from first")).not.toBeInTheDocument();
});
