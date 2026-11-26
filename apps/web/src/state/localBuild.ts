import type { DesktopLocalBuildState } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

// The build is staged from a terminal, outside the app, so there is no event to wait on.
const POLL_INTERVAL_MS = 30_000;

let current: DesktopLocalBuildState = null;
const listeners = new Set<() => void>();
let stopWatching: (() => void) | undefined;

function refresh() {
  void window.desktopBridge?.localBuild
    ?.getState()
    .then((next) => {
      if (next?.builtAt === current?.builtAt) return;
      current = next;
      for (const listener of listeners) listener();
    })
    .catch(() => undefined);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (stopWatching === undefined && window.desktopBridge?.localBuild) {
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    window.addEventListener("focus", refresh);
    stopWatching = () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopWatching?.();
      stopWatching = undefined;
    }
  };
}

/** A newer build of the desktop app staged on this machine, ready to relaunch into. */
export function useLocalBuild(): DesktopLocalBuildState {
  return useSyncExternalStore(subscribe, () => current);
}
