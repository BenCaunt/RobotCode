import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  createRoboticsEnvironmentAtoms,
  roboticsStatusLabels,
  robotSessionPhaseLabels,
  robotSessionReasonLabels,
} from "@t3tools/client-runtime/state/robotics";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isActiveRobotSession,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { connectionAtomRuntime } from "../../connection/runtime";
import { m as resolveMessage } from "../../i18n/messages";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

const robotics = createRoboticsEnvironmentAtoms(connectionAtomRuntime);
type Target = { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };

export function ProjectRoboticsSection(
  props: Target & { readonly environmentLabel: string; readonly expanded?: boolean },
) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const readJobs = useEnvironmentScope(props.environmentId, AuthTerminalReadScope);
  const readRobots = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const available =
    useEnvironmentServerConfig(props.environmentId)?.environment.capabilities.robotics === true;
  if (!available || (!readJobs && !readRobots)) return null;

  if (props.expanded)
    return (
      <>
        {readRobots && (
          <SettingsSection>
            <View className="p-4">
              <RobotSessions {...props} />
            </View>
          </SettingsSection>
        )}
        {readJobs && (
          <SettingsSection>
            <View className="p-4">
              <Processes {...props} />
            </View>
          </SettingsSection>
        )}
      </>
    );

  return (
    <SettingsSection
      title={gt("Robotics · {environment}", { environment: props.environmentLabel })}
    >
      <View className="gap-4 p-3">
        <Button
          size="compact"
          label={open ? gt("Hide robotics panel") : gt("Open robotics panel")}
          onPress={() => setOpen(!open)}
        />
        {open && readRobots && <RobotSessions {...props} />}
        {open && readJobs && <Processes {...props} />}
      </View>
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
    await Promise.resolve()
      .then(() =>
        (action === "connect" ? connect : cancel)({
          environmentId,
          input: { projectId, robotId },
        }),
      )
      .then((response) => {
        if (response._tag === "Failure") reportError(squashAtomCommandFailure(response));
      }, reportError);
    setPending(false);
    refresh();
  }

  return (
    <View className="gap-2">
      <Text className="font-t3-semibold">
        <T>Robots</T>
      </Text>
      {error && <Text accessibilityLiveRegion="polite">{error}</Text>}
      {result._tag === "Initial" && (
        <Text className="text-foreground-muted">
          <T>Loading robots…</T>
        </Text>
      )}
      {result._tag === "Failure" && (
        <Text className="text-foreground-muted">
          <T>The robot registry is unavailable.</T>
        </Text>
      )}
      {result._tag === "Success" && result.value.length === 0 && (
        <Text className="text-foreground-muted">
          <T>No robots are configured for this project.</T>
        </Text>
      )}
      {result._tag === "Success" && result.value.length === 0 && (
        <Text className="text-foreground-muted">
          {gt("Register robots in {file} on the environment host.", {
            file: "robotics/registrations.json",
          })}
        </Text>
      )}
      {result._tag === "Success" &&
        result.value.map((robot) => {
          const session = robot.session;
          const canCancel = isActiveRobotSession(session);
          return (
            <View key={robot.robotId} className="gap-1 rounded-xl bg-subtle p-3">
              <Text className="font-t3-medium">{robot.displayName}</Text>
              <Text className="text-foreground-muted">
                {m(roboticsStatusLabels[session?.state ?? "disconnected"])}
                {session && canCancel ? ` · ${m(robotSessionPhaseLabels[session.phase])}` : ""}
              </Text>
              {session?.reason && (
                <Text className="text-foreground-muted">
                  {m(robotSessionReasonLabels[session.reason])}
                </Text>
              )}
              {robot.liveView && (
                <Text className="text-foreground-muted">
                  <T>Open Robotics on web or desktop for the live view.</T>
                </Text>
              )}
              {allowed && (
                <Button
                  size="compact"
                  label={canCancel ? gt("End session") : gt("Connect")}
                  disabled={pending}
                  onPress={() => void run(robot.robotId, canCancel ? "cancel" : "connect")}
                />
              )}
            </View>
          );
        })}
    </View>
  );
}

