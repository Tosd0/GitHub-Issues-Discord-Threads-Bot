import { ForumChannel, MessagePayload, ThreadChannel } from "discord.js";
import { config } from "../config";
import { Thread } from "../interfaces";
import {
  ActionValue,
  Actions,
  Triggerer,
  getDiscordUrl,
  logger,
} from "../logger";
import { store } from "../store";
import {
  ClosedReason,
  getDiscordTagNameForGithubLabel,
  isClosedStateDiscordTagName,
  tagMapping,
} from "../tagMapping";
import client from "./discord";

const DISCORD_TO_GITHUB_SUPPRESSION_MS = 5_000;

function suppressDiscordToGithubSync(thread: Thread) {
  const until = Date.now() + DISCORD_TO_GITHUB_SUPPRESSION_MS;
  thread.discordToGithubSyncSuppressedUntil = Math.max(
    thread.discordToGithubSyncSuppressedUntil ?? 0,
    until,
  );
}

export function isDiscordToGithubSyncSuppressed(thread: Thread) {
  const until = thread.discordToGithubSyncSuppressedUntil;
  if (!until) return false;
  if (Date.now() <= until) return true;

  thread.discordToGithubSyncSuppressedUntil = undefined;
  return false;
}

export function getClosedStateTagIds(forum: ForumChannel): {
  completed?: string;
  not_planned?: string;
} {
  const find = (name: string) =>
    name ? forum.availableTags.find((t) => t.name === name)?.id : undefined;
  return {
    completed: find(tagMapping.closedState.completed),
    not_planned: find(tagMapping.closedState.not_planned),
  };
}

const info = (action: ActionValue, thread: Thread) =>
  logger.info(`${Triggerer.Github} | ${action} | ${getDiscordUrl(thread)}`);

const DISCORD_MESSAGE_MAX = 2000;
const TRUNCATED_SUFFIX = "\n\n_(truncated)_";

function buildInitialThreadContent(body: string, login: string): string {
  const description =
    body && body.trim().length > 0 ? body : "_(no description)_";
  const content = [
    "> Generated from GitHub",
    `**From (GitHub):** ${login}`,
    "---",
    description,
  ].join("\n\n");

  if (content.length <= DISCORD_MESSAGE_MAX) return content;
  return (
    content.slice(0, DISCORD_MESSAGE_MAX - TRUNCATED_SUFFIX.length) +
    TRUNCATED_SUFFIX
  );
}

export function createThread({
  body,
  login,
  title,
  appliedTags,
  node_id,
  number,
}: {
  body: string;
  login: string;
  title: string;
  appliedTags: string[];
  node_id: string;
  number: number;
}) {
  // Multi-channel routing not implemented; new issues always land in the first forum.
  const forum = client.channels.cache.get(
    config.DISCORD_CHANNEL_IDS[0],
  ) as ForumChannel;
  forum.threads
    .create({
      message: {
        content: buildInitialThreadContent(body, login),
      },
      name: title,
      appliedTags,
    })
    .then(({ id }) => {
      const thread = store.threads.find((thread) => thread.id === id);
      if (!thread) return;

      thread.body = body;
      thread.node_id = node_id;
      thread.number = number;

      info(Actions.Created, thread);
    });
}

export async function createComment({
  git_id,
  body,
  login,
  avatar_url,
  node_id,
}: {
  git_id: number;
  body: string;
  login: string;
  avatar_url: string;
  node_id: string;
}) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel) return;

  channel.parent
    ?.createWebhook({ name: login, avatar: avatar_url })
    .then((webhook) => {
      const messagePayload = MessagePayload.create(webhook, {
        content: body,
        threadId: thread.id,
      }).resolveBody();
      webhook
        .send(messagePayload)
        .then(({ id }) => {
          thread?.comments.push({ id, git_id });
          webhook.delete("Cleanup");

          info(Actions.Commented, thread);
        })
        .catch(console.error);
    })
    .catch(console.error);
}

export async function archiveThread(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel || channel.archived) return;

  info(Actions.Closed, thread);

  suppressDiscordToGithubSync(thread);
  thread.archived = true;
  channel.setArchived(true);
}

export async function unarchiveThread(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel || !channel.archived) return;

  info(Actions.Reopened, thread);

  suppressDiscordToGithubSync(thread);
  thread.archived = false;
  channel.setArchived(false);
}

export async function lockThread(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel || channel.locked) return;

  info(Actions.Locked, thread);

  suppressDiscordToGithubSync(thread);
  thread.locked = true;
  if (channel.archived) {
    thread.lockArchiving = true;
    thread.lockLocking = true;
    channel.setArchived(false);
    channel.setLocked(true);
    channel.setArchived(true);
  } else {
    channel.setLocked(true);
  }
}

