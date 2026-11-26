import {
  evaluationDirectory,
  groupEvaluationEntries,
  readEvaluationReport,
} from "@t3tools/shared/evaluationReport";
import * as Effect from "effect/Effect";
import type { WorkspaceEntries } from "./WorkspaceEntries.ts";
import type { WorkspaceFileSystem } from "./WorkspaceFileSystem.ts";

export const listEvaluationHistory = Effect.fn("Project.listEvaluationHistory")(function* (
  cwd: string,
  entries: Pick<WorkspaceEntries["Service"], "list">,
  files: Pick<WorkspaceFileSystem["Service"], "readFile">,
) {
  const listing = yield* entries.list({ cwd, directoryPath: evaluationDirectory }).pipe(
    Effect.catchIf(
      (error) => error._tag === "WorkspaceEntriesReadDirectoryError" && error.pathMissing,
      () => Effect.succeed({ entries: [], truncated: false }),
    ),
  );
  const reports = yield* Effect.forEach(
    groupEvaluationEntries(listing.entries, "").flatMap((group) => group.results),
    Effect.fnUntraced(function* ({ id }) {
      const file = yield* files
        .readFile({
          cwd,
          relativePath: evaluationDirectory + "/" + id + ".json",
          allowMissing: true,
        })
        .pipe(Effect.orElseSucceed(() => null));
      const report =
        file && file.exists !== false && !file.truncated
          ? readEvaluationReport(id, file.contents)
          : null;
      if (!report) return null;
      const { title, category, mode, revision, recordedAt, baseline, primaryMetric } = report;
      return {
        id,
        title,
        category,
        mode,
        revision,
        recordedAt,
        ...(baseline ? { baseline } : {}),
        ...(primaryMetric ? { primaryMetric } : {}),
      };
    }),
    { concurrency: 4 },
  );
  const runs = reports.filter((run) => run !== null);
  return { runs, unavailable: reports.length - runs.length, truncated: listing.truncated };
});
