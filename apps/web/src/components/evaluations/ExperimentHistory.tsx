import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, EvaluationHistoryRun } from "@t3tools/contracts";
import { EvaluationMetric } from "./EvaluationMetric";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ChevronRightIcon, GitBranchIcon } from "lucide-react";
import { useState } from "react";
import { projectEnvironment } from "../../state/projects";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

function historyBranches(runs: readonly EvaluationHistoryRun[], query: string) {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const visible = new Set<string>();
  const children = new Map<string | undefined, EvaluationHistoryRun[]>();
  const words = query.trim().toLowerCase().split(/\s+/);
  for (const run of runs) {
    const searchable = [run.id, run.id.replaceAll("-", " "), run.title, run.mode, run.revision]
      .join(" ")
      .toLowerCase();
    if (!words.every((word) => searchable.includes(word))) continue;
    let ancestor: EvaluationHistoryRun | undefined = run;
    while (ancestor && !visible.has(ancestor.id)) {
      visible.add(ancestor.id);
      ancestor = ancestor.baseline ? byId.get(ancestor.baseline) : undefined;
    }
  }
  for (const id of visible) {
    const run = byId.get(id)!;
    const parent = run.baseline && byId.has(run.baseline) ? run.baseline : undefined;
    const siblings = children.get(parent);
    if (siblings) siblings.push(run);
    else children.set(parent, [run]);
  }
  for (const [parent, siblings] of children) {
    siblings.sort(
      (a, b) =>
        (parent ? 1 : -1) * (Date.parse(a.recordedAt) - Date.parse(b.recordedAt)) ||
        a.id.localeCompare(b.id),
    );
  }
  return children;
}

function HistoryBranch({
  run,
  branches,
  project,
  depth,
}: {
  run: EvaluationHistoryRun;
  branches: ReturnType<typeof historyBranches>;
  project: string;
  depth: number;
}) {
  const gt = useGT();
  const children = branches.get(run.id);
  return (
    <li className={depth === 0 ? "rounded-lg border p-1" : undefined}>
      <Link
        to="/evaluations"
        search={{ project, result: run.id }}
        className="group flex min-w-0 items-center gap-3 rounded-md px-3 py-2.5 hover:bg-muted/60 focus-visible:outline-ring"
      >
        {depth === 0 ? (
          <GitBranchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <span
            aria-hidden
            className="h-2 w-3 shrink-0 self-start border-s border-b border-muted-foreground/60 mt-2"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium">{run.title}</p>
          <p className="mt-0.5 break-words text-xs text-muted-foreground">
            {run.category} · {run.mode === "physical" ? gt("Physical") : gt("Simulation")} ·{" "}
            <time dateTime={run.recordedAt}>{run.recordedAt.slice(0, 10)}</time>
          </p>
          {!depth && run.baseline && (
            <p className="text-xs text-muted-foreground">{gt("Baseline unavailable")}</p>
          )}
        </div>
        {run.primaryMetric && <EvaluationMetric metric={run.primaryMetric} />}
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </Link>
      {children && (
        <ul className={depth < 6 ? "ms-5 border-s ps-1" : "border-s ps-0"}>
          {children.map((child) => (
            <HistoryBranch
              key={child.id}
              run={child}
              branches={branches}
              project={project}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function ExperimentHistory({
  environmentId,
  cwd,
  project,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  project: string;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const atom = projectEnvironment.evaluationHistory({ environmentId, input: { cwd } });
  const answer = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const branches = historyBranches(answer._tag === "Success" ? answer.value.runs : [], query);
  const roots = branches.get(undefined) ?? [];
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">{gt("Experiment history")}</h2>
        <Button variant="outline" size="sm" onClick={refresh}>
          {gt("Refresh")}
        </Button>
      </div>
      <Input
        type="search"
        aria-label={gt("Find a result")}
        placeholder={gt("Find by name, category, or ID")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {answer._tag === "Initial" && <p role="status">{gt("Loading…")}</p>}
      {answer._tag === "Failure" && <p role="alert">{gt("Could not load evaluation results.")}</p>}
      {answer._tag === "Success" && (
        <>
          {(answer.value.truncated || answer.value.unavailable > 0) && (
            <p role="status" className="text-sm text-muted-foreground">
              {gt("Some results could not be included in this history.")}
            </p>
          )}
          {roots.length > 0 ? (
            <ul className="space-y-3">
              {roots.map((run) => (
                <HistoryBranch
                  key={run.id}
                  run={run}
                  branches={branches}
                  project={project}
                  depth={0}
                />
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              {query.trim() || answer.value.unavailable || answer.value.truncated
                ? gt("No matching results.")
                : gt("Publish your first result from the project folder with {command}.", {
                    command: "t3 evaluation publish manifest.json",
                  })}
            </p>
          )}
        </>
      )}
    </>
  );
}
