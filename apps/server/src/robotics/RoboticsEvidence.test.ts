import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as RoboticsEvidence from "./RoboticsEvidence.ts";

const configuration = { artifactId: "navigation-config", version: "sha256:config" };
const resetProbe = { artifactId: "sim-reset-probe", version: "sha256:probe" };
const plan = {
  projectId: "project",
  idempotencyKey: "plan",
  objective: "Compare the simulated navigation candidates",
  robotId: "sim-robot",
  hostId: "worker",
  mode: "simulation" as const,
  provenance: {
    gitRevision: "a".repeat(40),
    configuration,
    initialState: "Stationary at the simulation origin",
    seeds: [229],
  },
  limits: { maxDurationMs: 10_000, maxRetries: 1 },
};
const request = {
  projectId: plan.projectId,
  idempotencyKey: "assist",
  evidence: [configuration],
  requestedAction: "Reset the simulator pose",
  urgency: "routine" as const,
  expiresAtMs: 5_000,
  allowedResponses: ["acknowledged", "action-completed"] as const,
};
const setup = Effect.gen(function* () {
  const service = yield* RoboticsEvidence.RoboticsEvidence;
  const planned = yield* service.planExperiment(plan);
  const experimentKey = { projectId: plan.projectId, id: planned.id };
  yield* service.changeExperiment({
    ...experimentKey,
    expectedRevision: planned.revision,
    change: { type: "start" },
  });
  const intervention = yield* service.requestIntervention({ ...request, experimentId: planned.id });
  const waiting = yield* service.get({ ...experimentKey, kind: "experiment" });
  return {
    service,
    experimentKey,
    intervention,
    resume: {
      ...experimentKey,
      expectedRevision: waiting.revision,
      interventionId: intervention.id,
    },
    response: {
      projectId: plan.projectId,
      id: intervention.id,
      actorId: "operator-session",
      deliveryId: "response-delivery",
      value: "action-completed" as const,
    },
  };
});
const serviceLayer = RoboticsEvidence.layer.pipe(Layer.provide(SecureRandom.layerWebCrypto));
const evidenceLayer = serviceLayer.pipe(Layer.provide(Sqlite.layerMemory));

