import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import { WebViewer } from "@rerun-io/web-viewer";
import recordingUrl from "../../../test/fixtures/evaluations/dry-ramp.rrd?url";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { AppSidebarLayout } from "../AppSidebarLayout";
import { EvaluationsPage } from "./EvaluationsPage";
import "~/index.css";

const playback = vi.hoisted(() => ({ changed: false }));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: (_environmentId, resource) => ({
    _tag: "Success",
    url:
      resource?._tag === "draft-workspace-file" && resource.path.endsWith(".png")
        ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/CXkAAAAASUVORK5CYII="
        : playback.changed
          ? "data:application/octet-stream,changed"
          : new URL(recordingUrl, location.href).href,
    expiresAt: 0,
  }),
  useAssetUrlRefresh: () => async () => new URL(recordingUrl, location.href).href,
}));
const id = vi.hoisted(() => "locomotion--2026-04-05--ramp-test--123456789abc");
vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  useQuietThreadShells: () => [
    makeThreadFixture({
      environmentId: EnvironmentId.make("bench"),
      projectId: ProjectId.make("cart"),
      title: "Tune the incline controller",
    }),
  ],
  useProjects: () => [
    { id: "arm", title: "Bench arm", workspaceRoot: "/bench/arm", environmentId: "bench" },
    { id: "cart", title: "Inspection rover", workspaceRoot: "/bench/cart", environmentId: "bench" },
  ],
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useConnectedEnvironmentIds: () => ["bench"],
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "bench",
        label: "Lab",
        connection: { phase: "connected", lastFailure: null },
        entry: { enabled: true, target: { _tag: "PrimaryConnectionTarget" } },
        serverConfig: null,
      },
    ],
  }),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentsWithScope: () => new Set(["bench"]),
}));
vi.mock("../../state/projects", async (original) => {
  const module = await original<typeof import("../../state/projects")>();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const emptyList = Atom.make(AsyncResult.success({ entries: [], truncated: false }));
  const baseId = "locomotion--2026-04-03--baseline-traction--e131f803b6bc";
  const base = {
    id: baseId,
    title: "Establish dry-ramp baseline",
    category: "locomotion",
    mode: "physical",
    recordedAt: "2026-04-03T12:00:00Z",
    revision: "controller-v3",
  };
  const history = Atom.make(
    AsyncResult.success({
      unavailable: 0,
      truncated: false,
      runs: [
        base,
        {
          ...base,
          id,
          title: "Incline trials",
          primaryMetric: { label: "Peak incline", value: 9, unit: "°", baselineValue: 6 },
          baseline: baseId,
          recordedAt: "2026-04-05T12:00:00Z",
        },
        {
          ...base,
          id: "locomotion--2026-04-06--wet-tread--14cd59ab402e",
          title: "Repeat on wet tread",
          baseline: baseId,
          recordedAt: "2026-04-06T12:00:00Z",
        },
        {
          ...base,
          id: "navigation--2026-04-04--turn-controller--047a135e88f2",
          title: "Measure stock turn response",
          category: "navigation",
          mode: "simulation",
          recordedAt: "2026-04-04T12:00:00Z",
        },
      ],
    }),
  );
  const emptyHistory = Atom.make(
    AsyncResult.success({ runs: [], unavailable: 0, truncated: false }),
  );
  const missingReport = Atom.make(AsyncResult.success(null));
  const list = Atom.make(
    AsyncResult.success({
      entries: [
        id,
        "locomotion--2026-04-03--baseline-traction--e131f803b6bc",
        "navigation--2026-04-04--turn-controller--047a135e88f2",
      ].map((reference) => ({ path: "evaluations/" + reference + ".json", kind: "file" })),
      truncated: false,
    }),
  );
  const detail = Atom.make(
    AsyncResult.success({
      category: "locomotion",
      title: "Incline trials",
      primaryMetric: { label: "Peak incline", value: 9, unit: "°", baselineValue: 6 },
      mode: "physical",
      recordedAt: "2026-04-05T12:00:00Z",
      summary:
        '## Traction across three trials\n\n![Ramp frame](./figures/ramp.png)\n\nPeak incline increased from **6° to 9°**. Front wheels began slipping at [12.4 s](t3-context://v1/replay/wheel-slip).\n\n```mermaid\nxychart-beta\n  x-axis [A, B, C]\n  y-axis "Incline (degrees)" 0 --> 12\n  bar [6, 8, 9]\n```',
      baseline: "locomotion--2026-04-03--baseline-traction--e131f803b6bc",
      revision: "controller-v4",
      setup: "Inspection rover · dry ramp",
      replayCitations: [
        {
          id: "wheel-slip",
          label: "Front wheels begin to slip",
          path: "logs/dry-ramp.rrd",
          timeline: "elapsed",
          timeType: "duration",
          time: "12400000000",
        },
        {
          id: "missing-frame",
          label: "Unrecorded frame",
          path: "logs/dry-ramp.rrd",
          timeline: "frame",
          timeType: "sequence",
          time: "12",
        },
      ],
      evidence: [
        {
          path: "evaluations/figures/ramp.png",
          sha256: "5598cbcc01b67f305a74d89e9d1595a0d09a01d3004304aed25bc0bc256e87cb",
        },
        {
          path: "logs/dry-ramp.rrd",
          sha256: "63ad4d1f336f65df878f8dfd2694e41976faf75a6f38d295bdc3d5ed15d9fb46",
        },
        {
          path: "logs/incline.csv",
          sha256: "bab5e834b7845fb8142389d456675dbd7a86cc4045e7cbcf87d2eed813cdb0b2",
        },
      ],
    }),
  );
  return {
    ...module,
    projectEnvironment: {
      ...module.projectEnvironment,
      evaluationHistory: ({ input }: { input: { cwd: string } }) =>
        input.cwd === "/bench/cart" ? history : emptyHistory,
      evaluationEntries: ({ input }: { input: { cwd: string } }) =>
        input.cwd === "/bench/cart" ? list : emptyList,
      evaluationReport: ({ input }: { input: { id: string } }) =>
        input.id === id ? detail : missingReport,
    },
  };
});

