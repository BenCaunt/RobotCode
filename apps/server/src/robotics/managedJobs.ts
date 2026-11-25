// @effect-diagnostics nodeBuiltinImport:off -- state and process identity are inspected synchronously before releasing the launch gate.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  makePosixProcessTreeController,
  posixProcessIsZombie,
} from "@t3tools/provider-acp/server/AcpSessionRuntime";

import {
  ProjectId,
  RoboticsJobDefinitionSummary,
  RoboticsJobError,
  type RoboticsJob,
  type RoboticsJobEnsureInput,
  type RoboticsJobInput,
  type RoboticsJobList,
  type RoboticsJobListInput,
  type RoboticsJobLogChunk,
  type RoboticsJobLogs,
  type RoboticsJobLogsInput,
  type RoboticsJobProjectInput,
  type RoboticsJobRestartInput,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { ManagedJobsStore, type JobRequest, type StoredJob } from "./managedJobsStore.ts";

const JobDefinition = Schema.Struct({
  projectId: ProjectId,
  definitionId: RoboticsJobDefinitionSummary.fields.definitionId,
  label: RoboticsJobDefinitionSummary.fields.label,
  kind: Schema.Literal("non-actuating"),
  command: Schema.NonEmptyString,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.NonEmptyString,
  envRefs: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))),
  ),
  robotId: Schema.optionalKey(RoboticsJobDefinitionSummary.fields.definitionId),
  sessionId: Schema.optionalKey(RoboticsJobDefinitionSummary.fields.definitionId),
  resourceClaims: Schema.optionalKey(RoboticsJobDefinitionSummary.fields.resourceClaims),
});
type JobDefinition = typeof JobDefinition.Type;
const decodePolicy = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      jobs: Schema.Array(JobDefinition),
    }),
  ),
);
const policyLimitBytes = 256 * 1024;
const textChunkLength = 2_048;
const isJobError = Schema.is(RoboticsJobError);

export class ManagedJobs extends Context.Service<
  ManagedJobs,
  {
    readonly definitions: (
      input: RoboticsJobProjectInput,
    ) => Effect.Effect<ReadonlyArray<RoboticsJobDefinitionSummary>, RoboticsJobError>;
    readonly list: (
      input: RoboticsJobListInput,
    ) => Effect.Effect<RoboticsJobList, RoboticsJobError>;
    readonly inspect: (input: RoboticsJobInput) => Effect.Effect<RoboticsJob, RoboticsJobError>;
    readonly ensure: (
      input: RoboticsJobEnsureInput,
      expectedRobotId?: string,
    ) => Effect.Effect<RoboticsJob, RoboticsJobError>;
    readonly start: (input: RoboticsJobEnsureInput) => Effect.Effect<RoboticsJob, RoboticsJobError>;
    readonly stop: (input: RoboticsJobInput) => Effect.Effect<RoboticsJob, RoboticsJobError>;
    readonly restart: (
      input: RoboticsJobRestartInput,
    ) => Effect.Effect<RoboticsJob, RoboticsJobError>;
    readonly logs: (
      input: RoboticsJobLogsInput,
    ) => Effect.Effect<RoboticsJobLogs, RoboticsJobError>;
    readonly watchLogs: (
      input: RoboticsJobLogsInput,
    ) => Stream.Stream<RoboticsJobLogs, RoboticsJobError>;
  }
>()("t3/robotics/managedJobs") {}

const summary = (definition: JobDefinition): RoboticsJobDefinitionSummary => ({
  definitionId: definition.definitionId,
  label: definition.label,
  hostId: "local",
  robotId: definition.robotId ?? null,
  sessionId: definition.sessionId ?? null,
  resourceClaims: [...new Set(definition.resourceClaims)],
});

const isNodeError = (cause: unknown, code: string) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

