# Recording tiles

Ask the agent to build a tile from recorded or simulated data. Open the resulting `.tile.html` link in the conversation to keep it beside your work. The agent can also show an interactive copy in chat on web, desktop, and mobile.

> Make a field map from this walk. Put the atlas track across the top and the front camera beside XY allowance underneath. Use recording time for all three and lay them out on one canvas without cards.

Click a plot or scrub the time slider to inspect the same instant across views. **Play** advances the clock. The camera shows the acquisition time and age of the displayed frame. A sample appears when the clock reaches its timestamp.

> Put angular speed beside measured angle in my bench tile. Keep the existing sources and rebuild the same file.

The project file view keeps the selected time when the agent rebuilds the open tile. A copy posted in chat records the version shown in that reply.

## Build the examples

From a Robot Code checkout with the updated CLI installed:

```sh
t3 tile build examples/tiles/field-map.tile.json
t3 tile build examples/tiles/step-response.tile.json
```

When working from source, substitute `node apps/server/src/bin.ts` for `t3`. Each command prints the absolute path of its self-contained HTML output. The examples include their source data and work offline.

The [field map](../../examples/tiles/field-map.tile.json) samples the Go2 localization replay from the 15:06 block walk. It overlays the estimated track on the atlas raster, plots the XY engineering allowance in meters, and shows downsampled front-camera frames. The [bench tile](../../examples/tiles/step-response.tile.json) uses the simulated 0.6 rad calf step experiment. It plots target angle, measured angle, and angular speed. Its XY view traces target angle on the horizontal axis and measured angle on the vertical axis.

## Compose a tile

Run `t3 tile schema` to discover the supported source shapes and widget properties. Run `t3 tile inspect examples/tiles/field-map.sources.json` for a compact list of source names, units, frames, and time ranges. A version 1 manifest names its sources and arranges widgets in rows. Sources can be inline or in a JSON dictionary relative to the manifest. For example:

```json
{
  "version": 1,
  "title": "Bench current",
  "sources": {
    "motor": {
      "kind": "scalar",
      "unit": "A",
      "samples": [
        [0, 0.2],
        [0.1, 1.4],
        [0.2, 0.7]
      ]
    }
  },
  "rows": [[{ "kind": "plot", "title": "Motor current", "source": "motor" }]]
}
```

Save it as `bench.tile.json` and run `t3 tile build bench.tile.json`. A project adapter can export samples from CSV, Rerun, or a capture log. Convert every stream to the same clock in seconds and order samples by time before building. XY tracks and raster backgrounds share a coordinate frame and unit. Raster bounds are left, bottom, right, and top with positive Y up. Supply camera frames and rasters as embedded PNG, JPEG, or WebP data URLs. For long recordings, select the interval and resolution needed for the question.
