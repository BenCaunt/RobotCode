import { RERUN_VIEWER_VERSION, type ProviderInteractionMode } from "@t3tools/contracts";

export const ROBOTICS_INSTRUCTIONS = `## RobotCode robotics

For robot setup or connection requests, interpret “this harness” as Robot Code’s project-level robotics configuration unless the user specifies another harness. Start with t3_robotics_robot_list and check the available configuration capabilities for that project. An empty registry means the robot still needs to be registered.
Complete the setup that can be done offline. Use the supported registration path on the environment server that hosts the project. For file-based registration, use robotics/registrations.json under that server’s state directory, resolve the existing project ID with t3_project_list, and preserve other entries. Use confirmed settings, identify missing hardware details, and distinguish saved configuration from activation and live readiness checks. File-based registration takes effect when the file is saved, without a server restart. If you lack the capability or access for a step, report the specific blocker. Change repository code only when the user asks for it or the Robot Code integration requires it.

A robot's live view is a Rerun stream that the Robotics page embeds, the same for a simulated and a real robot. To build or improve one, write a read-only bridge that logs to rr.serve_grpc with rerun-sdk ${RERUN_VIEWER_VERSION}, register it as a non-actuating bridge definition, and set the robot's liveView to {"url":"rerun+http://<host>:<port>/proxy"}. Whenever a robot model exists (URDF, MJCF or meshes in the project, the vendor's description package, or the simulator's scene), load it into a 3D view and drive its joints and base pose from the live state: rerun.urdf.UrdfTree logs a URDF and computes joint transforms. Without a model, say so and show frames and geometry instead. Add time series for the signals that explain behavior, such as commanded against measured values, with units in the names. Add cameras, point clouds and maps when the robot has them. Log static data once with static=True and send a default blueprint that lays out the 3D view beside the plots, so the page opens as a finished dashboard. Use a recording tile or an .rrd file for recorded data, not for a live robot.
For a reusable recording tile, use t3 tile schema for widget bindings and t3 tile inspect <sources.json> for available signals. Write or edit its .tile.json, bind map, plot, and camera widgets on one clock in seconds. Prefer one continuous canvas with aligned views, whitespace, and shared controls. Avoid cards around individual widgets. Run t3 tile build <manifest>. Show the resulting .tile.html with html_preview and html_render and link the project file for reopening.
For a robot's current state, use t3_robotics_robot_list. For project processes and approved definitions, use t3_robotics_job_list, then t3_robotics_job_inspect for logs. Use t3_robotics_annotation_get for a saved Rerun note. These reads leave sessions and jobs alone.
Changing state requires a live project thread in Full Access and Default mode. Use t3_robotics_robot_session to connect or cancel readiness checks. Connect can start approved bridges. Use t3_robotics_job_manage for approved non-actuating processes. Calling ensure reuses a running job. Jobs belong to the project and can outlive the thread. If access is denied, report the limit and stay within it, including in the shell.
A ready session reports a successful probe. Job claims reserve resources among managed jobs. Physical writes require authority at the robot's command receiver. In the authority simulator each resource admits one writer. Observers can coexist with that writer only under the shared-observer policy. Advisory resources allow observation only. The robotics tools expose no physical command path.`;

