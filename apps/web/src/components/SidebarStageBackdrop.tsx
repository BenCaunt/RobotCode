import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentIdentificationMode } from "@t3tools/contracts";
import { useId } from "react";

import { APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppStageLabel } from "../branding.logic";
import { primaryServerConfigAtom } from "../state/server";

export type SidebarStageBackdropVariant = "nightly" | "dev";
export type EnvironmentIdentificationPillLabel = "Dev" | "Nightly";

export function resolveSidebarStageBackdropVariant(
  stageLabel: string,
  mode: EnvironmentIdentificationMode = "artwork",
): SidebarStageBackdropVariant | null {
  if (mode === "nightly-artwork") return "nightly";
  if (mode === "dev-artwork") return "dev";
  if (mode !== "artwork") return null;
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "nightly") return "nightly";
  if (normalized === "dev") return "dev";
  return null;
}

export function resolveEnvironmentIdentificationPillLabel(
  stageLabel: string,
): EnvironmentIdentificationPillLabel | null {
  const normalized = stageLabel.trim().toLowerCase();
  // oxlint-disable-next-line t3code/no-untranslated-copy -- release channel names
  if (normalized === "dev") return "Dev";
  // oxlint-disable-next-line t3code/no-untranslated-copy -- release channel names
  if (normalized === "nightly") return "Nightly";
  return null;
}

export function useEnvironmentStageLabel(): string {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveServerBackedAppStageLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

export function useSidebarStageBackdropVariant(
  mode: EnvironmentIdentificationMode,
): SidebarStageBackdropVariant | null {
  return resolveSidebarStageBackdropVariant(useEnvironmentStageLabel(), mode);
}

export function SidebarStageBackdrop({ variant }: { variant: SidebarStageBackdropVariant }) {
  return (
    <div
      aria-hidden
      className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 z-0 h-20 select-none overflow-hidden"
    >
      <StageBackdropArt variant={variant} />
    </div>
  );
}

export function StageBackdropButtonArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return <StageBackdropArt variant={variant} />;
}

function StageBackdropArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  const id = useId();
  const nightly = variant === "nightly";
  const pigment = nightly ? "var(--stage-night-bottom)" : "var(--stage-art-bottom)";
  const ink = nightly ? "var(--stage-night-line)" : "var(--stage-art-line)";
  return (
    <svg className="h-full w-full" fill="none" aria-hidden>
      <defs>
        <pattern id={id} width="192" height="96" patternUnits="userSpaceOnUse">
          <g stroke={ink} strokeOpacity=".28" strokeWidth="1">
            <circle cx="144" cy="38" r={nightly ? 25 : 18} />
            <circle cx="144" cy="38" r="11" />
            <path d="M102 38h84M144 4v68" strokeDasharray="8 4 2 4" />
            <path d="M20 70h60l18-18h18M20 74h62l18-18" />
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={pigment} />
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
