import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ProjectRoboticsControls } from "../settings/ProjectRoboticsPanel";

const stream = "rerun+http://127.0.0.1:9876/proxy";

vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));

vi.mock("../files/RerunCanvas", () => ({
  RerunCanvas: (props: { sourceUrl: string; dashboard?: boolean }) => (
    <div data-testid="viewer" data-dashboard={props.dashboard}>
      {props.sourceUrl}
    </div>
  ),
}));

vi.mock("@t3tools/client-runtime/state/robotics", async (original) => {
  const robotics = await original<typeof import("@t3tools/client-runtime/state/robotics")>();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const robot = { projectId: "city", knownHosts: [], initPath: null, session: null };
  const robots = Atom.make(
    AsyncResult.success([
      {
        ...robot,
        robotId: "arm",
        displayName: "Sim arm",
        liveView: { url: "rerun+http://127.0.0.1:9876/proxy" },
      },
      { ...robot, robotId: "cart", displayName: "Cart" },
    ]),
  );
  const empty = Atom.make(AsyncResult.success([]));
  const jobs = Atom.make(AsyncResult.success({ jobs: [], nextBefore: null, hasArchived: false }));
  return {
    ...robotics,
    createRoboticsEnvironmentAtoms: (
      ...args: Parameters<typeof robotics.createRoboticsEnvironmentAtoms>
    ) => ({
      ...robotics.createRoboticsEnvironmentAtoms(...args),
      robots: () => robots,
      definitions: () => empty,
      jobs: () => jobs,
    }),
  };
});

function Page() {
  const [viewing, setViewing] = useState<string>();
  return (
    <ProjectRoboticsControls
      environmentId={EnvironmentId.make("bench")}
      projectId={ProjectId.make("city")}
      viewing={viewing}
      onView={setViewing}
    />
  );
}

it("opens and closes the live view of a robot that registers a stream", async () => {
  await using screen = await render(<Page />);
  await expect.element(screen.getByText("Cart")).toBeVisible();
  // Only the robot with a registered stream offers a live view.
  expect(screen.getByRole("button", { name: "Live view" }).elements()).toHaveLength(1);

  await screen.getByRole("button", { name: "Live view" }).click();
  const view = screen.getByRole("region", { name: "Live view of Sim arm" });
  await expect.element(view).toBeVisible();
  await expect.element(screen.getByTestId("viewer")).toHaveTextContent(stream);
  await expect.element(screen.getByTestId("viewer")).toHaveAttribute("data-dashboard", "true");

  await screen.getByRole("button", { name: "Close live view" }).click();
  await expect.element(view).not.toBeInTheDocument();
});