export const EVALUATION_REPORT_INSTRUCTIONS = `## Experiment reports and hill climbs

Write for a researcher who needs to decide what to try next and can open only the report. Before running a hill climb, define the objective, baseline, split, selection rule and tie-break. Decide which observations, intermediate model outputs, actions and outcomes to capture on a common clock. Record the reasons for strategy choices as they happen. Keep training decisions separate from held-out evaluation.

In the published Markdown, answer these questions with concrete measurements and source artifacts:
- What problem was the agent trying to fix? Explain the benchmark in plain language, what the policy saw, what the evaluator alone knew, how success was scored, and which model/checkpoint, code and settings were used.
- Why try this strategy? Describe the baseline failure, the hypothesis it suggested, the alternatives tried, and the consequential changes from the baseline. Show the trial scores, what was rejected, the actual selection rule and tie-break, and when the chosen revision was frozen. Attribute a recorded rationale to its source. If no rationale was saved, say so.
- What happened? Lead with the measured result, unit, denominator, split and comparable baseline. Put the main measure in primaryMetric, e.g. {"label":"Peak incline","value":9,"unit":"°","baselineValue":6}. Supply baselineValue only for matched conditions. Pin inputs, revisions, seeds when available, and a baseline ID.
- How did the system produce that result? Pick a consequential decision or failure. Show the actual input, intermediate prediction and planner/controller output alongside the observed outcome at the same step. For visual navigation, show the camera view, semantic or traversability map, robot trajectory, goal and chosen waypoint when available. Label frames, coordinate systems, units and the meaning of colors. Explain what the reader should inspect at a specific replay citation. Use charts for aggregate scores. A progress curve alone cannot explain a perception or planning decision.
- What did we learn? Separate observed errors from hypotheses about their cause. Identify confounds, missing channels and coverage limits. End with a specific ablation or next experiment and what observation would distinguish the explanations.

Embed a measured plot (fenced mermaid xychart-beta or a project figure) or diagnostic image in the summary. Image URLs are relative to evaluations/; evidence paths are project-relative. Include sources and the figure in evidence. For completed runs inspect saved artifacts first. Label an offline replay or a fresh diagnostic rerun, record its frozen inputs, and compare its outcome with the original. Never invent frames, rationale, or causal findings. Open the published figure and check the cited recording position.

To embed Rerun in an evaluation, list the project-relative .rrd in the manifest's evidence. Add replayCitations entries such as {"id":"wheel-slip","label":"Front wheels slip","path":"run.rrd","timeline":"elapsed","timeType":"duration","time":"12400000000"}. Use the observed timeline and exact integer string (nanoseconds for duration/timestamp, index for sequence). For multi-recording files include recordingId (full Recording: store ID). Publish with t3 evaluation publish <manifest>. To link the observation inline, use [12.4 s](t3-context://v1/replay/wheel-slip) in summary.`;

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- Subagents: use your native tool when the child uses your provider, a model it offers and no settings beyond yours (Claude \`Agent\`, \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Use \`delegate_task\` for another provider's model, user-asked settings, a separate checkout (\`isolation:"worktree"\`), or \`delegate_task\` by name. A native type on another provider's model counts too. Background agent: \`delegate_task\`, never a background \`Agent\`. Workflow only when asked.
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked or fall back to native tools, Workflow or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Follow a running delegate's \`next\`. Don't poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- As a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
  `- \`t3_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`. Honor a requested base. Otherwise independent work uses the default branch as \`remote/branch\` with \`startFromOrigin:true\`; with no remote, use the local default. Required unpublished commits and dependent work use their local base. Shell worktrees don't bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.
- Given a thread id, \`t3_thread_read\` it before you answer about it. Asked to settle a thread, this one too: \`t3_thread_organize\`.
- Another machine: \`t3_environment_links\` lists linked ones. Pass its \`environmentId\` and that machine's \`threadId\` to T3 tools.
- Unlinked ("delegate this to my vps"): \`t3_environment_link\` with a \`hint\` from the user's words, never a pairing code in chat. No link tools: say to enable Settings → Labs → Linked environments.
- In your reply, mention a thread by its \`link\`, verbatim, never a plain title or bare id.
- A login, token, PIN, pairing code or sudo password only the user can give: call \`request_secret\`, not a chat ask or a handoff. Not for access you have. Sudo: if \`sudo -n <cmd>\` needs a password, use \`delivery: "file"\` and run \`sudo -S -p '' <cmd> < "$file"\`; the password takes stdin, so give other input as a file argument. Asked only to schedule: \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before you call it absent.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart and show any visual the user asks for here: pass an HTML file path or inline HTML to \`html_preview\`, then \`html_render\`. A screenshot on disk or a text description doesn't show it. Never start a server for it. Page tools write only on user request. Never use them to show results. Asked for an image to post, send or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Never use \`preview_*\` unasked to verify or show your own edit. Use them when the current request asks for browser work, including recording edits, or names a page or tab. Don't repeat preview calls from an earlier turn. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
  ROBOTICS_INSTRUCTIONS,
  EVALUATION_REPORT_INSTRUCTIONS,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. On Windows, run \`T3_ACP_MCP_CALL\` instead and pipe the JSON to stdin, as in PowerShell \`'{}' | & $env:T3_ACP_MCP_CALL orchestrator_capabilities -\`, writing non-ASCII characters as \`\\uXXXX\` escapes.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          ...(input.state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

const orchestrationInstructions = (hasDeviceTools: boolean) =>
  hasDeviceTools
    ? `${T3_CODE_ORCHESTRATION_INSTRUCTIONS}\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n`
    : T3_CODE_ORCHESTRATION_INSTRUCTIONS;

function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
  /** Guidance for this provider's own tools, sent until `providerInstructionsDelivered`. */
  readonly providerInstructions?: string;
  readonly providerInstructionsDelivered?: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  const instructions = [
    !input.orchestrationDelivered
      ? orchestrationInstructions(input.hasDeviceTools)
      : input.hasDeviceTools && !input.deviceInstructionsDelivered
        ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS
        : undefined,
    input.providerInstructionsDelivered === true ? undefined : input.providerInstructions,
  ].flatMap((part) => (part === undefined ? [] : [part.trim()]));
  return instructions.length === 0
    ? input.prompt
    : prependT3OrchestrationInstructions(input.prompt, instructions.join("\n\n"));
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools) : undefined;
}
