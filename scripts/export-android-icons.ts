#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const assets = path.join(root, "apps/mobile/assets");
  const mark = yield* fs.readFile(path.join(root, "assets/prod/app-icon.icon/Assets/robot.svg"));
  const monochrome = yield* fs.readFile(path.join(assets, "widget/RobotMark.svg"));

  const render = Effect.fn("androidIcons.render")(function* (
    name: string,
    source: Uint8Array,
    canvas: number,
    size: number,
    background: string | typeof TRANSPARENT,
  ) {
    const contents = yield* Effect.tryPromise({
      try: async () => {
        const layer = await sharp(source)
          .resize(size, size, { fit: "contain", background: TRANSPARENT })
          .png()
          .toBuffer();
        return sharp({ create: { width: canvas, height: canvas, channels: 4, background } })
          .composite([{ input: layer, gravity: "centre" }])
          .png()
          .toBuffer();
      },
      catch: (cause) => new AndroidIconRenderError({ layer: name, cause }),
    });
    yield* fs.writeFile(path.join(assets, name), contents);
    yield* Console.log(`wrote ${name}`);
  });

  // Android masks the middle 72dp of a 108dp adaptive canvas.
  yield* render("android-icon-foreground.png", mark, 432, 352, TRANSPARENT);
  yield* render("android-icon-mark.png", monochrome, 432, 208, TRANSPARENT);
  yield* render("android-notification-icon.png", monochrome, 96, 88, TRANSPARENT);
  for (const [channel, color] of Object.entries({
    dev: "#195660",
    nightly: "#292D4F",
    prod: "#073E40",
  })) {
    yield* render(`android-splash-icon-${channel}.png`, mark, 1152, 936, color);
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
