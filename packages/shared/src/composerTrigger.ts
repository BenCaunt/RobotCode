import { parseMarkdownFileLink } from "./markdownLinks.ts";

export type ComposerTriggerKind = "path" | "pull-request" | "slash-command" | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

function composerFileLinkBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

// Emphasis markers too: `__init__.py` would otherwise render as bold "init.py",
// which no longer matches the path, so the label shows beside the chip.
function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/[\\[\]*_&]/g, "\\$&");
}

function encodeMarkdownLinkDestination(path: string): string {
  return encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("&", "%26")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
}

const URI_OR_ROOTED_PATH_PATTERN = /^(?:[a-z][a-z\d+.-]*:|[\\/])/i;

// A relative destination the parser rejects (`C%23/Program.cs`) gets `./`, as codexFileCitations does.
function needsDotSlashPrefix(path: string): boolean {
  return (
    path.length > 0 &&
    !parseMarkdownFileLink(encodeMarkdownLinkDestination(path)) &&
    !URI_OR_ROOTED_PATH_PATTERN.test(path)
  );
}

export function serializeComposerFileLink(path: string): string {
  const label = escapeMarkdownLinkLabel(composerFileLinkBasename(path));
  const destination = encodeMarkdownLinkDestination(path);
  return `[${label}](${needsDotSlashPrefix(path) ? `./${destination}` : destination})`;
}

/** The file a composer link names. Drops only the `./` serializeComposerFileLink adds, not one the author wrote. */
export function composerFileLinkPath(encodedDestination: string, decodedPath: string): string {
  if (!encodedDestination.startsWith("./")) return decodedPath;
  const bare = decodedPath.slice(2);
  return needsDotSlashPrefix(bare) &&
    encodeMarkdownLinkDestination(bare) === encodedDestination.slice(2)
    ? bare
    : decodedPath;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

/** A second slash or backslash makes the whole word a path, even when the caret precedes it. */
export function isPathWord(
  text: string,
  wordStart: number,
  cursor: number,
  isWhitespaceChar: (char: string) => boolean,
): boolean {
  let wordEnd = cursor;
  while (wordEnd < text.length && !isWhitespaceChar(text[wordEnd] ?? "")) {
    wordEnd += 1;
  }
  return /[/\\]/.test(text.slice(wordStart + 1, wordEnd));
}

/**
 * `$5`, `€9.99` and `$10k` are money, not skills. Matches the amounts the inline skill
 * token regexes already refuse to render as skills, plus the punctuation prose puts after
 * one (`$10k.`, `($5)`).
 */
export function isCurrencyAmountQuery(query: string): boolean {
  return /^\.?[0-9][0-9,._]*(?:[kKmMbBtT]|[eE][0-9]+)?[.,;:!?)]*$/.test(query);
}

export function detectComposerPullRequestTrigger(token: string, cursor: number) {
  if (/^[@\p{Sc}]/u.test(token)) return null;
  const match = /(?:^|\p{Ps})#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (!match) return null;
  const query = match[1] ?? "";
  return {
    kind: "pull-request" as const,
    query,
    rangeStart: cursor - query.length - 1,
    rangeEnd: cursor,
  };
}

export function detectComposerTrigger(
  text: string,
  cursorInput: number,
  isWhitespaceChar?: (char: string) => boolean,
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const wsCheck = isWhitespaceChar ?? isWhitespace;
  let tokenIdx = cursor - 1;
  while (tokenIdx >= 0 && !wsCheck(text[tokenIdx] ?? "")) {
    tokenIdx -= 1;
  }
  const tokenStart = tokenIdx + 1;

  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("/")) {
    if (isPathWord(text, tokenStart, cursor, wsCheck)) return null;
    return {
      kind: "slash-command",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const pullRequestTrigger = detectComposerPullRequestTrigger(token, cursor);
  if (pullRequestTrigger) return pullRequestTrigger;
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    if (isCurrencyAmountQuery(token.slice(skillPrefix[0].length))) return null;
    return {
      kind: "skill",
      query: token.slice(skillPrefix[0].length),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}

/** A message that only invokes a slash command, such as `/context all`, not a path like `/src/a.ts`. */
export function isSlashCommand(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
}): boolean {
  return message.attachments.length === 0 && /^\/[\w:-]+(?:\s|$)/u.test(message.text.trim());
}

/** `/clear` as the whole message arms a fresh session instead of sending. */
export function isClearComposerCommand(text: string): boolean {
  return /^\/clear\s*$/i.test(text.trim());
}

export function parseSideChatCommand(text: string): { prompt: string; progress?: true } | null {
  const progress = /^\/progress(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (progress) return { prompt: progress[1]?.trim() ?? "", progress: true };
  const match = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { prompt: match[1]?.trim() ?? "" } : null;
}

export function progressSnapshot(
  threadId: string,
  cutoff: string,
  sideChats: ReadonlyArray<{ id: string; title: string; createdAt: string }>,
  focus: string,
) {
  const prefix = "Progress snapshot · ";
  const previous = sideChats
    .filter((chat) => chat.title.startsWith(prefix) && chat.createdAt <= cutoff)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    title: prefix + cutoff,
    prompt: [
      `Summarize progress on parent thread ${threadId} as of ${cutoff}. This is a retrospective. Leave the work and running agents alone.`,
      "Use t3_thread_list with includeSubagents and pagination to identify descendants by parentThreadId. Exclude side chats (including this summary) from the agent results. Read the parent and each agent descendant with t3_thread_read. Follow native subagent activity and delegated thread references, including linked environments. Use only evidence available by the cutoff. Flag missing history and partial results.",
      "Lead with the best confirmed result and its baseline, metric, units and test conditions. Give each agent a concise line on what it tried, what happened and how that shaped the search. Cite thread links and relevant runs, evaluations or recordings. Identify remaining uncertainty. When measurements are incomparable, report them separately.",
      previous &&
        `Read the previous snapshot in thread ${previous.id}. Lead with what changed since that snapshot.`,
      "When comparable measurements exist, graph them in run or time order, with axes, units, baseline and source labels. Use the user-facing HTML bridge: html_preview then html_render. For sparse or qualitative evidence, use a concise table or text. If enough evidence supports a projection, distinguish the forecast visually from observations, give its horizon, assumptions and uncertainty, and explain why the trend might change. Never fabricate measurements or confidence intervals.",
      focus && `User focus: ${focus}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
