import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { ListActionRow } from "../../components/ui/ListActionRow";
import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import type { HomeProjectScope } from "./homeThreadList";

export function ProjectNavigationRows({
  scopes,
  selected,
  environments,
  onProjectChange,
}: {
  scopes: readonly HomeProjectScope[];
  selected: HomeProjectScope | null;
  environments: readonly HomeListFilterMenuEnvironment[];
  onProjectChange: (key: string | null) => void;
}) {
  const selectDetail = useSelectWorkspaceDetail();
  const gt = useGT();
  if (!selected) {
    return scopes.map((scope) => (
      <ListActionRow
        key={scope.key}
        icon="folder"
        label={scope.title}
        onPress={() => onProjectChange(scope.key)}
      />
    ));
  }
  return (
    <View>
      <ListActionRow
        icon="chevron.left"
        label={gt("All projects")}
        detail={selected.title}
        onPress={() => onProjectChange(null)}
      />
      {selected.projects
        .filter((member) => !member.isScratch && member.archivedAt == null)
        .map((member) => {
          const project = scopedProjectKey(member.environmentId, member.id);
          const host = environments.find((env) => env.environmentId === member.environmentId);
          const detail =
            selected.projects.length > 1
              ? `${host?.label ?? member.environmentId} · ${member.workspaceRoot}`
              : undefined;
          return (
            <View key={project}>
              <ListActionRow
                label={gt("Robotics")}
                description={detail}
                icon="robot"
                onPress={() => selectDetail({ name: "Robotics", params: { project } })}
              />
              <ListActionRow
                label={gt("Evaluations")}
                description={detail}
                icon="chart.bar.xaxis"
                onPress={() => selectDetail({ name: "Evaluations", params: { project } })}
              />
            </View>
          );
        })}
    </View>
  );
}
