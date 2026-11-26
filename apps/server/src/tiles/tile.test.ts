import { describe, expect, it } from "vite-plus/test";
import { tileIssue, type Tile } from "./tile.ts";

const tile: Tile = {
  version: 1,
  title: "XY stage",
  sources: {
    travel: {
      kind: "xy",
      unit: "mm",
      frame: "stage",
      samples: [
        [0, 0, 0],
        [1, 2, 3],
      ],
    },
    surface: {
      kind: "raster",
      unit: "mm",
      frame: "stage",
      bounds: [0, 0, 5, 5],
      image: "data:image/png;base64,AA==",
    },
  },
  rows: [[{ kind: "map", title: "Travel", source: "travel", background: "surface" }]],
};
describe("tile bindings", () => {
  it("requires a shared coordinate frame and units for map layers", () => {
    expect(tileIssue(tile)).toBeUndefined();
    const source = tile.sources.surface;
    if (source?.kind !== "raster") throw new Error("Expected a raster");
    for (const change of [{ frame: "camera" }, { unit: "m" }]) {
      expect(
        tileIssue({ ...tile, sources: { ...tile.sources, surface: { ...source, ...change } } }),
      ).toContain("same frame and unit");
    }
  });
  it("rejects incompatible bindings and unordered clocks", () => {
    expect(
      tileIssue({ ...tile, rows: [[{ kind: "plot", title: "Travel", source: "travel" }]] }),
    ).toContain("scalar");
    expect(
      tileIssue({
        ...tile,
        sources: {
          ...tile.sources,
          speed: {
            kind: "scalar",
            unit: "mm/s",
            samples: [
              [1, 2],
              [1, 3],
            ],
          },
        },
      }),
    ).toContain("increasing sample times");
  });
});
