import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { T, useGT } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import { useLocalBuild } from "../../state/localBuild";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function SidebarLocalBuildNotice() {
  const gt = useGT();
  const build = useLocalBuild();
  const [relaunching, setRelaunching] = useState(false);
  if (build === null) return null;

  async function relaunch() {
    setRelaunching(true);
    try {
      // Resolves null when the staged build went away; the app quits otherwise.
      if ((await window.desktopBridge?.localBuild?.install()) !== null) return;
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not relaunch"),
          description: thrownErrorMessage(error, m) ?? gt("An unexpected error occurred."),
        }),
      );
    }
    setRelaunching(false);
  }

  return (
    <Alert variant="sidebar">
      <RefreshCwIcon />
      <AlertTitle>
        <T>New build ready</T>
      </AlertTitle>
      <AlertDescription>
        {gt("Built {time}. Relaunch to use it.", {
          time: new Date(build.builtAt).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          }),
        })}
      </AlertDescription>
      <AlertAction>
        <Button size="xs" disabled={relaunching} onClick={() => void relaunch()}>
          {relaunching ? gt("Relaunching…") : gt("Relaunch")}
        </Button>
      </AlertAction>
    </Alert>
  );
}
