import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopLocalBuild from "./DesktopLocalBuild.ts";

const APP = "Robot Code.app";
// Seconds since the epoch, as utimes takes them.
const OLDER = 1795606800;
const NEWER = 1795611660;
const NEWER_ISO = "2026-11-25T13:01:00.000Z";

const writeBundle = Effect.fn("writeBundle")(function* (
  bundle: string,
  builtAt: number,
  identifier = "io.github.bencaunt.robotcode",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resources = path.join(bundle, "Contents", "Resources");
  yield* fs.makeDirectory(resources, { recursive: true });
  yield* fs.writeFileString(
    path.join(bundle, "Contents", "Info.plist"),
    `<dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>${identifier}</string>\n</dict>`,
  );
  const asar = path.join(resources, "app.asar");
  yield* fs.writeFileString(asar, "");
  yield* fs.utimes(asar, builtAt, builtAt);
});

const stateWith = (
  stage: (
    staged: string,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "local-build-" });
    const installed = path.join(root, APP);
    yield* writeBundle(installed, OLDER);
    yield* stage(path.join(root, DesktopLocalBuild.STAGING_DIRECTORY_NAME, APP));
    const environment = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/src",
      homeDirectory: root,
      platform: "darwin",
      processArch: "arm64",
      appVersion: "0.1.11",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: path.join(installed, "Contents", "Resources"),
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          DesktopConfig.layerTest({ T3CODE_HOME: root }),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      return yield* (yield* DesktopLocalBuild.DesktopLocalBuild).state;
    }).pipe(
      Effect.provide(
        DesktopLocalBuild.layer.pipe(
          Layer.provide(environment),
          Layer.provide(Layer.mock(ElectronApp.ElectronApp, {})),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("offers a staged build of the same app that is newer than the running one", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* stateWith((staged) => writeBundle(staged, NEWER)), {
      builtAt: NEWER_ISO,
    });
  }),
);

it.effect("offers nothing when no build is staged", () =>
  Effect.gen(function* () {
    assert.isNull(yield* stateWith(() => Effect.void));
  }),
);

it.effect("ignores a staged build that is not newer, such as the one just swapped out", () =>
  Effect.gen(function* () {
    assert.isNull(yield* stateWith((staged) => writeBundle(staged, OLDER)));
  }),
);

it.effect("refuses to replace the app with a bundle of a different application", () =>
  Effect.gen(function* () {
    assert.isNull(yield* stateWith((staged) => writeBundle(staged, NEWER, "com.example.other")));
  }),
);
