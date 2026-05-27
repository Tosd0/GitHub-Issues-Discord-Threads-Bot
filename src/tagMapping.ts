import tagMappingConfig from "./tagMapping.config.json";

export type ClosedReason = "completed" | "not_planned";

type LabelMapping = {
  github: string;
  discord: string;
};

type TagMappingConfig = {
  closedState: Record<ClosedReason, string>;
  labels?: LabelMapping[];
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
  labels: rawTagMapping.labels ?? [],
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
