import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { RoboticsPage } from "./RoboticsPage";

vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  useProjects: () =>
    ["bench", "field", "offline"].map((environmentId) => ({
      id: "cart",
      title: "Cart",
      workspaceRoot: "/lab/cart",
      environmentId,
    })),
  useServerConfigs: () =>
    new Map(
      ["bench", "field", "offline"].map((id) => [
        id,
        { environment: { capabilities: { robotics: true } } },
      ]),
    ),
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useConnectedEnvironmentIds: () => ["bench", "field"],
  useEnvironments: () => ({
    environments: ["bench", "field", "offline"].map((id) => ({ environmentId: id, label: id })),
  }),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentsWithScope: () => new Set(["bench", "field"]),
}));
vi.mock("../settings/ProjectRoboticsPanel", () => ({
  ProjectRoboticsControls: ({
    environmentId,
    projectId,
  }: {
    environmentId: string;
    projectId: string;
  }) => (
    <output>
      {environmentId}/{projectId}
    </output>
  ),
}));

it("keeps an offline project's controls closed until the user selects a connected host", async () => {
  const root = createRootRoute();
  const layout = createRoute({ getParentRoute: () => root, id: "_chat" });
  const robotics = createRoute({
    getParentRoute: () => layout,
    path: "robotics",
    component: RoboticsPage,
  });
  const router = createRouter({
    routeTree: root.addChildren([layout.addChildren([robotics])]),
    history: createMemoryHistory({ initialEntries: ["/robotics?project=offline:cart"] }),
  });
  await router.load();
  // Exercise the project picker against its real route and browser history.
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  await expect.element(screen.getByText("This project is no longer available.")).toBeVisible();
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  await screen.getByRole("combobox", { name: "Select a project" }).click();
  await page.getByRole("option", { name: /field/ }).click();
  await expect.element(screen.getByText("field/cart")).toBeVisible();
  expect(router.state.location.search).toMatchObject({ project: "field:cart" });
});