function Processes({ environmentId, projectId }: Target) {
  const gt = useGT();
  const m = useMessages();
  const allowed = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [archived, setArchived] = useState(false);
  const [before, setBefore] = useState<number | null>(null);
  const jobsAtom = robotics.jobs({
    environmentId,
    input: {
      projectId,
      view: archived ? "archived" : "current",
      limit: 25,
      ...(before === null ? {} : { before }),
    },
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

  function toggleArchive() {
    setArchived(!archived);
    setBefore(null);
    setOpenLogs(null);
    setError(null);
  }

  async function run(action: "ensure" | "stop" | "restart", id: string) {
    setPending(true);
    setError(null);
    const reportError = (cause: unknown) =>
      setError(
        errorDisplayMessage(cause, resolveMessage) ?? gt("Could not update managed process."),
      );
    await Promise.resolve()
      .then(() =>
        action === "ensure"
          ? ensure({
              environmentId,
              input: { projectId, definitionId: id, idempotencyKey: uuidv4() },
            })
          : action === "stop"
            ? stop({ environmentId, input: { projectId, jobId: id } })
            : restart({
                environmentId,
                input: { projectId, jobId: id, idempotencyKey: uuidv4() },
              }),
      )
      .then((response) => {
        if (response._tag === "Failure") reportError(squashAtomCommandFailure(response));
      }, reportError);
    setPending(false);
    if (before === null) refresh();
    else setBefore(null);
  }

  const next = jobs._tag === "Success" ? jobs.value.nextBefore : null;
  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="font-t3-semibold">
          {archived ? gt("Archived runs") : <T>Processes</T>}
        </Text>
        <View className="flex-row flex-wrap gap-1">
          {(archived || (jobs._tag === "Success" && jobs.value.hasArchived)) && (
            <Button
              size="compact"
              label={archived ? gt("Current runs") : gt("Archived runs")}
              onPress={toggleArchive}
            />
          )}
          <Button size="compact" tone="text" label={gt("Refresh")} onPress={refresh} />
        </View>
      </View>
      {error && <Text accessibilityLiveRegion="polite">{error}</Text>}
      {!archived && definitions._tag === "Failure" && (
        <Text className="text-foreground-muted">
          <T>Process definitions are unavailable.</T>
        </Text>
      )}
      {!archived &&
        allowed &&
        definitions._tag === "Success" &&
        definitions.value.map((definition) => (
          <Button
            key={definition.definitionId}
            size="compact"
            label={gt("Ensure {name} is running", { name: definition.label })}
            disabled={pending}
            onPress={() => void run("ensure", definition.definitionId)}
          />
        ))}
      {!archived && definitions._tag === "Success" && definitions.value.length === 0 && (
        <Text className="text-foreground-muted">
          {gt("Define approved processes in {file} on the environment host.", {
            file: "robotics/jobs.json",
          })}
        </Text>
      )}
      {jobs._tag === "Initial" && (
        <Text className="text-foreground-muted">
          <T>Loading processes…</T>
        </Text>
      )}
      {jobs._tag === "Failure" && (
        <Text className="text-foreground-muted">
          <T>Processes are unavailable on this environment.</T>
        </Text>
      )}
      {jobs._tag === "Success" && jobs.value.jobs.length === 0 && (
        <Text className="text-foreground-muted">
          {archived ? gt("No archived runs.") : <T>No managed processes for this project.</T>}
        </Text>
      )}
      {jobs._tag === "Success" &&
        jobs.value.jobs.map((job) => (
          <View key={job.jobId} className="gap-1 rounded-xl bg-subtle p-3">
            <Text className="font-t3-medium">
              {job.label} · {m(roboticsStatusLabels[job.state])}
            </Text>
            <Text className="text-foreground-muted">
              {[job.robotId, job.hostId].filter(Boolean).join(" · ")}
            </Text>
            {job.startedAt && (
              <Text className="text-foreground-muted">
                {gt("Started {time}", { time: new Date(job.startedAt).toLocaleString() })}
              </Text>
            )}
            {job.resourceClaims.length > 0 && (
              <Text className="text-foreground-muted">{job.resourceClaims.join(", ")}</Text>
            )}
            {job.threadId && (
              <Text className="text-foreground-muted">
                {gt("Conversation {id}", { id: job.threadId })}
              </Text>
            )}
            <View className="flex-row flex-wrap gap-2">
              <Button
                size="compact"
                label={openLogs === job.jobId ? gt("Hide logs") : gt("Logs")}
                onPress={() => setOpenLogs(openLogs === job.jobId ? null : job.jobId)}
              />
              {!archived && allowed && job.state === "running" && (
                <Button
                  size="compact"
                  label={gt("Stop")}
                  disabled={pending}
                  onPress={() => void run("stop", job.jobId)}
                />
              )}
              {!archived && allowed && ["running", "stopped", "failed"].includes(job.state) && (
                <Button
                  size="compact"
                  label={gt("Restart")}
                  disabled={pending}
                  onPress={() => void run("restart", job.jobId)}
                />
              )}
            </View>
            {openLogs === job.jobId && (
              <ProcessLogs environmentId={environmentId} projectId={projectId} jobId={job.jobId} />
            )}
          </View>
        ))}
      <View className="flex-row gap-2">
        {before !== null && (
          <Button size="compact" tone="text" label={gt("Newest")} onPress={() => setBefore(null)} />
        )}
        {next !== null && (
          <Button size="compact" tone="text" label={gt("Older")} onPress={() => setBefore(next)} />
        )}
      </View>
    </View>
  );
}

function ProcessLogs({ environmentId, projectId, jobId }: Target & { readonly jobId: string }) {
  const result = useAtomValue(
    robotics.logs({ environmentId, input: { projectId, jobId, limit: 50 } }),
  );
  if (result._tag === "Initial")
    return (
      <Text className="text-foreground-muted">
        <T>Loading logs…</T>
      </Text>
    );
  if (result._tag === "Failure")
    return (
      <Text className="text-foreground-muted">
        <T>Logs are unavailable.</T>
      </Text>
    );
  const { output, discarded } = result.value;
  return (
    <View className="gap-1">
      {discarded && (
        <Text className="text-foreground-muted">
          <T>Earlier log output was discarded.</T>
        </Text>
      )}
      {output ? (
        <Text selectable className="font-mono text-xs">
          {output}
        </Text>
      ) : (
        <Text className="text-foreground-muted">
          <T>No log output yet.</T>
        </Text>
      )}
    </View>
  );
}
