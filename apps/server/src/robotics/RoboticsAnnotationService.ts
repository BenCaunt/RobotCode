import {
  RoboticsAnnotation,
  RoboticsAnnotationCreateInput,
  type RoboticsAnnotationGetInput,
  RoboticsAnnotationList,
  type RoboticsAnnotationListInput,
  RoboticsAnnotationRpcError,
} from "@t3tools/contracts";
import { isRerunRecordingPath } from "@t3tools/shared/filePreview";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";

import { resolveCanonicalWorkspaceFile } from "../assets/AssetAccess.ts";
import { mediaFileRevision, openMediaFile } from "../assets/MediaFile.ts";
import type * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import type * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as RoboticsEvidence from "./RoboticsEvidence.ts";
import type * as EvidenceModel from "./RoboticsEvidenceModel.ts";

export class RoboticsAnnotationService extends Context.Service<
  RoboticsAnnotationService,
  {
    readonly create: (
      input: RoboticsAnnotationCreateInput,
      actorId: string,
    ) => Effect.Effect<RoboticsAnnotation, RoboticsAnnotationRpcError>;
    readonly get: (
      input: RoboticsAnnotationGetInput,
    ) => Effect.Effect<RoboticsAnnotation, RoboticsAnnotationRpcError>;
    readonly list: (
      input: RoboticsAnnotationListInput,
    ) => Effect.Effect<RoboticsAnnotationList, RoboticsAnnotationRpcError>;
  }
>()("t3/robotics/RoboticsAnnotationService") {}

const encodeRecordingKey = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String])),
);
const decodeCreate = Schema.decodeUnknownEffect(RoboticsAnnotationCreateInput, {
  onExcessProperty: "error",
});
const decodeRecord = Schema.decodeUnknownEffect(RoboticsAnnotation);
const decodeList = Schema.decodeUnknownEffect(RoboticsAnnotationList);

const toView = Effect.fn("RoboticsAnnotationService.toView")(function* (
  record: typeof EvidenceModel.EvidenceRecord.Type,
) {
  if (record.kind !== "annotation" || !record.recordingSource) {
    return yield* new RoboticsAnnotationRpcError({ category: "missing" });
  }
  return yield* decodeRecord({
    ...record.selection,
    annotationId: record.id,
    projectId: record.projectId,
    threadId: record.recordingSource.threadId,
    recording: { ...record.recordingSource, ...record.selection.recording },
    authorId: record.authorId,
    comment: record.comment,
    status: record.status,
    createdAtMs: record.createdAtMs,
  }).pipe(Effect.mapError(() => new RoboticsAnnotationRpcError({ category: "unavailable" })));
});

const evidenceError = (
  error: RoboticsEvidence.RoboticsEvidenceError | RoboticsEvidence.RoboticsEvidenceStorageError,
) => {
  switch (error._tag) {
    case "RoboticsEvidenceError":
      switch (error.category) {
        case "missing":
        case "conflict":
        case "recording-changed":
        case "invalid":
          return new RoboticsAnnotationRpcError({ category: error.category });
        default:
          return new RoboticsAnnotationRpcError({ category: "unavailable" });
      }
    case "RoboticsEvidenceStorageError":
      return new RoboticsAnnotationRpcError({ category: "unavailable" });
  }
};

