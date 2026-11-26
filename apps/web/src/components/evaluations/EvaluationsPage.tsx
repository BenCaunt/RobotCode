import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { AuthFilesystemReadScope, type EnvironmentId } from "@t3tools/contracts";
import { resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { evaluationDirectory, groupEvaluationEntries } from "@t3tools/shared/evaluationReport";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ArrowLeftIcon, ChartLineIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useProjects } from "../../state/entities";
import { useConnectedEnvironmentIds, useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentsWithScope } from "../../state/session";
import { EvaluationFigure, findFigureEvidence } from "./EvaluationFigure";
import { EvaluationMetric } from "./EvaluationMetric";
import { ExperimentHistory } from "./ExperimentHistory";
import { EvaluationReplay } from "./EvaluationReplay";
import ChatMarkdown from "../ChatMarkdown";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";

type ProjectTarget = { environmentId: EnvironmentId; cwd: string; project: string };

export function EvaluationsPage() {
  const gt = useGT();
  const navigate = useNavigate();
  const search = useSearch({ from: "/_chat/evaluations" });
  const { environments } = useEnvironments();
  const connected = useConnectedEnvironmentIds();
  const readable = useEnvironmentsWithScope(environments, AuthFilesystemReadScope);
  const projects = useProjects()
    .filter((p) => connected.includes(p.environmentId) && readable.has(p.environmentId))
    .map((p) => ({
      ...p,
      key: scopedProjectKey({ environmentId: p.environmentId, projectId: p.id }),
      host:
        environments.find((env) => env.environmentId === p.environmentId)?.label ?? p.environmentId,
    }));
  const selected =
    search.project === undefined && search.result === undefined
      ? projects[0]
      : projects.find((p) => p.key === search.project);
  const target = selected && {
    project: selected.key,
    environmentId: selected.environmentId,
    cwd: selected.workspaceRoot,
  };
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <ChartLineIcon aria-hidden className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">{gt("Evaluations")}</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer>
          {projects.length > 0 && (
            <Select
              value={selected?.key ?? null}
              onValueChange={(value) => {
                if (value !== null)
                  void navigate({
                    to: "/evaluations",
                    search: { project: value, view: search.view },
                  });
              }}
            >
              <SelectTrigger aria-label={gt("Select a project")} className="max-w-full self-start">
                <SelectValue placeholder={gt("Select a project")}>
                  {selected && selected.title + " · " + selected.host}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {projects.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.title} · {p.host} · {p.workspaceRoot}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          {target ? (
            search.result !== undefined ? (
              <EvaluationDetail
                key={target.project + "/" + search.result}
                {...target}
                id={search.result}
              />
            ) : (
              <>
                <nav aria-label={gt("Evaluations")} className="flex flex-wrap gap-1 border-b pb-2">
                  <Button
                    size="sm"
                    variant={search.view ? "ghost" : "outline"}
                    render={
                      <Link
                        to="/evaluations"
                        search={{ project: target.project }}
                        aria-current={search.view ? undefined : "page"}
                        activeOptions={{ exact: true, explicitUndefined: true }}
                      />
                    }
                  >
                    {gt("Experiment history")}
                  </Button>
                  <Button
                    size="sm"
                    variant={search.view ? "outline" : "ghost"}
                    render={
                      <Link
                        to="/evaluations"
                        search={{ project: target.project, view: "results" }}
                        aria-current={search.view ? "page" : undefined}
                      />
                    }
                  >
                    {gt("All results")}
                  </Button>
                </nav>
                {search.view === "results" ? (
                  <EvaluationList key={target.project} {...target} />
                ) : (
                  <ExperimentHistory key={target.project} {...target} />
                )}
              </>
            )
          ) : (
            <p>{gt("This project is unavailable or cannot be read.")}</p>
          )}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}

function EvaluationList({ environmentId, cwd, project }: ProjectTarget) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const atom = projectEnvironment.evaluationEntries({ environmentId, input: { cwd } });
  const answer = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const groups =
    answer._tag === "Success" ? groupEvaluationEntries(answer.value.entries, query) : [];
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">{gt("Evaluation results")}</h2>
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
      {answer._tag === "Success" && !groups.length && (
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          {query.trim()
            ? gt("No matching results.")
            : gt("Publish your first result from the project folder with {command}.", {
                command: "t3 evaluation publish manifest.json",
              })}
        </div>
      )}
      {groups.map(({ category, results }) => (
        <section key={category}>
          <h3 className="mb-2 font-semibold">{category}</h3>
          <div className="divide-y rounded-lg border">
            {results.map((entry) => (
              <Link
                key={entry.id}
                to="/evaluations"
                search={{ project, result: entry.id, view: "results" }}
                className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/60 focus-visible:outline-ring"
              >
                <div className="min-w-0">
                  <p className="font-medium">{entry.name}</p>
                  <p className="break-all font-mono text-xs text-muted-foreground">{entry.id}</p>
                </div>
                <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function EvaluationDetail({ environmentId, cwd, project, id }: ProjectTarget & { id: string }) {
  const gt = useGT();
  const { view } = useSearch({ from: "/_chat/evaluations" });
  const atom = projectEnvironment.evaluationReport({ environmentId, input: { cwd, id } });
  const answer = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const [seekRequest, requestSeek] = useState(0);
  const repeatSeek = () => requestSeek((n) => n + 1);
  const [copyError, setCopyError] = useState("");
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error) => setCopyError(error.message),
    onCopy: () => setCopyError(""),
  });
  const report = answer._tag === "Success" ? answer.value : null;
  return (
    <>
      <Link
        to="/evaluations"
        search={{ project, view }}
        className="inline-flex items-center gap-2 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {view ? gt("All results") : gt("Experiment history")}
      </Link>
      {report ? (
        <>
          <header>
            <p className="mb-1 text-sm text-muted-foreground">
              {report.category} · {report.mode === "physical" ? gt("Physical") : gt("Simulation")}
            </p>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h2 className="min-w-0 flex-1 text-2xl font-semibold tracking-tight">
                {report.title}
              </h2>
              {report.primaryMetric && <EvaluationMetric metric={report.primaryMetric} />}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="break-all text-xs">{id}</code>
              <Button variant="ghost" size="sm" onClick={() => copyToClipboard(id)}>
                <CopyIcon />
                {isCopied ? gt("Copied") : gt("Copy ID")}
              </Button>
            </div>
            {copyError && <p role="alert">{copyError}</p>}
          </header>
          <article className="min-w-0">
            <ChatMarkdown
              text={report.summary}
              renderWorkspaceImage={(path, alt) => {
                const evidence = findFigureEvidence(report, cwd, path);
                return evidence ? (
                  <EvaluationFigure
                    key={evidence.sha256 + evidence.path}
                    environmentId={environmentId}
                    cwd={cwd}
                    file={evidence}
                    alt={alt}
                  />
                ) : (
                  <span>{alt || gt("Image unavailable")}</span>
                );
              }}
              renderContextReference={({ kind, contextId, label }) =>
                kind === "replay" &&
                report.replayCitations?.some((entry) => entry.id === contextId) ? (
                  <Link
                    to="/evaluations"
                    onClick={repeatSeek}
                    hash="replay-evidence"
                    search={{ project, view, result: id, replay: contextId }}
                    className="underline underline-offset-2"
                  >
                    {label}
                  </Link>
                ) : (
                  <span>{label}</span>
                )
              }
              environmentId={environmentId}
              cwd={resolveWorkspaceFilePath(evaluationDirectory, cwd)}
            />
          </article>
          <EvaluationReplay
            environmentId={environmentId}
            cwd={cwd}
            project={project}
            id={id}
            seekRequest={seekRequest}
            onSeek={repeatSeek}
            report={report}
          />
          <section className="space-y-3 border-t pt-5">
            <h3 className="font-semibold">{gt("Provenance")}</h3>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
              <dt>{gt("Recorded")}</dt>
              <dd>
                <time dateTime={report.recordedAt}>{report.recordedAt}</time>
              </dd>
              <dt>{gt("Revision")}</dt>
              <dd className="break-all font-mono">{report.revision}</dd>
              <dt>{gt("Setup")}</dt>
              <dd className="whitespace-pre-wrap break-words">{report.setup}</dd>
              {report.baseline && (
                <>
                  <dt>{gt("Baseline")}</dt>
                  <dd>
                    <Link
                      className="break-all underline"
                      to="/evaluations"
                      search={{ project, view, result: report.baseline }}
                    >
                      {report.baseline}
                    </Link>
                  </dd>
                </>
              )}
              <dt>{gt("Evidence")}</dt>
              <dd className="space-y-2">
                {report.evidence.map((item) => (
                  <div key={item.path}>
                    <p className="break-all">{item.path}</p>
                    <code className="break-all text-xs text-muted-foreground">
                      {"sha256:" + item.sha256}
                    </code>
                  </div>
                ))}
              </dd>
            </dl>
          </section>
        </>
      ) : answer._tag === "Initial" ? (
        <p role="status">{gt("Loading…")}</p>
      ) : (
        <div className="space-y-3">
          <p role="alert">
            {answer._tag === "Failure"
              ? gt("Could not load evaluation results.")
              : gt("This result is missing or its contents no longer match its ID.")}
          </p>
          <Button onClick={refresh}>{gt("Retry")}</Button>
        </div>
      )}
    </>
  );
}
