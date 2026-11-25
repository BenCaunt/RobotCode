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

export function ProjectRoboticsSection(props: Target & { readonly environmentLabel: string }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const readJobs = useEnvironmentScope(props.environmentId, AuthTerminalReadScope);
  const readRobots = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const available =
    useEnvironmentServerConfig(props.environmentId)?.environment.capabilities.robotics === true;
  if (!available || (!readJobs && !readRobots)) return null;

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
    try {
      const response = await (action === "connect" ? connect : cancel)({
        environmentId,
        input: { projectId, robotId },
      });
      if (response._tag === "Failure") {
        setError(
          errorDisplayMessage(squashAtomCommandFailure(response), resolveMessage) ??
            gt("Could not update robot session."),
        );
      }
      refresh();
    } finally {
      setPending(false);
    }
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
      {result._tag === "Success" &&
        result.value.map((robot) => {
          const session = robot.session;
          const canCancel =
            session?.state === "connecting" ||
            session?.state === "ready" ||
            session?.state === "degraded";
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
    try {
      const response =
        action === "ensure"
          ? await ensure({
              environmentId,
              input: { projectId, definitionId: id, idempotencyKey: uuidv4() },
            })
          : action === "stop"
            ? await stop({ environmentId, input: { projectId, jobId: id } })
            : await restart({
                environmentId,
                input: { projectId, jobId: id, idempotencyKey: uuidv4() },
              });
      if (response._tag === "Failure") {
        setError(
          errorDisplayMessage(squashAtomCommandFailure(response), resolveMessage) ??
            gt("Could not update managed process."),
        );
      }
      if (before === null) refresh();
      else setBefore(null);
    } finally {
      setPending(false);
    }
  }

  const next = jobs._tag === "Success" ? jobs.value.nextBefore : null;
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="font-t3-semibold">
          <T>Processes</T>
        </Text>
        <Button size="compact" tone="text" label={gt("Refresh")} onPress={refresh} />
      </View>
      {error && <Text accessibilityLiveRegion="polite">{error}</Text>}
      {definitions._tag === "Failure" && (
        <Text className="text-foreground-muted">
          <T>Process definitions are unavailable.</T>
        </Text>
      )}
      {allowed &&
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
          <T>No managed processes for this project.</T>
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
              {allowed && job.state === "running" && (
                <Button
                  size="compact"
                  label={gt("Stop")}
                  disabled={pending}
                  onPress={() => void run("stop", job.jobId)}
                />
              )}
              {allowed && ["running", "stopped", "failed"].includes(job.state) && (
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
