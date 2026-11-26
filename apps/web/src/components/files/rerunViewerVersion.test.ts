import { RERUN_VIEWER_VERSION } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import manifest from "../../../package.json" with { type: "json" };

it("tells agents and operators the Rerun version the embedded viewer actually ships", () => {
  expect(RERUN_VIEWER_VERSION).toBe(manifest.dependencies["@rerun-io/web-viewer"]);
});
