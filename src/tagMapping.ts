import tagMappingConfig from "./tagMapping.config.json";

/**
 * A closed-state reason. "completed" and "not_planned" are GitHub's only native
 * close reasons; any other reason (e.g. "duplicate") is recorded on GitHub as
 * "not_planned" and distinguished by a mirror label (see closedStateGithubLabels).
 *
 * Reasons are data-driven: add one by editing tagMapping.config.json, no code
 * change required. The two names above are reserved — naming a custom reason
 * "completed" or "not_planned" collides with the native mapping.
 */
export type ClosedReason = string;

type LabelMapping = {
  github: string;
  discord: string;
};

/**
 * An optional "which post does this one point at" argument for a close command.
 * Configuring it adds a slash command option taking a Discord post link (or a
 * bare post id); when the admin fills it in, the bot posts `message` in the
 * forum post and, if `githubMessage` is set and both posts are linked to
 * issues, leaves that note on the GitHub issue as well.
 */
type ClosedReasonReference = {
  /** Slash command option name, e.g. "post". */
  option: string;
  /** Option description shown in Discord. */
  optionDescription: string;
  /** Notice posted in the forum post. `{link}` becomes a link to the post. */
  message: string;
  /** Comment left on the GitHub issue. `{number}` becomes the referenced
   *  post's issue number. Omit to skip the GitHub comment. */
  githubMessage?: string;
};

export type ClosedReasonCommand = {
  /** Discord slash command name (without the leading slash). */
  command: string;
  /** Slash command description shown in Discord. */
  description: string;
  /** Human phrase used in the bot's confirmation reply, e.g. "a duplicate". */
  label: string;
  /** Lock the forum post after closing it with this reason. Discord's lock
   *  state is mirrored to GitHub, so the issue ends up locked too. */
  lockOnClose?: boolean;
  /** See ClosedReasonReference. */
  reference?: ClosedReasonReference;
};

type TagGroup = {
  name: string;
  /** When true, every tag in this group is stripped from the post (and its
   *  mirrored GitHub label removed) whenever the post is closed. */
  clearOnClose?: boolean;
  /** Discord forum tag names that belong to this group. */
  tags: string[];
};

type TagMappingConfig = {
  closedState: Record<string, string>;
  /** Extra GitHub label applied while a post is closed for a given reason and
   *  removed again on reopen. GitHub's REST API only records "completed" or
   *  "not_planned" as a close reason, so a reason like "duplicate" is mirrored
   *  to GitHub through this label instead. */
  closedStateGithubLabels?: Record<string, string>;
  /** Per-reason Discord slash command metadata (command name, description, and
   *  the phrase used in the confirmation reply). */
  closedStateCommands: Record<string, ClosedReasonCommand>;
  labels?: LabelMapping[];
  tagGroups?: TagGroup[];
};

const rawTagMapping = tagMappingConfig as TagMappingConfig;

/**
 * Mapping between GitHub issue states/labels and Discord forum tags.
 *
 * Edit tagMapping.config.json to change values. Do not use .env for this;
 * tag mappings are regular app configuration, not secrets.
 */
export const tagMapping = {
  closedState: rawTagMapping.closedState,
  closedStateGithubLabels: rawTagMapping.closedStateGithubLabels ?? {},
  closedStateCommands: rawTagMapping.closedStateCommands,
  labels: rawTagMapping.labels ?? [],
  tagGroups: rawTagMapping.tagGroups ?? [],
} satisfies Required<TagMappingConfig>;

/** All configured closed-state reasons, derived from the config. */
export const CLOSED_REASONS: readonly ClosedReason[] = Object.keys(
  tagMapping.closedState,
);

export function isClosedStateDiscordTagName(tagName: string) {
  return Object.values(tagMapping.closedState).includes(tagName);
}

export function getDiscordTagNameForGithubLabel(labelName: string) {
  const mapping = tagMapping.labels.find((item) => item.github === labelName);
  return mapping?.discord ?? labelName;
}

export function getGithubLabelNameForDiscordTag(tagName: string) {
  if (isClosedStateDiscordTagName(tagName)) return undefined;

  const mapping = tagMapping.labels.find((item) => item.discord === tagName);
  return mapping?.github ?? tagName;
}

/**
 * GitHub only accepts "completed" or "not_planned" as a `state_reason`. Any
 * other close reason (e.g. "duplicate") is closed as "not_planned" on GitHub
 * and distinguished there by an extra label (see closedStateGithubLabels).
 */
export function getGithubStateReason(
  reason: ClosedReason,
): "completed" | "not_planned" {
  return reason === "completed" ? "completed" : "not_planned";
}

export function getClosedStateGithubLabel(
  reason: ClosedReason,
): string | undefined {
  return tagMapping.closedStateGithubLabels[reason];
}

export function getAllClosedStateGithubLabels(): string[] {
  return Object.values(tagMapping.closedStateGithubLabels).filter(
    (label): label is string => Boolean(label),
  );
}

/**
 * The closed-state reason whose mirror label is present among the given GitHub
 * labels, if any. Used on a GitHub-side "not_planned" close to recover a custom
 * reason (e.g. "duplicate") that GitHub can't record natively.
 */
export function getClosedReasonFromGithubLabels(
  labelNames: string[],
): ClosedReason | undefined {
  return CLOSED_REASONS.find((reason) => {
    const label = getClosedStateGithubLabel(reason);
    return label !== undefined && labelNames.includes(label);
  });
}

/** Per-reason Discord slash command metadata, derived from the config. */
export function getClosedReasonCommands(): (ClosedReasonCommand & {
  reason: ClosedReason;
})[] {
  return CLOSED_REASONS.flatMap((reason) => {
    const meta = tagMapping.closedStateCommands[reason];
    return meta ? [{ reason, ...meta }] : [];
  });
}

/** The closed-state reason a given Discord slash command name closes with. */
export function getClosedReasonByCommandName(
  commandName: string,
): ClosedReason | undefined {
  return getClosedReasonCommands().find((c) => c.command === commandName)
    ?.reason;
}

/** The confirmation-reply phrase for a reason, e.g. "a duplicate". */
export function getClosedReasonLabel(reason: ClosedReason): string {
  return tagMapping.closedStateCommands[reason]?.label ?? reason;
}

/** The "points at another post" argument for a reason, if it has one. */
export function getClosedReasonReference(reason: ClosedReason) {
  return tagMapping.closedStateCommands[reason]?.reference;
}

/** Whether closing with this reason also locks the forum post. */
export function locksOnClose(reason: ClosedReason): boolean {
  return tagMapping.closedStateCommands[reason]?.lockOnClose === true;
}

/**
 * Discord tag names belonging to any group flagged `clearOnClose` — these are
 * removed from a post (and their GitHub labels) whenever it is closed.
 */
export function getClearOnCloseDiscordTagNames(): string[] {
  return tagMapping.tagGroups
    .filter((group) => group.clearOnClose)
    .flatMap((group) => group.tags)
    .filter((name) => name.length > 0);
}
