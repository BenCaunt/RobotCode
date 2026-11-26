import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { BotIcon, ChartNoAxesColumnIcon } from "lucide-react";

import { SidebarMenu, SidebarMenuItem, SidebarMenuSubButton, useSidebar } from "../ui/sidebar";

export function SidebarProjectLinks({
  project,
  parentRow,
  projectLabel,
}: {
  project: string | undefined;
  parentRow?: string;
  projectLabel?: string;
}) {
  const gt = useGT();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenu aria-label={projectLabel}>
      {(
        [
          { to: "/robotics", label: gt("Robotics"), Icon: BotIcon },
          { to: "/evaluations", label: gt("Evaluations"), Icon: ChartNoAxesColumnIcon },
        ] as const
      ).map(({ to, label, Icon }) => (
        <SidebarMenuItem key={to}>
          <SidebarMenuSubButton
            size={parentRow ? "sm" : "md"}
            data-sidebar-row={parentRow && `${project}${to}`}
            data-sidebar-parent={parentRow}
            render={
              <Link
                to={to}
                search={project ? { project } : {}}
                activeOptions={{ includeSearch: Boolean(parentRow) }}
                activeProps={{ className: "bg-sidebar-row-selected" }}
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                }}
              />
            }
          >
            <Icon aria-hidden className="size-3.5" />
            <span>{label}</span>
          </SidebarMenuSubButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
