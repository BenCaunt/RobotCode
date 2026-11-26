import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AuthFilesystemReadScope, type EnvironmentId } from "@t3tools/contracts";
import {
  evaluationDirectory,
  groupEvaluationEntries,
  replayPosition,
} from "@t3tools/shared/evaluationReport";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { isRerunRecordingPath } from "@t3tools/shared/filePreview";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { tryOpenWebLink } from "../../lib/openExternalUrl";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentsWithScope, usePreparedConnection } from "../../state/session";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { FileMarkdownPreview } from "../files/FileMarkdownPreview";

export function EvaluationsRouteScreen({
  route,
}: StaticScreenProps<{ project?: string; result?: string } | undefined>) {
  const gt = useGT();
  const navigation = useNavigation();
  const hosts = useWorkspaceEnvironments();
  const readable = useEnvironmentsWithScope(hosts, AuthFilesystemReadScope);
  const projects = useProjects().flatMap((p) => {
    const host = hosts.find(
      (h) => h.environmentId === p.environmentId && h.connectionState === "connected",
    );
    return host && readable.has(p.environmentId)
      ? [{ ...p, key: scopedProjectKey(p.environmentId, p.id), host: host.environmentLabel }]
      : [];
  });
  const params = route.params;
  const selected =
    params?.project === undefined && params?.result === undefined
      ? projects[0]
      : projects.find((p) => p.key === params?.project);
  const open = (id: string) =>
    selected &&
    navigation.dispatch(StackActions.push("Evaluations", { project: selected.key, result: id }));
  return (
    <View className="flex-1 bg-screen">
      <AppBar
        title={gt("Evaluations")}
        onBack={() => navigation.goBack()}
        menus={
          projects.length
            ? [
                {
                  title: gt("Project"),
                  icon: "folder",
                  items: projects.map((p) => ({
                    id: p.key,
                    title: p.title,
                    subtitle: p.host + " · " + p.workspaceRoot,
                    selected: p.key === selected?.key,
                    onPress: () =>
                      navigation.dispatch(StackActions.replace("Evaluations", { project: p.key })),
                  })),
                },
              ]
            : undefined
        }
      />
      <ScreenContent surface="screen">
        {!selected ? (
          <AppText className="p-5">{gt("This project is unavailable or cannot be read.")}</AppText>
        ) : params?.result !== undefined ? (
          <Detail
            key={selected.key + "/" + params.result}
            environmentId={selected.environmentId}
            cwd={selected.workspaceRoot}
            project={selected.key}
            id={params.result}
            open={open}
          />
        ) : (
          <Results
            key={selected.key}
            environmentId={selected.environmentId}
            cwd={selected.workspaceRoot}
            title={selected.title + " · " + selected.host}
            open={open}
          />
        )}
      </ScreenContent>
    </View>
  );
}

type Target = { environmentId: EnvironmentId; cwd: string; open: (id: string) => void };
function Results({ environmentId, cwd, title, open }: Target & { title: string }) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const atom = projectEnvironment.evaluationEntries({ environmentId, input: { cwd } });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const groups =
    result._tag === "Success" ? groupEvaluationEntries(result.value.entries, query) : [];
  return (
    <ScreenScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-4 px-5 py-6"
    >
      <View className="flex-row items-center justify-between gap-3">
        <AppText className="flex-1 font-t3-semibold text-xl">{title}</AppText>
        <Button size="compact" label={gt("Refresh")} onPress={refresh} />
      </View>
      <AppTextInput
        accessibilityLabel={gt("Find a result")}
        placeholder={gt("Find by name, category, or ID")}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {result._tag === "Initial" && <AppText>{gt("Loading…")}</AppText>}
      {result._tag === "Failure" && <AppText>{gt("Could not load evaluation results.")}</AppText>}
      {result._tag === "Success" && !groups.length && (
        <AppText>
          {query.trim()
            ? gt("No matching results.")
            : gt("Publish your first result from the project folder with {command}.", {
                command: "t3 evaluation publish manifest.json",
              })}
        </AppText>
      )}
      {groups.map(({ category, results }) => (
        <View key={category} className="gap-2">
          <AppText className="font-t3-semibold">{category}</AppText>
          {results.map((entry) => (
            <ListActionRow
              key={entry.id}
              label={entry.name}
              description={entry.id}
              onPress={() => open(entry.id)}
            />
          ))}
        </View>
      ))}
    </ScreenScrollView>
  );
}