it.effect(
  "persists precise annotation context across service instances and deduplicates writes",
  () =>
    Effect.gen(function* () {
      const selection = {
        recording: { artifactId: "navigation-log", version: "sha256:log" },
        timeline: "sensor_time",
        start: "1724002220123456789",
        end: "1724002220123456790",
        entityPaths: ["/camera", "/base/pose"],
        imageRegion: { x: 12, y: 8, width: 200, height: 100 },
        view: configuration,
      };
      const input = {
        projectId: plan.projectId,
        idempotencyKey: "annotate",
        authorId: "operator-session",
        comment: "The pose flickers here",
        selection,
      };
      const record = yield* Effect.gen(function* () {
        const service = yield* RoboticsEvidence.RoboticsEvidence;
        const [first, second] = yield* Effect.all(
          [service.addAnnotation(input), service.addAnnotation(input)],
          { concurrency: "unbounded" },
        );
        assert.deepEqual(first, second);
        const conflict = yield* Effect.flip(
          service.addAnnotation({ ...input, comment: "Different note" }),
        );
        assert.propertyVal(conflict, "category", "conflict");
        const invalid = yield* Effect.flip(
          service.addAnnotation({
            ...input,
            idempotencyKey: "invalid",
            selection: { ...selection, end: "1724002220123456788" },
          }),
        );
        assert.propertyVal(invalid, "category", "invalid");
        return first;
      }).pipe(Effect.provide(serviceLayer));
      yield* Effect.gen(function* () {
        const service = yield* RoboticsEvidence.RoboticsEvidence;
        const key = { projectId: plan.projectId, kind: "annotation" as const, id: record.id };
        const reopened = yield* service.get(key);
        assert.deepEqual(reopened, record);
        const missing = yield* Effect.flip(service.get({ ...key, projectId: "another-project" }));
        assert.propertyVal(missing, "category", "missing");
        const stale = yield* Effect.flip(
          service.editAnnotation({
            projectId: key.projectId,
            id: key.id,
            expectedRevision: 2,
            change: {
              type: "reply",
              id: "early",
              authorId: "diagnostic",
              comment: "Investigating",
            },
          }),
        );
        assert.propertyVal(stale, "category", "conflict");
        assert.deepEqual(yield* service.get(key), record);
        const handoff = yield* service.editAnnotation({
          projectId: key.projectId,
          id: key.id,
          expectedRevision: record.revision,
          change: { type: "linkHandoff", threadId: "diagnostic-thread" },
        });
        assert.deepEqual(handoff.selection, selection);
        assert.equal(handoff.handoffThreadId, "diagnostic-thread");
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "records an intervention exactly once and rejects stale or unauthorized response values",
  () =>
    Effect.gen(function* () {
      const { service, intervention, experimentKey, resume, response } = yield* setup;
      const duplicate = yield* service.requestIntervention({
        ...request,
        experimentId: experimentKey.id,
      });
      assert.equal(duplicate.id, intervention.id);
      assert.deepEqual(
        (yield* service.list({ projectId: plan.projectId, kind: "intervention" })).items,
        [intervention],
      );
      const unauthorized = yield* Effect.flip(
        service.respondIntervention({ ...response, value: "assistance-needed" }),
      );
      assert.propertyVal(unauthorized, "category", "invalid-state");
      const answered = yield* service.respondIntervention(response);
      assert.deepEqual(yield* service.respondIntervention(response), answered);
      const spoofed = yield* Effect.flip(
        service.respondIntervention({ ...response, actorId: "other" }),
      );
      assert.propertyVal(spoofed, "category", "conflict");
      assert.propertyVal(
        yield* Effect.flip(service.resumeExperiment(resume)),
        "category",
        "reset-unverified",
      );
      yield* TestClock.setTime(request.expiresAtMs);
      const stale = yield* Effect.flip(
        service.respondIntervention({ ...response, deliveryId: "late" }),
      );
      assert.propertyVal(stale, "category", "expired");
      assert.propertyVal(
        yield* service.get({
          projectId: plan.projectId,
          kind: "intervention",
          id: intervention.id,
        }),
        "status",
        "expired",
      );
    }).pipe(Effect.provide(evidenceLayer)),
);

it.effect(
  "requires a verified reset, consumes the intervention once, and retains failure evidence",
  () =>
    Effect.gen(function* () {
      const { service, experimentKey, intervention, resume, response } = yield* setup;
      yield* service.respondIntervention({ ...response, value: "acknowledged" });
      assert.propertyVal(
        yield* Effect.flip(service.resumeExperiment(resume)),
        "category",
        "invalid-state",
      );
      const followUp = yield* service.requestIntervention({
        ...request,
        idempotencyKey: "new-request",
        experimentId: experimentKey.id,
      });
      yield* service.respondIntervention({
        ...response,
        id: followUp.id,
        deliveryId: "followup-response",
      });
      assert.equal(intervention.id === followUp.id, false);
      const waiting = yield* service.get({ ...experimentKey, kind: "experiment" });
      const resumed = yield* service.resumeExperiment({
        ...resume,
        interventionId: followUp.id,
        expectedRevision: waiting.revision,
      });
      assert.equal(resumed.state, "running");
      assert.equal(resumed.retries, 1);
      assert.deepEqual(resumed.evidence, [resetProbe]);
      const staleResume = yield* Effect.flip(
        service.resumeExperiment({
          ...resume,
          interventionId: followUp.id,
          expectedRevision: waiting.revision,
        }),
      );
      assert.propertyVal(staleResume, "category", "conflict");
      assert.propertyVal(
        yield* service.get({ projectId: plan.projectId, kind: "intervention", id: followUp.id }),
        "status",
        "consumed",
      );
      const failed = yield* service.changeExperiment({
        ...experimentKey,
        expectedRevision: resumed.revision,
        change: { type: "finish", outcome: { status: "failed", summary: "Lost localization" } },
      });
      const updated = yield* service.changeExperiment({
        ...experimentKey,
        expectedRevision: failed.revision,
        change: {
          type: "evidence",
          jobs: ["job-1"],
          leases: [],
          streams: ["pose"],
          evidence: [configuration],
          metrics: [{ name: "error", value: 1.1, unit: "m" }],
        },
      });
      assert.deepEqual(updated.provenance, plan.provenance);
      assert.deepEqual(updated.evidence, [resetProbe, configuration]);
      assert.equal(updated.state, "failed");
    }).pipe(
      Effect.provide(
        serviceLayer.pipe(
          Layer.provide(
            Layer.succeed(RoboticsEvidence.ExperimentResetVerifier, {
              verify: () => Effect.succeedSome(resetProbe),
            }),
          ),
          Layer.provide(Sqlite.layerMemory),
        ),
      ),
    ),
);

it.effect("rechecks expiry after the reset probe and leaves the experiment waiting", () =>
  Effect.gen(function* () {
    const verifying = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { service, experimentKey, resume, response } = yield* setup;
      yield* service.respondIntervention(response);
      const resumeFiber = yield* Effect.forkChild(Effect.flip(service.resumeExperiment(resume)));
      yield* Deferred.await(verifying);
      yield* TestClock.setTime(request.expiresAtMs);
      yield* Deferred.succeed(release, undefined);
      assert.propertyVal(yield* Fiber.join(resumeFiber), "category", "expired");
      const experiment = yield* service.get({ ...experimentKey, kind: "experiment" });
      assert.propertyVal(experiment, "state", "waiting-for-human");
      assert.propertyVal(experiment, "retries", 0);
    }).pipe(
      Effect.provide(
        serviceLayer.pipe(
          Layer.provide(
            Layer.succeed(RoboticsEvidence.ExperimentResetVerifier, {
              verify: () =>
                Deferred.succeed(verifying, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(Option.some(resetProbe)),
                ),
            }),
          ),
          Layer.provide(Sqlite.layerMemory),
        ),
      ),
    );
  }),
);
