import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId, type RoboticsJob } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessLauncher from "../process/ProcessLauncher.ts";
import * as ManagedJobs from "./managedJobs.ts";
import { ManagedJobsStore } from "./managedJobsStore.ts";

const firstProject = ProjectId.make("test-robotics-first");
const secondProject = ProjectId.make("test-robotics-second");
const firstThread = ThreadId.make("test-robotics-thread");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.live("reuses project jobs, protects claims, and recovers state and logs after shutdown", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    if (platform !== "linux" && platform !== "darwin") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "robotics-jobs-" });
    const policyPath = path.join(root, "robotics.json");
    const executable = yield* HostProcess.ExecutablePath;
    const definition = {
      cwd: root,
      kind: "non-actuating",
      command: executable,
      args: ["-e", "console.log('bridge ready'); setInterval(() => {}, 60000)"],
    };
    yield* fs.writeFileString(
      policyPath,
      encodeJson({
        version: 1,
        jobs: [
          {
            ...definition,
            projectId: firstProject,
            definitionId: "bridge",
            label: "Bridge",
            robotId: "test-robot-a",
            resourceClaims: ["test/bridge"],
          },
          {
            ...definition,
            projectId: firstProject,
            definitionId: "viewer",
            label: "Viewer",
            resourceClaims: ["test/viewer"],
          },
          {
            ...definition,
            projectId: secondProject,
            definitionId: "bridge",
            label: "Conflicting bridge",
            resourceClaims: ["test/viewer", "test/bridge"],
          },
        ],
      }),
    );
    const layer = ManagedJobs.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(root, root),
          Layer.succeed(HostProcess.Environment, { ROBOTCODE_MANAGED_JOBS_FILE: policyPath }),
          ProcessLauncher.layerServer,
        ),
      ),
    );

    const { bridge, viewer } = yield* Effect.gen(function* () {
      const jobs = yield* ManagedJobs.ManagedJobs;
      const request = {
        projectId: firstProject,
        definitionId: "bridge",
        idempotencyKey: "start-bridge",
        threadId: firstThread,
      };
      const mismatchedRobot = yield* jobs.ensure(request, "test-robot-b").pipe(Effect.flip);
      expect(mismatchedRobot.reason).toBe("definition-not-found");
      const [bridge, duplicate] = yield* Effect.all(
        [jobs.ensure(request), jobs.ensure(request, "test-robot-a")],
        { concurrency: "unbounded" },
      );
      const reused = yield* jobs.ensure({ ...request, idempotencyKey: "another-thread" });
      expect(bridge).toMatchObject({ state: "running", threadId: firstThread });
      expect(duplicate.jobId).toBe(bridge.jobId);
      expect(reused.jobId).toBe(bridge.jobId);
      const differentOperation = yield* jobs.start(request).pipe(Effect.flip);
      expect(differentOperation.reason).toBe("idempotency-conflict");
      const duplicateDefinition = yield* jobs
        .start({ ...request, idempotencyKey: "start-again" })
        .pipe(Effect.flip);
      expect(duplicateDefinition.reason).toBe("conflict");

      const conflict = yield* jobs
        .ensure({ ...request, projectId: secondProject })
        .pipe(Effect.flip);
      expect(conflict).toMatchObject({ reason: "conflict", resource: "test/bridge" });
      const wrongProject = yield* jobs
        .inspect({ projectId: secondProject, jobId: bridge.jobId })
        .pipe(Effect.flip);
      expect(wrongProject.reason).toBe("job-not-found");

      const viewer = yield* jobs.start({
        ...request,
        definitionId: "viewer",
        idempotencyKey: "start-viewer",
      });
      const page = yield* jobs.watchLogs(bridge).pipe(
        Stream.filter((page) => page.chunks.length > 0),
        Stream.runHead,
      );
      expect(Option.getOrThrow(page).chunks[0]?.text).toContain("bridge ready");
      const firstPage = yield* jobs.list({ projectId: firstProject, limit: 1 });
      expect(firstPage.jobs.map((job) => job.jobId)).toEqual([viewer.jobId]);
      const nextPage = yield* jobs.list({ projectId: firstProject, before: firstPage.nextBefore! });
      expect(nextPage.jobs.map((job) => job.jobId)).toEqual([bridge.jobId]);

      const stopped = yield* jobs.stop(viewer);
      expect(stopped).toMatchObject({ state: "stopped", desiredState: "stopped" });
      expect((yield* jobs.inspect(bridge)).state).toBe("running");
      return { bridge, viewer };
    }).pipe(Effect.provide(layer), Effect.scoped);

    yield* Effect.gen(function* () {
      const jobs = yield* ManagedJobs.ManagedJobs;
      const afterShutdown = yield* jobs.inspect(bridge);
      expect(afterShutdown).toMatchObject({ state: "stopped", desiredState: "stopped" });
      expect((yield* jobs.logs(bridge)).chunks[0]?.text).toContain("bridge ready");
      const replay = yield* jobs.ensure({
        projectId: firstProject,
        definitionId: "bridge",
        idempotencyKey: "start-bridge",
      });
      expect(replay.jobId).toBe(bridge.jobId);
      expect(replay.state).toBe("stopped");
      const restarted = yield* jobs.restart({ ...viewer, idempotencyKey: "restart-viewer" });
      expect(restarted.state).toBe("running");
      expect(restarted.jobId).not.toBe(viewer.jobId);
      const sameRestart = yield* jobs.restart({ ...viewer, idempotencyKey: "restart-viewer" });
      expect(sameRestart.jobId).toBe(restarted.jobId);

      const current = { projectId: firstProject, view: "current" } as const;
      const archive = { projectId: firstProject, view: "archived" } as const;
      expect((yield* jobs.list(current)).jobs.map((job) => job.jobId)).toEqual([
        restarted.jobId,
        viewer.jobId,
        bridge.jobId,
      ]);
      expect((yield* jobs.list(archive)).jobs).toEqual([]);
      yield* jobs.stop(restarted);
      const latest = yield* jobs.list({ ...current, limit: 1 });
      expect(latest.jobs.map((job) => job.jobId)).toEqual([restarted.jobId]);
      expect(latest.hasArchived).toBe(true);
      const older = yield* jobs.list({ ...current, before: latest.nextBefore! });
      expect(older.jobs.map((job) => job.jobId)).toEqual([bridge.jobId]);
      expect((yield* jobs.list(archive)).jobs.map((job) => job.jobId)).toEqual([viewer.jobId]);
      expect((yield* jobs.list({ projectId: firstProject })).jobs).toHaveLength(3);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live("retains claims for an unresolved process and never signals a recovered PID", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    if (platform !== "linux" && platform !== "darwin") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const executable = yield* HostProcess.ExecutablePath;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const processScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(processScope, Exit.void));
    const args = ["-e", "setInterval(() => {}, 60000)"];
    const process = yield* Scope.provide(processScope)(
      spawner.spawn(ChildProcess.make(executable, args, { detached: true })),
    );
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "robotics-job-recovery-" });
    const layer = ManagedJobs.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(root, root)));

    yield* Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const directory = path.join(stateDir, "robotics");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "jobs.json"),
        encodeJson({
          version: 1,
          jobs: [
            {
              projectId: firstProject,
              definitionId: "replacement",
              label: "Replacement bridge",
              kind: "non-actuating",
              command: executable,
              args,
              cwd: root,
              resourceClaims: ["test/bridge"],
            },
          ],
        }),
      );
      const job: RoboticsJob = {
        projectId: firstProject,
        jobId: "recovered-job",
        definitionId: "bridge",
        label: "Recovered bridge",
        robotId: null,
        sessionId: null,
        threadId: null,
        hostId: "local",
        resourceClaims: ["test/bridge"],
        command: executable,
        cwd: root,
        args,
        envRefs: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
        desiredState: "running",
        state: "running",
        pid: process.pid,
        exitCode: null,
        restartPolicy: "manual",
      };
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new ManagedJobsStore(path.join(directory, "jobs.sqlite"))),
        (store) => Effect.sync(() => store.transaction(() => store.reserve(job, null))),
        (store) => Effect.sync(() => store.close()),
      );

      const jobs = yield* ManagedJobs.ManagedJobs;
      expect((yield* jobs.inspect(job)).state).toBe("unknown");
      const conflict = yield* jobs
        .ensure({
          projectId: firstProject,
          definitionId: "replacement",
          idempotencyKey: "replace-unresolved-process",
        })
        .pipe(Effect.flip);
      expect(conflict).toMatchObject({ reason: "conflict", resource: "test/bridge" });
      const error = yield* jobs.stop(job).pipe(Effect.flip);
      expect(error.reason).toBe("unknown-process");
      expect(yield* process.isRunning).toBe(true);
      expect((yield* jobs.inspect(job)).desiredState).toBe("stopped");

      yield* Scope.close(processScope, Exit.void);
      expect((yield* jobs.inspect(job)).state).toBe("stopped");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
