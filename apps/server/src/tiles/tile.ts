import * as Schema from "effect/Schema";

const label = Schema.NonEmptyString;
const number = Schema.Finite;
const image = Schema.String.check(
  Schema.isPattern(/^data:image\/(?:png|webp|jpeg);base64,[a-zA-Z0-9+/]+=*$/),
);
const space = { frame: label, unit: label };
export const TileSources = Schema.Record(
  label,
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("xy"),
      ...space,
      samples: Schema.NonEmptyArray(Schema.Tuple([number, number, number])).annotate({
        description: "Strictly increasing [time in seconds, x, y] samples.",
      }),
    }),
    Schema.Struct({
      kind: Schema.Literal("scalar"),
      unit: label,
      samples: Schema.NonEmptyArray(Schema.Tuple([number, number])).annotate({
        description: "Strictly increasing [time in seconds, value] samples.",
      }),
    }),
    Schema.Struct({
      kind: Schema.Literal("frames"),
      samples: Schema.NonEmptyArray(Schema.Tuple([number, image])).annotate({
        description: "Strictly increasing [time in seconds, raster image data URL] frames.",
      }),
    }),
    Schema.Struct({
      kind: Schema.Literal("raster"),
      ...space,
      bounds: Schema.Tuple([number, number, number, number]).annotate({
        description: "[left, bottom, right, top] in the XY source frame, positive Y up.",
      }),
      image,
    }),
  ]),
);
const widget = { title: label, source: label };
const TileWidget = Schema.Union([
  Schema.Struct({ ...widget, kind: Schema.Literal("map"), background: Schema.optionalKey(label) }),
  Schema.Struct({ ...widget, kind: Schema.Literal("camera") }),
  Schema.Struct({ ...widget, kind: Schema.Literal("plot") }),
]);
export const TileManifest = Schema.Struct({
  version: Schema.Literal(1),
  title: label,
  subtitle: Schema.optionalKey(label),
  initialTime: Schema.optionalKey(number),
  sources: Schema.Union([
    TileSources,
    label.annotate({ description: "JSON source dictionary, relative to this manifest." }),
  ]),
  rows: Schema.NonEmptyArray(Schema.NonEmptyArray(TileWidget)),
});
export type Tile = Omit<typeof TileManifest.Type, "sources"> & {
  readonly sources: typeof TileSources.Type;
};

export function tileIssue(tile: Tile): string | undefined {
  for (const [name, source] of Object.entries(tile.sources)) {
    if (source.kind === "raster") {
      const [left, bottom, right, top] = source.bounds;
      if (left >= right || bottom >= top)
        return name + " needs increasing raster bounds [left, bottom, right, top].";
    } else if (source.samples.some(([time], i) => i > 0 && time <= source.samples[i - 1]![0])) {
      return name + " needs strictly increasing sample times in seconds.";
    }
  }
  for (const row of tile.rows) {
    for (const widget of row) {
      const source = Object.hasOwn(tile.sources, widget.source)
        ? tile.sources[widget.source]
        : undefined;
      const kind = { map: "xy", plot: "scalar", camera: "frames" }[widget.kind];
      if (source?.kind !== kind)
        return widget.title + " requires a " + kind + " source at " + widget.source + ".";
      if (widget.kind === "map" && widget.background !== undefined && source.kind === "xy") {
        const bg = tile.sources[widget.background];
        if (bg?.kind !== "raster" || bg.frame !== source.frame || bg.unit !== source.unit)
          return (
            widget.title + " requires a raster in the same frame and unit as " + widget.source + "."
          );
      }
    }
  }
}
