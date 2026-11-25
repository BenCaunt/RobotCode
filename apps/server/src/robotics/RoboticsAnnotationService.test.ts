import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { IsoDateTime, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { readFileRevision } from "../assets/MediaFile.ts";
import * as ServerConfig from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as RoboticsAnnotationService from "./RoboticsAnnotationService.ts";
import * as RoboticsEvidence from "./RoboticsEvidence.ts";

it.effect("persists the authenticated annotation for an exact worktree recording revision", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "robotics-annotation-" });
    const workspaceRoot = path.join(directory, "project");
    const worktreePath = path.join(directory, "worktree");
    yield* fs.makeDirectory(workspaceRoot);
    yield* fs.makeDirectory(worktreePath);
    const file = path.join(worktreePath, "navigation.rrd");
    yield* fs.writeFileString(file, "original recording");
    const version = yield* readFileRevision(file);
    assert.isNotNull(version);

    const projectId = ProjectId.make("robotics-project");
    const threadId = ThreadId.make("worktree-thread");
    const otherThreadId = ThreadId.make("other-project-thread");
    const date = IsoDateTime.make("2026-11-24T00:00:00.000Z");
    const environment = Layer.mergeAll(
      WorkspacePaths.layer,
      ServerConfig.layerTest(workspaceRoot, { prefix: "robotics-annotation-config-" }),
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            workspaceRoot,
            title: "Robotics project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: date,
            updatedAt: date,
            deletedAt: null,
          }),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed({
            ...liveThreadShell(id),
            projectId: id === threadId ? projectId : ProjectId.make("another-project"),
            worktreePath,
          }),
      }),
    );
    const services = RoboticsAnnotationService.layer.pipe(
      Layer.provideMerge(RoboticsEvidence.layer.pipe(Layer.provide(Sqlite.layerMemory))),
      Layer.provide(environment),
    );
    yield* Effect.gen(function* () {
      const annotations = yield* RoboticsAnnotationService.RoboticsAnnotationService;
      const evidence = yield* RoboticsEvidence.RoboticsEvidence;
      const request = {
        projectId,
        threadId,
        idempotencyKey: "flicker-comment",
        recording: { path: file, version, recordingId: "Recording:app:nav" },
        timeline: "robot_time",
        timeType: "timestamp" as const,
        start: "1724002220123456789",
        end: "1724002220123456790",
        entityPaths: ["/localization/pose"],
        views: [{ viewId: "pose", name: "World", class: "Spatial3D", origin: "/", visible: true }],
        comment: "The pose flickers",
      };
      const outside = yield* Effect.flip(
        annotations.create({ ...request, threadId: undefined }, "operator"),
      );
      assert.equal(outside.category, "missing");
      const wrongThread = yield* Effect.flip(
        annotations.create({ ...request, threadId: otherThreadId }, "operator"),
      );
      assert.equal(wrongThread.category, "missing");
      const invalid = yield* Effect.flip(
        annotations.create({ ...request, end: "1724002220123456788" }, "operator"),
      );
      assert.equal(invalid.category, "invalid");
      const saved = yield* annotations.create(request, "operator");
      assert.equal(saved.authorId, "operator");
      assert.equal(saved.threadId, threadId);
      assert.equal(saved.start, request.start);
      assert.deepEqual(saved.views, request.views);
      assert.deepEqual(saved.recording, {
        ...request.recording,
        artifactId: saved.recording.artifactId,
      });
      assert.equal(yield* fs.readFileString(file), "original recording");

      yield* fs.writeFileString(file, "modified recording with more bytes");
      const changed = yield* Effect.flip(
        annotations.create({ ...request, idempotencyKey: "new-comment" }, "operator"),
      );
      assert.equal(changed.category, "recording-changed");
      assert.deepEqual(yield* annotations.create(request, "operator"), saved);
      assert.deepEqual(
        yield* annotations.get({ projectId, annotationId: saved.annotationId }),
        saved,
      );
      const inaccessible = yield* Effect.flip(
        annotations.get({
          projectId: ProjectId.make("another-project"),
          annotationId: saved.annotationId,
        }),
      );
      assert.equal(inaccessible.category, "missing");
      yield* evidence.addAnnotation({
        projectId,
        idempotencyKey: "unmanaged-evidence",
        authorId: "operator",
        comment: "A programmatic annotation",
        selection: {
          recording: { artifactId: "other-evidence", version: "v1" },
          timeline: "robot_time",
          start: "0",
          entityPaths: [],
        },
      });
      const listed = yield* annotations.list({ projectId });
      assert.lengthOf(listed.items, 1);
      const first = listed.items[0];
      assert.isDefined(first);
      assert.equal(first.annotationId, saved.annotationId);
      assert.equal(first.start, saved.start);
      assert.notProperty(first, "comment");
      assert.isNull(listed.nextCursor);
    }).pipe(Effect.provide(services));
  }).pipe(Effect.provide([NodeServices.layer, NodeCrypto.layer])),
);