function Detail({
  environmentId,
  cwd,
  id,
  project,
  open,
}: Target & { id: string; project: string }) {
  const gt = useGT();
  const [tab, setTab] = useState<"summary" | "provenance" | "replay">("summary");
  const connection = usePreparedConnection(environmentId);
  const [linkFailed, setLinkFailed] = useState(false);
  async function openReplay(replay: string) {
    if (connection._tag !== "Some") {
      setLinkFailed(true);
      return;
    }
    const host = connection.value;
    const url = new URL(
      "evaluations",
      (host.target._tag === "RelayConnectionTarget"
        ? DEFAULT_HOSTED_APP_URL
        : host.httpBaseUrl
      ).replace(/\/?$/, "/"),
    );
    url.hash = "replay-evidence";
    url.search = new URLSearchParams({ project, result: id, replay }).toString();
    setLinkFailed(!(await tryOpenWebLink(url.href)));
  }
  const atom = projectEnvironment.evaluationReport({ environmentId, input: { cwd, id } });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const report = result._tag === "Success" ? result.value : null;
  if (!report)
    return (
      <View className="gap-3 p-5">
        <AppText>
          {result._tag === "Initial"
            ? gt("Loading…")
            : result._tag === "Failure"
              ? gt("Could not load evaluation results.")
              : gt("This result is missing or its contents no longer match its ID.")}
        </AppText>
        <Button label={gt("Retry")} onPress={refresh} />
      </View>
    );
  return (
    <View className="flex-1">
      <View className="gap-2 px-5 py-3">
        <AppText className="text-foreground-muted">
          {report.category} · {report.mode === "physical" ? gt("Physical") : gt("Simulation")}
        </AppText>
        <AppText className="font-t3-semibold text-xl">{report.title}</AppText>
        <AppText selectable className="font-mono text-xs">
          {id}
        </AppText>
        <View className="flex-row flex-wrap gap-2">
          <Button
            size="compact"
            label={tab === "provenance" ? gt("Summary") : gt("Provenance")}
            onPress={() => setTab(tab === "provenance" ? "summary" : "provenance")}
          />
          {report.evidence.some((file) => isRerunRecordingPath(file.path)) && (
            <Button
              size="compact"
              label={tab === "replay" ? gt("Summary") : gt("Replay evidence")}
              onPress={() => setTab(tab === "replay" ? "summary" : "replay")}
            />
          )}
        </View>
      </View>
      {tab === "replay" ? (
        <ScreenScrollView contentContainerClassName="gap-3 px-5 py-4">
          <AppText className="font-t3-semibold">{gt("Open in Browser")}</AppText>
          {report.evidence
            .filter((file) => isRerunRecordingPath(file.path))
            .map((file) => (
              <View key={file.path} className="gap-1">
                <ListActionRow label={file.path} onPress={() => void openReplay(file.path)} />
                {report.replayCitations
                  ?.filter((item) => item.path === file.path)
                  .map((item) => (
                    <ListActionRow
                      key={item.id}
                      label={item.label}
                      description={replayPosition(item)}
                      onPress={() => void openReplay(item.id)}
                    />
                  ))}
              </View>
            ))}
          {linkFailed && <AppText>{gt("Could not open link")}</AppText>}
        </ScreenScrollView>
      ) : tab === "provenance" ? (
        <ScreenScrollView contentContainerClassName="gap-3 px-5 py-4">
          <AppText className="font-t3-semibold">{gt("Recorded")}</AppText>
          <AppText selectable>{report.recordedAt}</AppText>
          <AppText className="font-t3-semibold">{gt("Revision")}</AppText>
          <AppText selectable>{report.revision}</AppText>
          <AppText className="font-t3-semibold">{gt("Setup")}</AppText>
          <AppText selectable>{report.setup}</AppText>
          {report.baseline && (
            <ListActionRow
              label={gt("Baseline")}
              description={report.baseline}
              onPress={() => open(report.baseline!)}
            />
          )}
          <AppText className="font-t3-semibold">{gt("Evidence")}</AppText>
          {report.evidence.map((item) => (
            <View key={item.path}>
              <AppText selectable>{item.path}</AppText>
              <AppText selectable className="font-mono text-xs">
                {"sha256:" + item.sha256}
              </AppText>
            </View>
          ))}
        </ScreenScrollView>
      ) : (
        <FileMarkdownPreview
          markdown={report.summary}
          onOpenLink={(href) => {
            const ref = parseComposerContextHref(href);
            if (
              ref?.kind !== "replay" ||
              !report.replayCitations?.some((c) => c.id === ref.contextId)
            )
              return false;
            setTab("replay");
            void openReplay(ref.contextId);
            return true;
          }}
          cwd={cwd}
          environmentId={environmentId}
          relativePath={evaluationDirectory + "/" + id + ".json"}
          threadId={null}
        />
      )}
    </View>
  );
}
