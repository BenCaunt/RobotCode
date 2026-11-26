# Track evaluation results

Open your project in the sidebar (the thread list on mobile), then choose **Evaluations**. On desktop and web, **Experiment history** opens first. Each follow-up run appears beneath the baseline it cites. Searching keeps matching runs and their ancestors visible. Choose **All results** to browse by category. On mobile, Evaluations opens the category list. Search for a run name, category, date, or full ID. Open a result to read its Markdown summary and inspect the setup, revision, and evidence behind it. On mobile, tap **Provenance** to see those details.

Copy the result ID into a chat, an issue, or the next evaluation’s baseline. On web and desktop you can also copy the result link from its entry in the list. A link opens the report for someone with access to the same environment and project.

## Publish a run

Have your evaluation harness write a JSON manifest when a run finishes. Set the timestamp, software revision, and setup to the values used **during the run**. Use `physical` for a hardware trial and `simulation` for a simulated run. List the recording, measurements, controller configuration, and calibration files you want to track, using paths relative to the project root.

For a small example, save this simulated fixture as `manifest.json` in your project:

````json
{
  "version": 1,
  "category": "navigation",
  "name": "turn-controller",
  "title": "Turn controller settling time",
  "mode": "simulation",
  "recordedAt": "2026-04-05T12:00:00Z",
  "primaryMetric": { "label": "Settling time", "value": 1.2, "unit": "s", "baselineValue": 1.6 },
  "revision": "sim-fixture-v1",
  "setup": "Synthetic comparison, identical start pose and target yaw",
  "evidence": ["settling-time.csv"],
  "summary": "## Settling time\n\nThe candidate settled **0.4 s sooner**.\n\n```mermaid\nxychart-beta\n  x-axis [Baseline, Candidate]\n  y-axis \"Seconds\" 0 --> 2\n  bar [1.6, 1.2]\n```"
}
````

Create the example measurements and publish the report from the project root:

```sh
printf 'controller,seconds\nbaseline,1.6\ncandidate,1.2\n' > settling-time.csv
t3 evaluation publish manifest.json
```

The command prints the ID and writes the report to `evaluations/<id>.json`. **Refresh** the Evaluations tab to see it. If your harness runs from another directory, pass `--project /path/to/project`. From a source checkout, substitute `node apps/server/src/bin.ts` for `t3`.

For a follow-up run, add `"baseline": "<previous result ID>"` to its manifest. Both reports keep their own summaries and evidence fingerprints. Use Markdown tables, embedded plot images, or fenced Mermaid charts in the summary. Relative Markdown media paths start in the report’s `evaluations/` folder.

Publishing hashes each listed file with SHA-256. The result ID combines the category, UTC date, run name, and a digest of the report. Repeating the same publication returns the same ID. Changing the measurements, metadata, or summary produces a new ID. The app checks the report against its ID whenever it loads it.

Keep the report and its original evidence together in version control or an artifact archive. The report stores file paths and fingerprints. Large recordings stay in your chosen storage.

## Write a report someone can inspect

Choose the main measure from the evaluation protocol. Set `primaryMetric` to its label, numeric value, and unit to display it on the right of the history row and in the report. Supply `baselineValue` when both values use the same conditions and sample. Older reports without this field still open by their original IDs.

Lead with what changed and what the measured difference means. Give the denominator and split, show a labeled comparison, and explain a representative failure or trade-off. To include a saved figure, list its project-relative path in evidence and embed it in the summary, for example `![Successes by scene](./figures/success.png)` for `evaluations/figures/success.png`. Cite a recorded moment when it helps explain the outcome. Close with the limitation that matters for the next run.

For a hill climb, record why each candidate was tried, the alternatives, training scores, tie-break and frozen revision. Show a decision the reader can inspect. A navigation example pairs a camera frame with its bird’s-eye prediction, the chosen waypoint and the evaluator’s collision result at that step. Label a diagnostic rerun with the original run it reproduces. State which explanations remain open and what ablation could distinguish them.

## Replay a cited moment

List a Rerun recording in `evidence` to make it playable from **Replay evidence** on the report. To cite an observation, include its position in the same manifest. For example, these fields point to the first wheel slip at 12.4 seconds on the recording’s `elapsed` timeline.

```json
{
  "evidence": ["logs/ramp.rrd"],
  "replayCitations": [
    {
      "id": "wheel-slip",
      "label": "Front wheels begin to slip",
      "path": "logs/ramp.rrd",
      "timeline": "elapsed",
      "timeType": "duration",
      "time": "12400000000"
    }
  ]
}
```

Use a unique lowercase slug for each citation. Specify `duration` or `timestamp` in nanoseconds, or `sequence` in frames or steps. Write the integer as a string to preserve precision. If a file contains several recordings, include the full Rerun store ID in `recordingId` to select one.

You can also link the observation from your Markdown summary, for example `The front wheels began slipping at [12.4 s](t3-context://v1/replay/wheel-slip).`

Click a citation to pause at that position. Copy the citation link to share the same view with someone who has access to the project. On mobile, select **Replay evidence** and open the link in a browser paired to that environment. The viewer checks the recording’s SHA-256 before displaying it. If the file has changed, restore the original bytes or publish the new recording as another result.