export async function unlockThread(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel || !channel.locked) return;

  info(Actions.Unlocked, thread);

  suppressDiscordToGithubSync(thread);
  thread.locked = false;
  if (channel.archived) {
    thread.lockArchiving = true;
    thread.lockLocking = true;
    channel.setArchived(false);
    channel.setLocked(false);
    channel.setArchived(true);
  } else {
    channel.setLocked(false);
  }
}

export async function deleteThread(node_id: string | undefined) {
  const { channel, thread } = await getThreadChannel(node_id);
  if (!thread || !channel) return;

  info(Actions.Deleted, thread);

  store.deleteThread(thread?.id);
  channel.delete();
}

export async function getThreadChannel(node_id: string | undefined): Promise<{
  channel: ThreadChannel<boolean> | undefined;
  thread: Thread | undefined;
}> {
  let channel: ThreadChannel<boolean> | undefined;
  if (!node_id) return { thread: undefined, channel };

  const thread = store.threads.find((thread) => thread.node_id === node_id);
  if (!thread) return { thread, channel };

  channel = <ThreadChannel | undefined>client.channels.cache.get(thread.id);
  if (channel) return { thread, channel };

  try {
    const fetchChanel = await client.channels.fetch(thread.id);
    channel = <ThreadChannel | undefined>fetchChanel;
  } catch (err) {
    /* empty */
  }

  return { thread, channel };
}

export async function notifySubscribers(
  node_id: string | undefined,
  message: string,
) {
  if (!node_id) return;

  const thread = store.threads.find((t) => t.node_id === node_id);
  if (!thread?.subscribers?.length) return;

  await Promise.all(
    thread.subscribers.map(async (userId) => {
      try {
        const user = await client.users.fetch(userId);
        await user.send(message);
      } catch (err) {
        /* user may have DMs disabled or left the server */
      }
    }),
  );
}

export async function addClosedStateTag(
  node_id: string | undefined,
  reason: ClosedReason,
) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel) return;

  const forum = channel.parent;
  if (!(forum instanceof ForumChannel)) return;

  const ids = getClosedStateTagIds(forum);
  const targetId = ids[reason];
  if (!targetId) {
    const tagName = tagMapping.closedState[reason];
    logger.warn(
      `closed-state tag "${tagName}" not found on forum ${forum.name}`,
    );
    return;
  }
  if (channel.appliedTags.includes(targetId)) return;

  // Closed state is mutually exclusive on GitHub; mirror that on Discord.
  const otherId = reason === "completed" ? ids.not_planned : ids.completed;
  const next = [
    ...channel.appliedTags.filter((id) => id !== otherId),
    targetId,
  ];

  // Sync in-memory BEFORE the Discord call so the resulting ThreadUpdate
  // event won't be misread as a user-initiated change in handleThreadUpdate.
  suppressDiscordToGithubSync(thread);
  thread.appliedTags = next;
  try {
    await channel.setAppliedTags(next);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    logger.error(`Failed to apply closed-state tag: ${msg}`);
  }
}

export async function removeClosedStateTag(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel) return;

  const forum = channel.parent;
  if (!(forum instanceof ForumChannel)) return;

  const ids = getClosedStateTagIds(forum);
  const targetIds = [ids.completed, ids.not_planned].filter(
    (id): id is string => Boolean(id),
  );
  if (targetIds.length === 0) return;

  const next = channel.appliedTags.filter((id) => !targetIds.includes(id));
  if (next.length === channel.appliedTags.length) return;

  // See note in addClosedStateTag — suppress reverse-sync via ThreadUpdate.
  suppressDiscordToGithubSync(thread);
  thread.appliedTags = next;
  try {
    await channel.setAppliedTags(next);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    logger.error(`Failed to remove closed-state tag: ${msg}`);
  }
}

export async function syncIssueLabelTag(
  node_id: string | undefined,
  labelName: string | undefined,
  action: "add" | "remove",
) {
  if (!labelName) return;

  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel) return;

  const forum = channel.parent;
  if (!(forum instanceof ForumChannel)) return;

  const discordTagName = getDiscordTagNameForGithubLabel(labelName);
  if (isClosedStateDiscordTagName(discordTagName)) return;

  const tagId = forum.availableTags.find(
    (tag) => tag.name === discordTagName,
  )?.id;
  if (!tagId) return;

  const tagSet = new Set(channel.appliedTags);
  action === "add" ? tagSet.add(tagId) : tagSet.delete(tagId);

  const next = Array.from(tagSet);
  if (
    next.length === channel.appliedTags.length &&
    next.every((id) => channel.appliedTags.includes(id))
  ) {
    return;
  }

  suppressDiscordToGithubSync(thread);
  thread.appliedTags = next;
  try {
    await channel.setAppliedTags(next);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    logger.error(
      `Failed to sync issue label "${labelName}" to Discord tag "${discordTagName}": ${msg}`,
    );
  }
}
