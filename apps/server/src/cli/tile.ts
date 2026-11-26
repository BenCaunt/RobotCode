import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";
import { TileManifest, TileSources, tileIssue } from "../tiles/tile.ts";

class TileBuildError extends Schema.TaggedError<TileBuildError>()("TileBuildError", {
  message: Schema.String,
}) {}

const encodeJson = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(TileManifest));
const decodeSources = Schema.decodeEffect(Schema.fromJsonString(TileSources));

const build = Command.make("build", { manifest: Argument.String("manifest") }).pipe(
  Command.withDescription(
    "Build a project .tile.json file into a sibling .tile.html for Robot Code.",
  ),
  Command.withHandler(
    Effect.fn("Tile.build")(function* ({ manifest }) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      if (!manifest.endsWith(".tile.json"))
        return yield* new TileBuildError({ message: "Expected a .tile.json manifest." });
      const spec = yield* decodeManifest(yield* fs.readFileString(manifest), {
        onExcessProperty: "error",
      });
      const sources =
        typeof spec.sources === "string"
          ? yield* decodeSources(
              yield* fs.readFileString(path.resolve(path.dirname(manifest), spec.sources)),
              { onExcessProperty: "error" },
            )
          : spec.sources;
      const tile = { ...spec, sources };
      const issue = tileIssue(tile);
      if (issue) return yield* new TileBuildError({ message: issue });
      const output = path.resolve(manifest.replace(/\.json$/, ".html"));
      const { renderTile } = yield* Effect.promise(() => import("../tiles/tilePage.ts"));
      yield* writeFileStringAtomically({ filePath: output, contents: renderTile(tile) });
      yield* Console.log(output);
    }),
  ),
);
const inspect = Command.make("inspect", { sources: Argument.String("sources.json") }).pipe(
  Command.withDescription(
    "List source names, types, units, frames, and time ranges without printing sample data.",
  ),
  Command.withHandler(
    Effect.fn("Tile.inspect")(function* ({ sources }) {
      const fs = yield* FileSystem.FileSystem;
      const catalog = yield* decodeSources(yield* fs.readFileString(sources), {
        onExcessProperty: "error",
      });
      const summary = Object.entries(catalog).map(([name, source]) => ({
        name,
        kind: source.kind,
        ...("unit" in source ? { unit: source.unit } : {}),
        ...("frame" in source ? { frame: source.frame } : {}),
        ...(source.kind === "raster"
          ? { bounds: source.bounds }
          : {
              count: source.samples.length,
              startSeconds: source.samples[0][0],
              endSeconds: source.samples[source.samples.length - 1]![0],
            }),
      }));
      yield* Console.log(yield* encodeJson(summary));
    }),
  ),
);
const schema = Command.make("schema").pipe(
  Command.withDescription(
    "Print the v1 authoring schema for layouts, source types, and widget bindings.",
  ),
  Command.withHandler(() => {
    const doc = Schema.toJsonSchemaDocument(TileManifest, { onExcessProperty: "error" });
    return encodeJson({ ...doc.schema, $defs: doc.definitions }).pipe(Effect.flatMap(Console.log));
  }),
);
export const tileCommand = Command.make("tile").pipe(
  Command.withDescription("Compose synchronized map, plot, and camera widgets from recorded data."),
  Command.withSubcommands([schema, inspect, build]),
);
