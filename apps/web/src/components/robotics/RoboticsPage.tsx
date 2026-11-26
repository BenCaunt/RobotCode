import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationReadScope, AuthTerminalReadScope } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { BotIcon, ServerIcon } from "lucide-react";

import { isElectron } from "../../env";
import { useConnectedEnvironmentIds, useEnvironments } from "../../state/environments";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironmentsWithScope } from "../../state/session";
import { ProjectRoboticsControls } from "../settings/ProjectRoboticsPanel";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

export function RoboticsPage() {
  const gt = useGT();
  const navigate = useNavigate();
  const { project: selectedKey, robot: viewing } = useSearch({ from: "/_chat/robotics" });
  const allProjects = useProjects();
  const { environments } = useEnvironments();
  const connected = useConnectedEnvironmentIds();
  const configs = useServerConfigs();
  const robots = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const jobs = useEnvironmentsWithScope(environments, AuthTerminalReadScope);
  const projects = allProjects
    .filter(
      ({ environmentId }) =>
        connected.includes(environmentId) &&
        configs.get(environmentId)?.environment.capabilities.robotics &&
        (robots.has(environmentId) || jobs.has(environmentId)),
    )
    .map((project) => ({
      ...project,
      key: scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }),
      environmentLabel:
        environments.find((host) => host.environmentId === project.environmentId)?.label ??
        project.environmentId,
    }));
  const selected =
    selectedKey === undefined ? projects[0] : projects.find((entry) => entry.key === selectedKey);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <BotIcon aria-hidden className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">{gt("Robotics")}</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width={viewing === undefined ? "readable" : "expanded"}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            {selected && (
              <div className="min-w-0">
                <h2 className="break-words text-2xl font-semibold tracking-tight">
                  {selected.title}
                </h2>
                <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <ServerIcon aria-hidden className="size-4" />
                  {selected.environmentLabel}
                </p>
              </div>
            )}
            {projects.length > 0 && (projects.length > 1 || !selected) && (
              <Select
                value={selected?.key ?? null}
                onValueChange={(value) => {
                  if (value !== null)
                    void navigate({ to: "/robotics", search: { project: value } });
                }}
              >
                <SelectTrigger aria-label={gt("Select a project")}>
                  <SelectValue placeholder={gt("Select a project")}>{selected?.title}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((member) => (
                    <SelectItem key={member.key} value={member.key}>
                      {member.title} · {member.environmentLabel} · {member.workspaceRoot}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </div>
          {selected ? (
            <ProjectRoboticsControls
              key={selected.key}
              environmentId={selected.environmentId}
              projectId={selected.id}
              viewing={viewing}
              onView={(robot) =>
                void navigate({
                  to: "/robotics",
                  search: { project: selected.key, ...(robot === undefined ? {} : { robot }) },
                })
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {selectedKey && projects.length
                ? gt("This project is no longer available.")
                : gt("No projects with robotics access are available.")}
            </p>
          )}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}
