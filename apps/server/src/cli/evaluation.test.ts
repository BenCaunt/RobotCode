import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { groupEvaluationEntries, readEvaluationReport } from "@t3tools/shared/evaluationReport";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { publishEvaluation } from "./evaluation.ts";

it.effect("publishes concurrent retries once and pins the version of each source", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const manifest = path.join(root, "run.json");
    const source = path.join(root, "capture.csv");
    const draft = {
      version: 1,
      category: "locomotion",
      name: "ramp-test",
      title: "Ramp test",
      mode: "physical",
      recordedAt: "2026-04-05T12:34:56Z",
      revision: "firmware-3",
      setup: "Rig A, calibration 12",
      evidence: ["capture.csv"],
      summary: "## Result\nReached 8°.",
    };
    yield* fs.writeFileString(manifest, JSON.stringify(draft));
    yield* fs.writeFileString(source, "abc");
    const [id, retry] = yield* Effect.all(
      [publishEvaluation(manifest, root), publishEvaluation(manifest, root)],
      { concurrency: "unbounded" },
    );
    expect(id).toBe(retry);
    const directory = path.join(root, "evaluations");
    expect(yield* fs.readDirectory(directory)).toEqual([id + ".json"]);
    const original = yield* fs.readFileString(path.join(directory, id + ".json"));
    expect(readEvaluationReport(id, original)?.evidence[0].sha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(readEvaluationReport(id, original.replace("Reached 8", "Reached 9"))).toBeNull();
    yield* fs.writeFileString(source, "abcd");
    yield* fs.writeFileString(manifest, JSON.stringify({ ...draft, baseline: id }));
    const changed = yield* publishEvaluation(manifest, root);
    expect(changed).not.toBe(id);
    const followup = yield* fs.readFileString(path.join(directory, changed + ".json"));
    expect(readEvaluationReport(changed, followup)?.baseline).toBe(id);
    expect(readEvaluationReport(changed, followup)?.evidence[0].sha256).not.toBe(
      readEvaluationReport(id, original)?.evidence[0].sha256,
    );
    expect(yield* fs.readFileString(path.join(directory, id + ".json"))).toBe(original);
    const entries = (yield* fs.readDirectory(directory)).map((name) => ({
      kind: "file",
      path: "evaluations/" + name,
    }));
    expect(groupEvaluationEntries(entries, id)[0]?.results.map((item) => item.id)).toEqual([id]);
    expect(groupEvaluationEntries(entries, "ramp test")[0]?.results).toHaveLength(2);
    const citation = {
      id: "wheel-slip",
      label: "Wheel slip",
      path: "run.rrd",
      timeline: "elapsed",
      timeType: "duration",
      time: "12400000000",
    };
    yield* fs.writeFileString(path.join(root, "run.rrd"), "recording");
    const replay = { ...draft, evidence: ["run.rrd"], replayCitations: [citation] };
    yield* fs.writeFileString(manifest, JSON.stringify(replay));
    const replayId = yield* publishEvaluation(manifest, root);
    const replayContents = yield* fs.readFileString(path.join(directory, replayId + ".json"));
    expect(readEvaluationReport(replayId, replayContents)?.replayCitations).toEqual([citation]);
    for (const replayCitations of [
      [citation, citation],
      [{ ...citation, path: "unlisted.rrd" }],
      [{ ...citation, path: "capture.csv" }],
      [{ ...citation, time: "12.4" }],
      [{ ...citation, time: "9223372036854775808" }],
    ]) {
      yield* fs.writeFileString(manifest, JSON.stringify({ ...replay, replayCitations }));
      expect(yield* Effect.isFailure(publishEvaluation(manifest, root))).toBe(true);
    }
    yield* fs.writeFileString(manifest, JSON.stringify({ ...draft, evidence: ["../capture.csv"] }));
    expect(yield* Effect.isFailure(publishEvaluation(manifest, root))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
