import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AuthOrchestrationReadScope, AuthTerminalReadScope } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironmentsWithScope } from "../../state/session";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { ProjectRoboticsSection } from "../settings/ProjectRoboticsSection";

export function RoboticsRouteScreen({
  route,
}: StaticScreenProps<{ project?: string } | undefined>) {
  const gt = useGT();
  const navigation = useNavigation();
  const environments = useWorkspaceEnvironments();
  const configs = useServerConfigs();
  const projects = useProjects();
  const robots = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const jobs = useEnvironmentsWithScope(environments, AuthTerminalReadScope);
  const choices = projects.flatMap((project) => {
    const id = project.environmentId;
    const host = environments.find(
      (env) => env.environmentId === id && env.connectionState === "connected",
    );
    if (
      !host ||
      !configs.get(id)?.environment.capabilities.robotics ||
      (!robots.has(id) && !jobs.has(id))
    )
      return [];
    return [{ project, host: host.environmentLabel, key: scopedProjectKey(id, project.id) }];
  });
  const key = route.params?.project;
  const selected = key === undefined ? choices[0] : choices.find((entry) => entry.key === key);
  return (
    <View className="flex-1 bg-screen">
      <AppBar
        title={gt("Robotics")}
        onBack={() => navigation.goBack()}
        menus={
          choices.length > 1 || (!selected && choices.length > 0)
            ? [
                {
                  title: gt("Project"),
                  icon: "folder",
                  items: choices.map((entry) => ({
                    id: entry.key,
                    title: entry.project.title,
                    subtitle: `${entry.host} · ${entry.project.workspaceRoot}`,
                    selected: entry.key === selected?.key,
                    onPress: () =>
                      navigation.dispatch(StackActions.replace("Robotics", { project: entry.key })),
                  })),
                },
              ]
            : undefined
        }
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          contentContainerClassName="gap-4 px-5 py-6"
        >
          {selected ? (
            <>
              <View>
                <AppText className="font-t3-semibold text-2xl">{selected.project.title}</AppText>
                <AppText className="text-foreground-muted">{selected.host}</AppText>
              </View>
              <ProjectRoboticsSection
                key={selected.key}
                projectId={selected.project.id}
                environmentId={selected.project.environmentId}
                environmentLabel={selected.host}
                expanded
              />
            </>
          ) : (
            <AppText>
              {choices.length
                ? gt("This project is no longer available.")
                : gt("No projects with robotics access are available.")}
            </AppText>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
