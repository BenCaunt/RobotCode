import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type EnvironmentId,
  type ProjectId,
  type RoboticsJob,
} from "@t3tools/contracts";
import {
  createRoboticsEnvironmentAtoms,
  robotSessionPhaseLabels,
  robotSessionReasonLabels,
  roboticsStatusLabels,
} from "@t3tools/client-runtime/state/robotics";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { m as resolveMessage } from "../../i18n/messages";
import { randomUUID } from "../../lib/utils";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

const robotics = createRoboticsEnvironmentAtoms(connectionAtomRuntime);
type Target = { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };

export function ProjectRoboticsPanel(props: Target & { readonly environmentLabel: string }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const readJobs = useEnvironmentScope(props.environmentId, AuthTerminalReadScope);
  const readRobots = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const available =
    useServerConfigs().get(props.environmentId)?.environment.capabilities.robotics === true;
  if (!available || (!readJobs && !readRobots)) return null;

  return (
    <SettingsSection
      title={gt("Robotics · {environment}", { environment: props.environmentLabel })}
    >
      <div className="flex flex-col items-start gap-4 p-3">
        <Button variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? gt("Hide robotics panel") : gt("Open robotics panel")}
        </Button>
        {open && readRobots && <RobotSessions {...props} />}
        {open && readJobs && <Processes {...props} />}
      </div>
    </SettingsSection>
  );
}