const make = Effect.gen(function* () {
  const evidence = yield* RoboticsEvidence.RoboticsEvidence;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const digester = yield* Digest.Digest;
  const path = yield* Path.Path;
  const workspaceContext = yield* Effect.context<
    WorkspacePaths.WorkspacePaths | FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
  >();

  const verification = Effect.fn("RoboticsAnnotationService.verifyRecording")(function* (
    workspaceRoot: string,
    filePath: string,
    version: string,
  ) {
    const canonical = yield* resolveCanonicalWorkspaceFile({
      workspaceRoot,
      relativePath: path.relative(workspaceRoot, filePath),
    }).pipe(
      Effect.provideContext(workspaceContext),
      Effect.mapError(() => new RoboticsEvidence.RoboticsEvidenceError({ category: "missing" })),
    );
    if (!canonical || !isRerunRecordingPath(canonical)) {
      return yield* new RoboticsEvidence.RoboticsEvidenceError({ category: "missing" });
    }
    const latest = yield* openMediaFile(canonical).pipe(
      Effect.map((file) => (file === null ? null : mediaFileRevision(file.info))),
      Effect.scoped,
      Effect.mapError(() => new RoboticsEvidence.RoboticsEvidenceError({ category: "missing" })),
    );
    if (latest !== version) {
      return yield* new RoboticsEvidence.RoboticsEvidenceError({ category: "recording-changed" });
    }
  });

  const create: RoboticsAnnotationService["Service"]["create"] = Effect.fn(
    "RoboticsAnnotationService.create",
  )(function* (request, actorId) {
    const { projectId, threadId, idempotencyKey, recording, comment, ...cursor } =
      yield* decodeCreate(request).pipe(
        Effect.mapError(() => new RoboticsAnnotationRpcError({ category: "invalid" })),
      );
    if (
      !path.isAbsolute(recording.path) ||
      recording.path.includes("\0") ||
      !isRerunRecordingPath(recording.path)
    ) {
      return yield* new RoboticsAnnotationRpcError({ category: "invalid" });
    }
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(() => new RoboticsAnnotationRpcError({ category: "unavailable" })));
    if (Option.isNone(project))
      return yield* new RoboticsAnnotationRpcError({ category: "missing" });
    const roots = [path.resolve(project.value.workspaceRoot)];
    if (threadId !== undefined) {
      const thread = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(() => new RoboticsAnnotationRpcError({ category: "missing" })));
      if (thread === null || thread.projectId !== projectId)
        return yield* new RoboticsAnnotationRpcError({ category: "missing" });
      if (thread.worktreePath) roots.unshift(path.resolve(thread.worktreePath));
    }
    const absolute = path.resolve(recording.path);
    const workspaceRoot = roots.find((root) => isWithinRoot(path, absolute, root));
    if (workspaceRoot === undefined)
      return yield* new RoboticsAnnotationRpcError({ category: "missing" });
    const key = yield* encodeRecordingKey([projectId, absolute, recording.recordingId]).pipe(
      Effect.mapError(() => new RoboticsAnnotationRpcError({ category: "invalid" })),
    );
    const hash = yield* digester.digest(Digest.sha256, new TextEncoder().encode(key)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(() => new RoboticsAnnotationRpcError({ category: "unavailable" })),
    );
    const created = yield* evidence
      .addAnnotation(
        {
          projectId,
          idempotencyKey,
          authorId: actorId,
          recordingSource: {
            path: absolute,
            recordingId: recording.recordingId,
            ...(threadId === undefined ? {} : { threadId }),
          },
          comment,
          selection: {
            ...cursor,
            recording: { artifactId: `rrd:${hash}`, version: recording.version },
          },
        },
        verification(workspaceRoot, absolute, recording.version),
      )
      .pipe(Effect.mapError(evidenceError));
    return yield* toView(created);
  });

  return RoboticsAnnotationService.of({
    create,
    get: Effect.fn("RoboticsAnnotationService.get")(function* ({ projectId, annotationId }) {
      const record = yield* evidence
        .get({ projectId, id: annotationId, kind: "annotation" })
        .pipe(Effect.mapError(evidenceError));
      return yield* toView(record);
    }),
    list: Effect.fn("RoboticsAnnotationService.list")(function* ({ projectId, after, limit }) {
      const result = yield* evidence
        .list({ projectId, kind: "annotation", viewerOnly: true, after, limit: limit ?? 10 })
        .pipe(Effect.mapError(evidenceError));
      const items = yield* Effect.forEach(result.items, toView);
      return yield* decodeList({ items, nextCursor: result.nextCursor }).pipe(
        Effect.mapError(() => new RoboticsAnnotationRpcError({ category: "unavailable" })),
      );
    }),
  });
});

export const layer = Layer.effect(RoboticsAnnotationService, make);
