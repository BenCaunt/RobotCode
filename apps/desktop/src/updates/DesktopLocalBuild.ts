// @effect-diagnostics-next-line nodeBuiltinImport:off -- The swap helper must outlive this process, which a scoped ChildProcess cannot.
import * as NodeChildProcess from "node:child_process";

import type { DesktopLocalBuildState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

const { logInfo } = makeComponentLogger("desktop-local-build");

/** Sibling of the installed bundle, so the swap is a rename on one volume. */
export const STAGING_DIRECTORY_NAME = ".robot-code-staged";

// Waits for the app to exit, swaps the bundles, and reopens. Restores the old bundle if the swap fails.
const SWAP_SCRIPT = `
pid="$1"; installed="$2"; staged="$3"; previous="$4"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf "$previous"
if mv "$installed" "$previous"; then
  if mv "$staged" "$installed"; then rm -rf "$previous"; else mv "$previous" "$installed"; fi
fi
open "$installed"
`;

function bundleIdentifier(infoPlist: string): string | undefined {
  return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/u.exec(infoPlist)?.[1];
}

export class DesktopLocalBuild extends Context.Service<
  DesktopLocalBuild,
  {
    /** A build staged beside the installed app that is newer than the running one. */
    readonly state: Effect.Effect<DesktopLocalBuildState>;
    readonly install: Effect.Effect<DesktopLocalBuildState>;
  }
>()("@t3tools/desktop/updates/DesktopLocalBuild") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // <bundle>.app/Contents/Resources
  const installed = path.dirname(path.dirname(environment.resourcesPath));
  const staging = path.join(path.dirname(installed), STAGING_DIRECTORY_NAME);
  const staged = path.join(staging, path.basename(installed));
  const supported =
    environment.platform === "darwin" && environment.isPackaged && installed.endsWith(".app");

  const builtAt = (bundle: string) =>
    fs.stat(path.join(bundle, "Contents", "Resources", "app.asar")).pipe(
      Effect.map((info) => Option.getOrUndefined(info.mtime)),
      Effect.orElseSucceed(() => undefined),
    );
  const identifier = (bundle: string) =>
    fs.readFileString(path.join(bundle, "Contents", "Info.plist")).pipe(
      Effect.map(bundleIdentifier),
      Effect.orElseSucceed(() => undefined),
    );

  const state = Effect.gen(function* () {
    if (!supported) return null;
    const stagedAt = yield* builtAt(staged);
    if (stagedAt === undefined) return null;
    const runningAt = yield* builtAt(installed);
    if (runningAt === undefined || stagedAt <= runningAt) return null;
    const id = yield* identifier(staged);
    if (id === undefined || id !== (yield* identifier(installed))) return null;
    return { builtAt: stagedAt.toISOString() };
  }).pipe(Effect.withSpan("DesktopLocalBuild.state"));

  const install = Effect.gen(function* () {
    const ready = yield* state;
    if (ready === null) return null;
    yield* logInfo("relaunching into staged build", { staged, builtAt: ready.builtAt });
    yield* Effect.sync(() =>
      NodeChildProcess.spawn(
        "/bin/sh",
        [
          "-c",
          SWAP_SCRIPT,
          "robot-code-swap",
          String(process.pid),
          installed,
          staged,
          path.join(staging, "previous.app"),
        ],
        { detached: true, stdio: "ignore" },
      ).unref(),
    );
    yield* electronApp.quit;
    return ready;
  }).pipe(Effect.withSpan("DesktopLocalBuild.install"));

  return DesktopLocalBuild.of({ state, install });
});

export const layer = Layer.effect(DesktopLocalBuild, make);