function readPolicy(path: string) {
  let fd: number;
  try {
    fd = NodeFS.openSync(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK);
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) return [];
    throw cause;
  }
  try {
    const stat = NodeFS.fstatSync(fd);
    if (!stat.isFile() || stat.size > policyLimitBytes) throw new Error("Invalid job policy file");
    const prefix = Buffer.alloc(policyLimitBytes + 1);
    const bytes = NodeFS.readSync(fd, prefix, { length: prefix.length });
    if (bytes > policyLimitBytes) throw new Error("Job policy is too large");
    const { jobs } = decodePolicy(prefix.toString("utf8", 0, bytes));
    const identities = new Set<string>();
    for (const job of jobs) {
      const key = JSON.stringify([job.projectId, job.definitionId]);
      if (
        !NodePath.isAbsolute(job.command) ||
        !NodePath.isAbsolute(job.cwd) ||
        identities.has(key)
      ) {
        throw new Error("Invalid managed job definition");
      }
      identities.add(key);
    }
    return jobs;
  } finally {
    NodeFS.closeSync(fd);
  }
}

function groupIsAbsent(pid: number) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (cause) {
    return isNodeError(cause, "ESRCH");
  }
}

type LiveJob = {
  readonly ready: Deferred.Deferred<RoboticsJob, RoboticsJobError>;
  readonly stop: Deferred.Deferred<void>;
  readonly done: Deferred.Deferred<RoboticsJob, RoboticsJobError>;
};

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const mutations = yield* Semaphore.make(1);
  const jobsScope = yield* Scope.make();
  const directory = NodePath.join(stateDir, "robotics");
  const configPath =
    environment.ROBOTCODE_MANAGED_JOBS_FILE || NodePath.join(directory, "jobs.json");
  const processTree = platform === "linux" ? makePosixProcessTreeController(platform) : undefined;
  const bootId = yield* Effect.sync(() => {
    if (!processTree) return null;
    try {
      return NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return null;
    }
  });
  const live = new Map<string, LiveJob>();
  const pending = new Set<string>();
  let store: ManagedJobsStore | undefined;
  let shuttingDown = false;
  let nextLogPruneAt = 0;

  const withStore = <A>(action: (db: ManagedJobsStore) => A) =>
    Effect.try({
      try: () => {
        if (!store) {
          NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
          store = new ManagedJobsStore(NodePath.join(directory, "jobs.sqlite"));
        }
        return action(store);
      },
      catch: (cause) => (isJobError(cause) ? cause : new RoboticsJobError({ reason: "storage" })),
    });

  const policy = Effect.try({
    try: () => readPolicy(configPath),
    catch: () => new RoboticsJobError({ reason: "configuration" }),
  });

  const definitionFor = Effect.fn("ManagedJobs.definitionFor")(function* (
    projectId: ProjectId,
    definitionId: string,
  ) {
    const definitions = yield* policy;
    const definition = definitions.find(
      (entry) => entry.projectId === projectId && entry.definitionId === definitionId,
    );
    if (definition === undefined)
      return yield* new RoboticsJobError({ reason: "definition-not-found" });
    return definition;
  });

  const reconcile = (db: ManagedJobsStore, stored: StoredJob, now: number) => {
    const { job } = stored;
    if (
      pending.has(job.jobId) ||
      live.has(job.jobId) ||
      job.state === "stopped" ||
      job.state === "failed"
    )
      return job;
    const observed = job.pid === null ? undefined : processTree?.identity(job.pid);
    // The executable has not been released when no PID has been persisted.
    const gone =
      job.pid === null ||
      (bootId !== null && stored.bootId !== null && bootId !== stored.bootId) ||
      (stored.identity !== null &&
        observed !== undefined &&
        observed.startTime !== stored.identity) ||
      groupIsAbsent(job.pid);
    if (gone) {
      return db.update({
        ...job,
        state: "stopped",
        endedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      });
    }
    return job.state === "unknown" ? job : db.update({ ...job, state: "unknown" });
  };

  const pruneLogs = (db: ManagedJobsStore, now: number) => {
    if (now < nextLogPruneAt) return;
    db.pruneLogs(now);
    nextLogPruneAt = now + 60 * 60 * 1000;
  };

  const appendLogs = (
    jobId: string,
    source: RoboticsJobLogChunk["source"],
    stream: ChildProcessSpawner.ChildProcessHandle["stdout"],
  ) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const chunks: string[] = [];
          for (let offset = 0; offset < text.length; offset += textChunkLength) {
            chunks.push(text.slice(offset, offset + textChunkLength));
          }
          if (chunks.length > 0) {
            yield* withStore((db) => {
              pruneLogs(db, now);
              db.appendLogs(jobId, source, DateTime.formatIso(DateTime.makeUnsafe(now)), chunks);
            });
          }
        }),
      ),
    );

  const supervise = Effect.fn("ManagedJobs.supervise")(function* (
    job: RoboticsJob,
    definition: JobDefinition,
    control: LiveJob,
  ) {
    const { jobId, projectId } = job;
    let spawnedPid: number | undefined;
    const run = Effect.gen(function* () {
      const env = Object.fromEntries(
        (definition.envRefs ?? []).map((name) => [name, environment[name]]),
      );
      // Ship argv as positional arguments. The gate exits on EOF if the server dies before recording the child.
      const command = ChildProcess.make(
        "/bin/sh",
        [
          "-c",
          'IFS= read -r gate && [ "$gate" = start ] || exit 125; exec "$@"',
          "robotcode-managed-job",
          job.command,
          ...job.args,
        ],
        {
          cwd: job.cwd,
          env,
          extendEnv: false,
          shell: false,
          detached: true,
          forceKillAfter: "1 second",
        },
      );
      const child = yield* spawner.spawn(command);
      spawnedPid = child.pid;
      const observed = processTree?.identity(child.pid);
      const identity = observed && !posixProcessIsZombie(observed) ? observed.startTime : null;
      const now = yield* Clock.currentTimeMillis;
      const running = yield* withStore((db) =>
        db.transaction(() =>
          db.update(
            {
              ...job,
              pid: child.pid,
              startedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
              state: "running",
            },
            identity,
          ),
        ),
      );
      yield* Stream.run(Stream.encodeText(Stream.make("start\n")), child.stdin);
      yield* Deferred.succeed(control.ready, running);

      // Wait for stdout/stderr to drain, but a descendant holding a pipe must not keep the job active forever.
      const exitAndLogs = Effect.gen(function* () {
        const logFiber = yield* Effect.forkScoped(
          Effect.all(
            [appendLogs(jobId, "stdout", child.stdout), appendLogs(jobId, "stderr", child.stderr)],
            { concurrency: "unbounded", discard: true },
          ),
        );
        const exitCode = yield* child.exitCode;
        yield* Fiber.join(logFiber).pipe(Effect.timeoutOption("1 second"));
        return Number(exitCode);
      });
      return yield* Effect.raceFirst(
        exitAndLogs,
        Deferred.await(control.stop).pipe(Effect.as(null)),
      );
    });

    yield* Effect.scoped(run).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const finish = yield* withStore((db) =>
            db.transaction(() => {
              const { job: current } = db.inspect(projectId, jobId);
              const exitCode = Exit.isSuccess(exit) ? exit.value : null;
              const stopped = shuttingDown || current.desiredState === "stopped";
              const unresolved = spawnedPid !== undefined && !groupIsAbsent(spawnedPid);
              return db.update({
                ...current,
                desiredState: stopped ? "stopped" : current.desiredState,
                state: unresolved ? "unknown" : stopped || exitCode === 0 ? "stopped" : "failed",
                endedAt: unresolved ? null : DateTime.formatIso(DateTime.makeUnsafe(now)),
                exitCode,
              });
            }),
          ).pipe(Effect.exit);
          live.delete(jobId);
          if (Exit.isFailure(finish)) {
            yield* Deferred.done(control.ready, finish);
          } else if (Exit.isFailure(exit)) {
            yield* Deferred.fail(
              control.ready,
              new RoboticsJobError({ reason: "supervision", jobId }),
            );
          }
          yield* Deferred.done(control.done, finish);
        }),
      ),
      Effect.ignoreCause,
    );
  });

  const launch = Effect.fn("ManagedJobs.launch")(function* (
    job: RoboticsJob,
    definition: JobDefinition,
  ) {
    const ready = yield* Deferred.make<RoboticsJob, RoboticsJobError>();
    const stop = yield* Deferred.make<void>();
    const done = yield* Deferred.make<RoboticsJob, RoboticsJobError>();
    const control = { ready, stop, done };
    live.set(job.jobId, control);
    pending.delete(job.jobId);
    yield* supervise(job, definition, control).pipe(Effect.interruptible, Effect.forkIn(jobsScope));
    return yield* Deferred.await(ready);
  });

  yield* Effect.addFinalizer(() =>
    mutations.withPermits(1)(
      Effect.gen(function* () {
        shuttingDown = true;
        yield* Scope.close(jobsScope, Exit.void);
        if (store) store.close();
      }),
    ),
  );

  const definitions = Effect.fn("ManagedJobs.definitions")(function* (
    input: RoboticsJobProjectInput,
  ) {
    const entries = yield* policy;
    return entries.filter((entry) => entry.projectId === input.projectId).map(summary);
  });

  const list = Effect.fn("ManagedJobs.list")(function* (input: RoboticsJobListInput) {
    const now = yield* Clock.currentTimeMillis;
    return yield* withStore((db) =>
      db.transaction(() => {
        for (const stored of db.activeJobs()) {
          if (stored.job.projectId === input.projectId) reconcile(db, stored, now);
        }
        return db.list(input);
      }),
    );
  });

  const inspect = Effect.fn("ManagedJobs.inspect")(function* (input: RoboticsJobInput) {
    const now = yield* Clock.currentTimeMillis;
    return yield* withStore((db) =>
      db.transaction(() => reconcile(db, db.inspect(input.projectId, input.jobId), now)),
    );
  });

  const requestLaunch = Effect.fn("ManagedJobs.requestLaunch")(function* (
    request: JobRequest,
    input: Omit<RoboticsJobEnsureInput, "idempotencyKey">,
    definition: JobDefinition,
    reuse: boolean,
  ) {
    if (shuttingDown || (platform !== "linux" && platform !== "darwin")) {
      return yield* new RoboticsJobError({ reason: "supervision" });
    }
    const now = yield* Clock.currentTimeMillis;
    const decision = yield* withStore((db) => {
      pruneLogs(db, now);
      const decision = db.transaction(() => {
        const receipt = db.receipt(request);
        if (receipt !== undefined) return { job: receipt, launch: false };
        for (const stored of db.activeJobs()) reconcile(db, stored, now);
        const active = db.active(input.projectId, input.definitionId);
        if (active) {
          if (active.state === "unknown" || active.state === "stopping") {
            throw new RoboticsJobError({ reason: "unknown-process", jobId: active.jobId });
          }
          if (!reuse || active.robotId !== (definition.robotId ?? null)) {
            throw new RoboticsJobError({ reason: "conflict", jobId: active.jobId });
          }
          db.remember(request, active.jobId);
          return { job: active, launch: false };
        }
        const job: RoboticsJob = {
          ...summary(definition),
          jobId: NodeCrypto.randomUUID(),
          projectId: input.projectId,
          threadId: input.threadId ?? null,
          command: definition.command,
          args: definition.args ?? [],
          cwd: definition.cwd,
          envRefs: definition.envRefs ?? [],
          desiredState: "running",
          state: "starting",
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          startedAt: null,
          endedAt: null,
          pid: null,
          exitCode: null,
          restartPolicy: "manual",
        };
        db.reserve(job, bootId);
        db.remember(request, job.jobId);
        return { job, launch: true };
      });
      if (decision.launch) pending.add(decision.job.jobId);
      return decision;
    });
    return decision.launch ? yield* launch(decision.job, definition) : decision.job;
  });

  const startOrEnsure = Effect.fn("ManagedJobs.startOrEnsure")(function* (
    input: RoboticsJobEnsureInput,
    action: "start" | "ensure",
    expectedRobotId?: string,
  ) {
    const request = {
      projectId: input.projectId,
      key: input.idempotencyKey,
      fingerprint: `${action}:${input.definitionId}`,
    };
    const prior = yield* withStore((db) => db.receipt(request));
    if (prior && expectedRobotId === undefined) return yield* inspect(prior);
    const definition = yield* definitionFor(input.projectId, input.definitionId);
    if (
      expectedRobotId !== undefined &&
      (definition.robotId !== expectedRobotId || (prior && prior.robotId !== expectedRobotId))
    ) {
      return yield* new RoboticsJobError({ reason: "definition-not-found" });
    }
    if (prior) return yield* inspect(prior);
    return yield* requestLaunch(request, input, definition, action === "ensure");
  });

  const ensure = Effect.fn("ManagedJobs.ensure")(function* (
    input: RoboticsJobEnsureInput,
    expectedRobotId?: string,
  ) {
    return yield* mutations.withPermits(1)(
      startOrEnsure(input, "ensure", expectedRobotId).pipe(Effect.uninterruptible),
    );
  });

  const start = Effect.fn("ManagedJobs.start")(function* (input: RoboticsJobEnsureInput) {
    return yield* mutations.withPermits(1)(
      startOrEnsure(input, "start").pipe(Effect.uninterruptible),
    );
  });

  const stopInsideGate = Effect.fn("ManagedJobs.stopInsideGate")(function* (
    input: RoboticsJobInput,
  ) {
    const job = yield* inspect(input);
    if (job.state === "stopped" || job.state === "failed") return job;
    const control = live.get(job.jobId);
    if (control === undefined) {
      const current = yield* withStore((db) =>
        db.transaction(() => {
          const { job: latest } = db.inspect(input.projectId, input.jobId);
          return db.update({ ...latest, desiredState: "stopped" });
        }),
      );
      if (current.state === "stopped" || current.state === "failed") return current;
      return yield* new RoboticsJobError({ reason: "unknown-process", jobId: job.jobId });
    }
    yield* withStore((db) =>
      db.transaction(() => {
        const current = db.inspect(input.projectId, input.jobId).job;
        if (current.state === "failed" || current.state === "stopped") return current;
        return db.update({ ...current, state: "stopping", desiredState: "stopped" });
      }),
    );
    yield* Deferred.succeed(control.stop, undefined);
    const finished = yield* Effect.interruptible(Deferred.await(control.done)).pipe(
      Effect.timeoutOption("5 seconds"),
    );
    return Option.isSome(finished) ? finished.value : yield* inspect(input);
  });

  const stop = Effect.fn("ManagedJobs.stop")(function* (input: RoboticsJobInput) {
    return yield* mutations.withPermits(1)(stopInsideGate(input).pipe(Effect.uninterruptible));
  });

  const restart = Effect.fn("ManagedJobs.restart")(function* (input: RoboticsJobRestartInput) {
    return yield* mutations.withPermits(1)(
      Effect.gen(function* () {
        const request = {
          projectId: input.projectId,
          key: input.idempotencyKey,
          fingerprint: `restart:${input.jobId}`,
        };
        const prior = yield* withStore((db) => db.receipt(request));
        if (prior) return yield* inspect(prior);
        const original = yield* inspect(input);
        const definition = yield* definitionFor(input.projectId, original.definitionId);
        yield* stopInsideGate(input);
        return yield* requestLaunch(
          request,
          {
            projectId: input.projectId,
            definitionId: original.definitionId,
            ...(original.threadId === null ? {} : { threadId: original.threadId }),
          },
          definition,
          false,
        );
      }).pipe(Effect.uninterruptible),
    );
  });

  const logs = Effect.fn("ManagedJobs.logs")(function* (input: RoboticsJobLogsInput) {
    const now = yield* Clock.currentTimeMillis;
    return yield* withStore((db) => {
      pruneLogs(db, now);
      db.inspect(input.projectId, input.jobId);
      return db.logs(input);
    });
  });

  const watchLogs = (input: RoboticsJobLogsInput) =>
    Stream.concat(Stream.make(undefined), Stream.tick("500 millis")).pipe(
      Stream.mapAccumEffect(
        () => ({ after: input.after ?? 0, first: true }),
        (cursor) =>
          logs({ ...input, after: cursor.after }).pipe(
            Effect.map(
              (page) =>
                [
                  { after: page.nextAfter, first: false },
                  cursor.first || page.chunks.length > 0 || page.discarded ? [page] : [],
                ] as const,
            ),
          ),
      ),
    );

  return ManagedJobs.of({
    definitions,
    list,
    inspect,
    ensure,
    start,
    stop,
    restart,
    logs,
    watchLogs,
  });
});

export const layer = Layer.effect(ManagedJobs, make);
