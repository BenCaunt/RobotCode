import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as Sqlite from "../src/persistence/Sqlite.ts";
import * as RobotTelemetry from "../src/robotics/RobotTelemetry.ts";
import * as RobotTelemetryHooks from "../src/robotics/RobotTelemetryHooks.ts";
import * as RoboticsEvidence from "../src/robotics/RoboticsEvidence.ts";

const projectId = "simulation-demo";
const robotId = "demo-robot";
const stream = { projectId, streamId: "localization" };
const hook = { projectId, hookId: "localization-covariance" };
const settings = {
  covarianceLimit: 0.5,
  initialCovariance: 0.03,
  seed: 229,
  timestepMs: 100,
  deadlineMs: 30_000,
  maxRetries: 1,
};
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const run = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fs.makeTempDirectory({ prefix: "robotcode-evidence-" });
  const databasePath = path.join(directory, "evidence.sqlite");
  const repoRoot = yield* path.fromFileUrl(new URL("../../..", import.meta.url));
  const gitRevision = (yield* spawner.string(
    ChildProcess.make("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
  )).trim();

  const artifact = Effect.fn("RoboticsEvidenceDemo.artifact")(function* (
    artifactId: string,
    value: unknown,
  ) {
    const json = yield* encodeJson(value);
    const hash = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)),
    );
    yield* fs.writeFileString(path.join(directory, artifactId), json);
    return { artifactId, version: `sha256:${Buffer.from(hash).toString("hex")}` };
  });

  const sourcePaths = [
    "apps/server/scripts/robotics-evidence-demo.ts",
    "apps/server/src/robotics/RoboticsEvidence.ts",
    "apps/server/src/robotics/RoboticsEvidenceModel.ts",
    "apps/server/src/robotics/RobotTelemetry.ts",
    "apps/server/src/robotics/RobotTelemetryHooks.ts",
  ];
  const sources = yield* Effect.forEach(sourcePaths, (filename) =>
    fs
      .readFileString(path.join(repoRoot, filename))
      .pipe(Effect.map((source) => ({ filename, source }))),
  );
  const dirtyTree = yield* artifact("simulation-source.json", { gitRevision, sources });
  const configuration = yield* artifact("configuration.json", settings);
  const simulator = yield* Ref.make({ position: 0, covariance: settings.initialCovariance });

  const resetVerifier = Layer.succeed(RoboticsEvidence.ExperimentResetVerifier, {
    verify: Effect.fn("RoboticsEvidenceDemo.verifyReset")(function* (experiment, intervention) {
      const observed = yield* Ref.get(simulator);
      if (
        experiment.robotId !== robotId ||
        observed.position !== 0 ||
        observed.covariance > settings.initialCovariance
      )
        return Option.none();
      return yield* artifact("reset-probe.json", {
        observed,
        interventionId: intervention.id,
      }).pipe(Effect.option);
    }),
  });
  const database = Sqlite.layerFromPath(databasePath);
  const services = Layer.mergeAll(
    RoboticsEvidence.layer.pipe(Layer.provide(resetVerifier)),
    RobotTelemetryHooks.layer,
  ).pipe(Layer.provideMerge(RobotTelemetry.layer), Layer.provide(database));

  const outcome = yield* Effect.gen(function* () {
    const records = yield* RoboticsEvidence.RoboticsEvidence;
    const telemetry = yield* RobotTelemetry.RobotTelemetry;
    const hooks = yield* RobotTelemetryHooks.RobotTelemetryHooks;
    const planned = yield* records.planExperiment({
      projectId,
      idempotencyKey: "navigation-trial",
      objective: "Verify recovery from a simulated localization covariance excursion",
      robotId,
      hostId: "local-simulation",
      mode: "simulation",
      provenance: {
        gitRevision,
        dirtyTree,
        configuration,
        initialState: "Origin with identity heading and low covariance",
        seeds: [settings.seed],
      },
      limits: { maxDurationMs: settings.deadlineMs, maxRetries: settings.maxRetries },
    });
    const experimentKey = { projectId, id: planned.id };
    const started = yield* records.changeExperiment({
      ...experimentKey,
      expectedRevision: planned.revision,
      change: { type: "start" },
    });
    yield* telemetry.register({
      ...stream,
      schemaId: "demo-localization-v1",
      sourceId: robotId,
      clockDomain: "simulation_ms",
      coordinateFrame: "world",
      expectedHz: 10,
      staleAfterMs: 2_000,
      retentionMs: settings.deadlineMs,
      maxSamples: 32,
      metrics: [
        { name: "position", unit: "m" },
        { name: "covariance", unit: "m^2" },
      ],
    });
    const producer = yield* telemetry.connect(stream);
    yield* hooks.register({
      ...hook,
      streamId: stream.streamId,
      version: "1",
      lifetimeMs: settings.deadlineMs,
      cooldownMs: 5_000,
      maxTriggers: 1,
      preEventMs: 1_000,
      postEventMs: 0,
      evaluator: {
        kind: "threshold",
        metric: "covariance",
        comparison: "above",
        value: settings.covarianceLimit,
        durationMs: 0,
        maxGapMs: 1_000,
      },
    });
    const publish = Effect.fn("RoboticsEvidenceDemo.publish")(function* (
      sequence: number,
      values: { readonly position: number; readonly covariance: number },
    ) {
      yield* Ref.set(simulator, values);
      yield* telemetry.ingest(stream, producer, {
        sequence,
        sourceTimestampMs: sequence * settings.timestepMs,
        synchronization: { unixMs: yield* Clock.currentTimeMillis, uncertaintyMs: 0 },
        values,
      });
      return yield* hooks.evaluate(hook);
    });
    yield* publish(0, { position: 0.1, covariance: settings.initialCovariance });
    const event = yield* publish(1, { position: 2.8, covariance: (settings.seed % 17) / 10 });
    if (event === null)
      return yield* Effect.die("The injected localization excursion did not trigger the hook.");
    const excerpt = yield* artifact("localization-event.json", event);
    const annotation = yield* records.addAnnotation({
      projectId,
      idempotencyKey: event.eventId,
      authorId: "demo-reviewer",
      comment: "Position jumps as localization covariance exceeds the limit.",
      selection: {
        recording: excerpt,
        timeline: "simulation_ms",
        start: String(event.sample.sourceTimestampMs),
        entityPaths: ["/localization/position", "/localization/covariance"],
        excerpt,
      },
    });
    const request = {
      projectId,
      idempotencyKey: event.eventId,
      experimentId: started.id,
      evidence: [excerpt],
      requestedAction: "Reset the simulator to the origin and acknowledge completion.",
      urgency: "routine" as const,
      expiresAtMs: (yield* Clock.currentTimeMillis) + 10_000,
      allowedResponses: ["action-completed", "assistance-needed"] as const,
    };
    const intervention = yield* records.requestIntervention(request);
    const replay = yield* records.requestIntervention(request);
    if (replay.id !== intervention.id) return yield* Effect.die("The intervention was duplicated.");
    const response = {
      projectId,
      id: intervention.id,
      actorId: "simulated-operator",
      deliveryId: "reset-completed",
      value: "action-completed" as const,
    };
    const waiting = yield* records.get({ ...experimentKey, kind: "experiment" });
    const resume = {
      ...experimentKey,
      expectedRevision: waiting.revision,
      interventionId: intervention.id,
    };
    yield* records.respondIntervention(response);
    const blocked = yield* Effect.flip(records.resumeExperiment(resume));
    if (blocked._tag !== "RoboticsEvidenceError" || blocked.category !== "reset-unverified") {
      return yield* Effect.die("The experiment was not blocked by the failed reset probe.");
    }
    yield* Ref.set(simulator, { position: 0, covariance: settings.initialCovariance });
    const resumed = yield* records.resumeExperiment(resume);
    const finalPosition = 0.5;
    yield* publish(2, { position: finalPosition, covariance: settings.initialCovariance });
    yield* telemetry.disconnect(stream, producer);
    const window = yield* telemetry.query(stream);
    const recording = yield* artifact("telemetry-window.json", window);
    const withEvidence = yield* records.changeExperiment({
      ...experimentKey,
      expectedRevision: resumed.revision,
      change: {
        type: "evidence",
        jobs: [],
        leases: [],
        streams: [stream.streamId],
        evidence: [excerpt, recording],
        metrics: [{ name: "finalPosition", value: finalPosition, unit: "m" }],
      },
    });
    const completed = yield* records.changeExperiment({
      ...experimentKey,
      expectedRevision: withEvidence.revision,
      change: {
        type: "finish",
        outcome: { status: "completed", summary: "Verified reset and resumed simulation." },
      },
    });
    const journal = yield* hooks.events(projectId);
    if (journal.length !== 1 || journal[0]?.eventId !== event.eventId) {
      return yield* Effect.die("The hook journal did not retain exactly one localization event.");
    }
    return { completed, annotation, interventionId: intervention.id, eventCount: journal.length };
  }).pipe(Effect.provide(services));

  const reopened = yield* Effect.gen(function* () {
    const records = yield* RoboticsEvidence.RoboticsEvidence;
    const experiment = yield* records.get({
      projectId,
      kind: "experiment",
      id: outcome.completed.id,
    });
    const intervention = yield* records.get({
      projectId,
      kind: "intervention",
      id: outcome.interventionId,
    });
    const annotation = yield* records.get({
      projectId,
      kind: "annotation",
      id: outcome.annotation.id,
    });
    if (
      experiment.kind !== "experiment" ||
      experiment.state !== "completed" ||
      intervention.kind !== "intervention" ||
      intervention.status !== "consumed" ||
      annotation.kind !== "annotation" ||
      annotation.selection.start !== outcome.annotation.selection.start
    ) {
      return yield* Effect.die("The persisted evidence did not match the completed simulation.");
    }
    return { experiment, intervention, annotation };
  }).pipe(Effect.provide(RoboticsEvidence.layer.pipe(Layer.provide(database))));

  return { directory, databasePath, hookEvents: outcome.eventCount, ...reopened };
}).pipe(
  Effect.provide([NodeServices.layer, NodeCrypto.layer]),
  Effect.provideService(References.MinimumLogLevel, "Error"),
);

await Effect.runPromise(
  Effect.flatMap(run, (result) => Console.log(JSON.stringify(result, null, 2))),
);
