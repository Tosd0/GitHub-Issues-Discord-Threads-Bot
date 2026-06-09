import tagMappingConfig from "./tagMapping.config.json";

export type ClosedReason = "completed" | "not_planned" | "duplicate";

export const CLOSED_REASONS: readonly ClosedReason[] = [
  "completed",
  "not_planned",
  "duplicate",
];

type LabelMapping = {
  github: string;
  discord: string;
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
  closedState: Record<ClosedReason, string>;
  /** Extra GitHub label applied while a post is closed for a given reason and
   *  removed again on reopen. GitHub's REST API only records "completed" or
   *  "not_planned" as a close reason, so a reason like "duplicate" is mirrored
   *  to GitHub through this label instead. */
  closedStateGithubLabels?: Partial<Record<ClosedReason, string>>;
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
  labels: rawTagMapping.labels ?? [],
  tagGroups: rawTagMapping.tagGroups ?? [],
} satisfies Required<TagMappingConfig>;

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
 * Discord tag names belonging to any group flagged `clearOnClose` — these are
 * removed from a post (and their GitHub labels) whenever it is closed.
 */
export function getClearOnCloseDiscordTagNames(): string[] {
  return tagMapping.tagGroups
    .filter((group) => group.clearOnClose)
    .flatMap((group) => group.tags)
    .filter((name) => name.length > 0);
}
