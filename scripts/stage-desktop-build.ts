#!/usr/bin/env node
// Builds the macOS desktop app from this checkout and stages it beside the installed app.
// The running app then offers to relaunch into it (apps/desktop/src/updates/DesktopLocalBuild.ts).
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// Keep in step with STAGING_DIRECTORY_NAME in DesktopLocalBuild.ts.
const STAGING_DIRECTORY_NAME = ".robot-code-staged";

export class StageDesktopBuildError extends Schema.TaggedError<StageDesktopBuildError>()(
  "StageDesktopBuildError",
  { message: Schema.String },
) {}

const run = Effect.fn("stageDesktopBuild.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { stdout: "inherit", stderr: "inherit" }),
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) {
    return yield* new StageDesktopBuildError({
      message: `${command} exited with code ${exitCode}.`,
    });
  }
}, Effect.scoped);

export const stageDesktopBuild = Effect.fn("stageDesktopBuild")(function* (input: {
  readonly app: Option.Option<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* Config.String("HOME");
  const installed = path.resolve(
    Option.getOrElse(input.app, () => path.join(home, "Applications", "Robot Code.app")),
  );
  if (!(yield* fs.exists(installed))) {
    return yield* new StageDesktopBuildError({
      message: `No installed app at ${installed}. Pass --app <path to the .app>.`,
    });
  }
  const staging = path.join(path.dirname(installed), STAGING_DIRECTORY_NAME);
  const output = path.join(staging, "build");
  const repoRoot = path.resolve(import.meta.dirname, "..");
  yield* fs.remove(output, { recursive: true, force: true });
  yield* fs.makeDirectory(output, { recursive: true });

  yield* run(process.execPath, [
    path.join(repoRoot, "scripts", "build-desktop-artifact.ts"),
    "--platform",
    "mac",
    "--target",
    "dir",
    "--output-dir",
    output,
  ]);
  const bundles = (yield* fs.readDirectory(output, { recursive: true })).filter(
    (entry) => entry.endsWith(".app") && path.dirname(path.dirname(entry)) === ".",
  );
  const [built] = bundles;
  if (built === undefined || bundles.length !== 1) {
    return yield* new StageDesktopBuildError({
      message: `Expected one app bundle in ${output}, found ${bundles.length}.`,
    });
  }
  const bundle = path.join(output, built);
  // An unsigned bundle does not launch on Apple silicon.
  yield* run("codesign", ["--force", "--deep", "--sign", "-", bundle]);

  const staged = path.join(staging, path.basename(installed));
  yield* fs.remove(staged, { recursive: true, force: true });
  yield* fs.rename(bundle, staged);
  yield* fs.remove(output, { recursive: true, force: true });
  yield* Effect.log(`[stage-desktop-build] Staged ${staged}. Relaunch from the app's sidebar.`);
});

const command = Command.make(
  "stage-desktop-build",
  {
    app: Flag.String("app").pipe(
      Flag.withDescription(
        "Installed app bundle to update. Default ~/Applications/Robot Code.app.",
      ),
      Flag.optional,
    ),
  },
  stageDesktopBuild,
).pipe(
  Command.withDescription(
    "Build the macOS desktop app and stage it for the running app to relaunch into.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
