import { createFileRoute } from "@tanstack/react-router";

import { RoboticsPage } from "../components/robotics/RoboticsPage";

export const Route = createFileRoute("/_chat/robotics")({
  validateSearch: (raw): { project?: string; robot?: string } => ({
    ...(typeof raw.project === "string" ? { project: raw.project } : {}),
    ...(typeof raw.robot === "string" ? { robot: raw.robot } : {}),
  }),
  component: RoboticsPage,
});