function RobotSessions({ environmentId, projectId }: Target) {
  const gt = useGT();
  const m = useMessages();
  const allowed = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const atom = robotics.robots({ environmentId, input: { projectId } });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const connect = useAtomCommand(robotics.connect);
  const cancel = useAtomCommand(robotics.cancel);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(robotId: string, action: "connect" | "cancel") {
    setPending(true);
    setError(null);
    const reportError = (cause: unknown) =>
      setError(errorDisplayMessage(cause, resolveMessage) ?? gt("Could not update robot session."));
    try {
      const response = await (action === "connect" ? connect : cancel)({
        environmentId,
        input: { projectId, robotId },
      });
      if (response._tag === "Failure") reportError(squashAtomCommandFailure(response));
    } catch (cause) {
      reportError(cause);
    }
    setPending(false);
    refresh();
  }

  return (
    <div className="w-full space-y-2">
      <h3 className="text-sm font-medium">
        <T>Robots</T>
      </h3>
      {error && (
        <p role="status" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {result._tag === "Initial" && (
        <p className="text-sm text-muted-foreground">
          <T>Loading robots…</T>
        </p>
      )}
      {result._tag === "Failure" && (
        <p role="status" className="text-sm text-muted-foreground">
          <T>The robot registry is unavailable.</T>
        </p>
      )}
      {result._tag === "Success" && result.value.length === 0 && (
        <p className="text-sm text-muted-foreground">
          <T>No robots are configured for this project.</T>
        </p>
      )}
      {result._tag === "Success" &&
        result.value.map((robot) => {
          const session = robot.session;
          const canCancel =
            session?.state === "connecting" ||
            session?.state === "ready" ||
            session?.state === "degraded";
          return (
            <div
              key={robot.robotId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{robot.displayName}</p>
                <p className="break-words text-xs text-muted-foreground">
                  {m(roboticsStatusLabels[session?.state ?? "disconnected"])}
                  {session && canCancel ? ` · ${m(robotSessionPhaseLabels[session.phase])}` : ""}
                </p>
                {session?.reason && (
                  <p className="text-xs text-muted-foreground">
                    {m(robotSessionReasonLabels[session.reason])}
                  </p>
                )}
              </div>
              {allowed && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => void run(robot.robotId, canCancel ? "cancel" : "connect")}
                >
                  {canCancel ? gt("End session") : gt("Connect")}
                </Button>
              )}
            </div>
          );
        })}
    </div>
  );
}

function Processes({ environmentId, projectId }: Target) {
  const gt = useGT();
  const m = useMessages();
  const allowed = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [before, setBefore] = useState<number | null>(null);
  const jobsAtom = robotics.jobs({
    environmentId,
    input: { projectId, limit: 25, ...(before === null ? {} : { before }) },
  });
  const jobs = useAtomValue(jobsAtom);
  const refresh = useAtomRefresh(jobsAtom);
  const definitions = useAtomValue(robotics.definitions({ environmentId, input: { projectId } }));
  const ensure = useAtomCommand(robotics.ensure);
  const stop = useAtomCommand(robotics.stop);
  const restart = useAtomCommand(robotics.restart);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openLogs, setOpenLogs] = useState<string | null>(null);

  async function run(action: "ensure" | "stop" | "restart", id: string) {
    setPending(true);
    setError(null);
    const reportError = (cause: unknown) =>
      setError(
        errorDisplayMessage(cause, resolveMessage) ?? gt("Could not update managed process."),
      );
    try {
      const response =
        action === "ensure"
          ? await ensure({
              environmentId,
              input: { projectId, definitionId: id, idempotencyKey: randomUUID() },
            })
          : action === "stop"
            ? await stop({ environmentId, input: { projectId, jobId: id } })
            : await restart({
                environmentId,
                input: { projectId, jobId: id, idempotencyKey: randomUUID() },
              });
      if (response._tag === "Failure") reportError(squashAtomCommandFailure(response));
    } catch (cause) {
      reportError(cause);
    }
    setPending(false);
    if (before === null) refresh();
    else setBefore(null);
  }

  const groups = new Map<string, RoboticsJob[]>();
  if (jobs._tag === "Success") {
    for (const job of jobs.value.jobs) {
      const key = JSON.stringify([job.robotId, job.hostId]);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [job]);
      else group.push(job);
    }
  }
  const next = jobs._tag === "Success" ? jobs.value.nextBefore : null;

  return (
    <div className="w-full space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          <T>Processes</T>
        </h3>
        <Button variant="ghost" size="sm" onClick={refresh}>
          <T>Refresh</T>
        </Button>
      </div>
      {error && (
        <p role="status" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {definitions._tag === "Failure" && (
        <p role="status" className="text-sm text-muted-foreground">
          <T>Process definitions are unavailable.</T>
        </p>
      )}
      {allowed && definitions._tag === "Success" && definitions.value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {definitions.value.map((definition) => (
            <Button
              key={definition.definitionId}
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void run("ensure", definition.definitionId)}
            >
              {gt("Ensure {name} is running", { name: definition.label })}
            </Button>
          ))}
        </div>
      )}
      {jobs._tag === "Initial" && (
        <p className="text-sm text-muted-foreground">
          <T>Loading processes…</T>
        </p>
      )}
      {jobs._tag === "Failure" && (
        <p role="status" className="text-sm text-muted-foreground">
          <T>Processes are unavailable on this environment.</T>
        </p>
      )}
      {jobs._tag === "Success" && groups.size === 0 && (
        <p className="text-sm text-muted-foreground">
          <T>No managed processes for this project.</T>
        </p>
      )}
      {[...groups].map(([key, group]) => (
        <div key={key} className="space-y-1.5">
          <h4 className="text-xs text-muted-foreground">
            {[group[0]?.robotId, group[0]?.hostId].filter(Boolean).join(" · ")}
          </h4>
          {group.map((job) => (
            <div key={job.jobId} className="space-y-2 rounded-md border p-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium">
                    {job.label} · {m(roboticsStatusLabels[job.state])}
                  </p>
                  {job.startedAt && (
                    <p className="text-xs text-muted-foreground">
                      {gt("Started {time}", { time: new Date(job.startedAt).toLocaleString() })}
                    </p>
                  )}
                  {job.resourceClaims.length > 0 && (
                    <p className="break-words text-xs text-muted-foreground">
                      {job.resourceClaims.join(", ")}
                    </p>
                  )}
                  {job.threadId && (
                    <p className="break-all text-xs text-muted-foreground">
                      {gt("Conversation {id}", { id: job.threadId })}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={openLogs === job.jobId}
                    onClick={() => setOpenLogs(openLogs === job.jobId ? null : job.jobId)}
                  >
                    <T>Logs</T>
                  </Button>
                  {allowed && (
                    <>
                      {job.state === "running" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => void run("stop", job.jobId)}
                        >
                          <T>Stop</T>
                        </Button>
                      )}
                      {["running", "stopped", "failed"].includes(job.state) && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => void run("restart", job.jobId)}
                        >
                          <T>Restart</T>
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {openLogs === job.jobId && (
                <ProcessLogs
                  environmentId={environmentId}
                  projectId={projectId}
                  jobId={job.jobId}
                />
              )}
            </div>
          ))}
        </div>
      ))}
      {(before !== null || next !== null) && (
        <div className="flex gap-2">
          {before !== null && (
            <Button variant="ghost" size="sm" onClick={() => setBefore(null)}>
              <T>Newest</T>
            </Button>
          )}
          {next !== null && (
            <Button variant="ghost" size="sm" onClick={() => setBefore(next)}>
              <T>Older</T>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ProcessLogs({ environmentId, projectId, jobId }: Target & Pick<RoboticsJob, "jobId">) {
  const result = useAtomValue(
    robotics.logs({ environmentId, input: { projectId, jobId, limit: 50 } }),
  );
  if (result._tag === "Initial")
    return (
      <p className="text-xs text-muted-foreground">
        <T>Loading logs…</T>
      </p>
    );
  if (result._tag === "Failure")
    return (
      <p role="status" className="text-xs text-muted-foreground">
        <T>Logs are unavailable.</T>
      </p>
    );
  return (
    <>
      {result.value.discarded && (
        <p className="text-xs text-muted-foreground">
          <T>Earlier log output was discarded.</T>
        </p>
      )}
      {result.value.output ? (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
          {result.value.output}
        </pre>
      ) : (
        <p className="text-xs text-muted-foreground">
          <T>No log output yet.</T>
        </p>
      )}
    </>
  );
}
