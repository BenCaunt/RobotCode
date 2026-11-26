// @effect-diagnostics-next-line nodeBuiltinImport:off -- Hash recordings incrementally without buffering the complete file.
import * as NodeCrypto from "node:crypto";
import {
  EvaluationManifest,
  evaluationDirectory,
  evaluationId,
  readEvaluationReport,
} from "@t3tools/shared/evaluationReport";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";

class EvaluationPublishError extends Schema.TaggedError<
  EvaluationPublishError,
  { readonly brand: unique symbol }
>()("EvaluationPublishError", {
  message: Schema.String,
}) {}

const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(EvaluationManifest), {
  onExcessProperty: "error",
});
const encodeReport = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

export const publishEvaluation = Effect.fn("Evaluation.publish")(function* (
  manifestPath: string,
  project: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* decodeManifest(yield* fs.readFileString(manifestPath));
  const directory = path.resolve(project, evaluationDirectory);
  if (manifest.baseline) {
    const baseline = yield* fs.readFileString(path.join(directory, manifest.baseline + ".json"));
    if (!readEvaluationReport(manifest.baseline, baseline))
      return yield* new EvaluationPublishError({
        message: "The baseline report does not match its ID.",
      });
  }
  const evidence = yield* Effect.forEach(
    manifest.evidence,
    Effect.fnUntraced(function* (file) {
      const hash = NodeCrypto.createHash("sha256");
      yield* fs.stream(path.resolve(project, file)).pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            hash.update(chunk);
          }),
        ),
      );
      return { path: file, sha256: hash.digest("hex") };
    }),
  );
  const report = { ...manifest, evidence };
  const contents = (yield* encodeReport(report)) + "\n";
  const id = evaluationId(report, contents);
  yield* fs.makeDirectory(directory, { recursive: true });
  const staging = yield* fs.makeTempFileScoped({ directory, prefix: ".publish-" });
  yield* fs.writeFileString(staging, contents);
  const destination = path.join(directory, id + ".json");
  yield* fs.link(staging, destination).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "AlreadyExists",
      () =>
        Effect.gen(function* () {
          if ((yield* fs.readFileString(destination)).replace(/\r\n/g, "\n") !== contents)
            return yield* new EvaluationPublishError({
              message: "An existing result has different contents at " + destination,
            });
        }),
    ),
  );
  return id;
}, Effect.scoped);

export const evaluationCommand = Command.make("evaluation").pipe(
  Command.withDescription("Publish evaluation reports with versioned evidence."),
  Command.withSubcommands([
    Command.make("publish", {
      manifest: Argument.String("manifest.json"),
      project: Flag.String("project").pipe(
        Flag.withDefault("."),
        Flag.withDescription("Project root containing the evidence files."),
      ),
    }).pipe(
      Command.withDescription("Snapshot a result and print its permanent project reference."),
      Command.withHandler(({ manifest, project }) =>
        publishEvaluation(manifest, project).pipe(Effect.flatMap(Console.log)),
      ),
    ),
  ]),
);