it("opens a project-scoped result by ID with its chart and provenance", async () => {
  const root = createRootRoute();
  const layout = createRoute({ getParentRoute: () => root, id: "_chat" });
  const route = createRoute({
    getParentRoute: () => layout,
    path: "evaluations",
    component: EvaluationsPage,
  });
  const router = createRouter({
    routeTree: root.addChildren([layout.addChildren([route])]),
    history: createMemoryHistory({ initialEntries: ["/evaluations?project=bench:cart"] }),
  });
  await router.load();
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  await screen.getByRole("link", { name: "All results", exact: true }).click();
  await expect.element(screen.getByRole("heading", { name: "locomotion" })).toBeVisible();
  await screen.getByRole("searchbox").fill("missing");
  await expect.element(screen.getByText("No matching results.")).toBeVisible();
  await screen.getByRole("searchbox").fill(id);
  await screen.getByRole("link", { name: /ramp test/ }).click();
  expect(router.state.location.search).toEqual({
    project: "bench:cart",
    result: id,
    view: "results",
  });
  await expect.element(screen.getByRole("heading", { name: "Incline trials" })).toBeVisible();
  await expect.element(screen.getByRole("img", { name: "Ramp frame" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Expand diagram" })).toBeVisible();
  await expect.element(screen.getByText("logs/incline.csv")).toBeVisible();
  await screen.getByRole("button", { name: "Expand diagram" }).click();
  await page.getByRole("button", { name: "Close image preview" }).click();
  await screen.getByRole("link", { name: "All results" }).click();
  await expect.element(screen.getByRole("heading", { name: "locomotion" })).toBeVisible();
  await screen.getByRole("combobox").click();
  await page.getByRole("option", { name: /Bench arm/ }).click();
  await expect.element(screen.getByText(/Publish your first result/)).toBeVisible();
  router.history.push("/evaluations?project=bench%3Acart&result=missing");
  await expect.element(screen.getByText(/its contents no longer match/)).toBeVisible();
});

it("switches evaluation workspaces through their project folders", async () => {
  const root = createRootRoute();
  const layout = createRoute({ getParentRoute: () => root, id: "_chat" });
  const route = createRoute({
    getParentRoute: () => layout,
    path: "evaluations",
    component: () => (
      <AppSidebarLayout>
        <EvaluationsPage />
      </AppSidebarLayout>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([layout.addChildren([route])]),
    history: createMemoryHistory({ initialEntries: ["/evaluations?project=bench:cart"] }),
  });
  await page.viewport(1250, 825);
  await router.load();
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  const folders = screen.getByTestId("sidebar-project-folder");
  const cart = folders.filter({ hasText: "Inspection rover" });
  const arm = folders.filter({ hasText: "Bench arm" });
  const evaluations = { name: "Evaluations", exact: true };
  await expect.element(cart.getByRole("link", evaluations)).toHaveAttribute("aria-current", "page");
  await expect.element(screen.getByRole("heading", { name: "Experiment history" })).toBeVisible();
  await expect.element(screen.getByText("9°", { exact: true })).toBeVisible();
  const branch = screen
    .getByRole("link", { name: /Establish dry-ramp baseline/ })
    .element()
    .closest("li")!;
  expect(branch.querySelectorAll("ul > li")).toHaveLength(2);
  await screen.getByRole("searchbox").fill("wet");
  await expect
    .element(screen.getByRole("link", { name: /Establish dry-ramp baseline/ }))
    .toBeVisible();
  await expect.element(screen.getByRole("link", { name: /Repeat on wet tread/ })).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: /Incline trials/ }))
    .not.toBeInTheDocument();
  await screen.getByRole("searchbox").fill(id);
  await screen.getByRole("link", { name: /Incline trials/ }).click();
  await expect.element(screen.getByRole("heading", { name: "Incline trials" })).toBeVisible();
  await screen.getByRole("link", { name: "Experiment history" }).click();

  await expect
    .element(screen.getByText("Tune the incline controller", { exact: true }).first())
    .toBeVisible();
  await arm.getByRole("link", evaluations).click();
  await expect.element(screen.getByText(/Publish your first result/)).toBeVisible();
  expect(router.state.location.search).toEqual({ project: "bench:arm" });
  await expect.element(arm.getByRole("link", evaluations)).toHaveAttribute("aria-current", "page");
  await expect.element(cart.getByRole("link", evaluations)).not.toHaveAttribute("aria-current");
  await expect
    .element(cart.getByRole("link", { name: "Robotics" }))
    .toHaveAttribute("href", "/robotics?project=bench%3Acart");
});

it("verifies the recording and pauses Rerun at a linked citation, including after a failed verification", async () => {
  const root = createRootRoute();
  const layout = createRoute({ getParentRoute: () => root, id: "_chat" });
  const route = createRoute({
    getParentRoute: () => layout,
    path: "evaluations",
    component: EvaluationsPage,
  });
  const router = createRouter({
    routeTree: root.addChildren([layout.addChildren([route])]),
    history: createMemoryHistory({
      initialEntries: ["/evaluations?project=bench%3Acart&result=" + id + "&replay=wheel-slip"],
    }),
  });
  await page.viewport(1280, 980);
  const applied = Promise.withResolvers<WebViewer>();
  const setTime = WebViewer.prototype.setTime;
  using seek = vi.spyOn(WebViewer.prototype, "setTime").mockImplementation(async function (
    this: WebViewer,
    options,
  ) {
    await setTime.call(this, options);
    applied.resolve(this);
  });
  playback.changed = true;
  try {
    await router.load();
    await using screen = await render(<RouterProvider router={router} />, { router: false });
    await expect.element(screen.getByText(/This recording differs/)).toBeVisible();
    expect(seek).not.toHaveBeenCalled();
    // The software renderer emits thousands of shader debug messages during cold startup.
    using _shaderLogs = vi.spyOn(console, "debug").mockImplementation(() => {});
    await screen.getByRole("button", { name: "Retry" }).click();
    await expect
      .element(screen.getByRole("status").filter({ hasText: "Verified recording" }))
      .toBeVisible();
    const player = await applied.promise;
    const cursor = async () => (await player.getState()).recordings[0]!;
    expect((await cursor()).currentTime).toMatchObject({ timeline: "elapsed", time: 12400000000n });
    expect((await cursor()).playState).toBe("paused");
    await screen.getByRole("link", { name: /Unrecorded frame/ }).click();
    await expect.element(screen.getByText("Recording position unavailable.")).toBeVisible();
    await screen.getByRole("link", { name: "12.4 s", exact: true }).click();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await screen.getByRole("link", { name: "Close recording" }).click();
    expect(router.state.location.search).toEqual({ project: "bench:cart", result: id });
  } finally {
    playback.changed = false;
  }
});
