import { ForumChannel, MessagePayload, ThreadChannel } from "discord.js";
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
import { areTagSetsEqual } from "../utils/tagSets";
import client from "./discord";

type PendingDiscordSyncField = "appliedTags" | "archived" | "locked";

function clearPendingDiscordSyncField(
  thread: Thread,
  field: PendingDiscordSyncField,
) {
  if (!thread.pendingDiscordSync) return;

  delete thread.pendingDiscordSync[field];
  if (Object.keys(thread.pendingDiscordSync).length === 0) {
    thread.pendingDiscordSync = undefined;
  }
}

function setPendingDiscordSync(
  thread: Thread,
  pending: NonNullable<Thread["pendingDiscordSync"]>,
) {
  thread.pendingDiscordSync = {
    ...thread.pendingDiscordSync,
    ...pending,
  };
}

export function resolvePendingDiscordSync(
  thread: Thread,
  current: {
    appliedTags: string[];
    archived: boolean | null;
    locked: boolean | null;
  },
) {
  const pending = thread.pendingDiscordSync;
  const handled = {
    appliedTags: Boolean(pending?.appliedTags),
    archived: pending?.archived !== undefined,
    locked: pending?.locked !== undefined,
  };

  if (
    pending?.appliedTags &&
    areTagSetsEqual(current.appliedTags, pending.appliedTags)
  ) {
    thread.appliedTags = current.appliedTags;
    clearPendingDiscordSyncField(thread, "appliedTags");
  }

  if (pending?.archived === current.archived) {
    thread.archived = current.archived;
    clearPendingDiscordSyncField(thread, "archived");
  }

  if (pending?.locked === current.locked) {
    thread.locked = current.locked;
    clearPendingDiscordSyncField(thread, "locked");
  }

  return handled;
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

  setPendingDiscordSync(thread, { archived: true });
  try {
    await channel.setArchived(true);
    thread.archived = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    logger.error(`Failed to archive thread: ${msg}`);
  } finally {
    clearPendingDiscordSyncField(thread, "archived");
  }
}

export async function unarchiveThread(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel || !channel.archived) return;

  info(Actions.Reopened, thread);

  setPendingDiscordSync(thread, { archived: false });
  try {
    await channel.setArchived(false);
    thread.archived = false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    logger.error(`Failed to unarchive thread: ${msg}`);
  } finally {
    clearPendingDiscordSyncField(thread, "archived");
  }
}

export async function lockThread(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel || channel.locked) return;

  info(Actions.Locked, thread);

  setPendingDiscordSync(thread, { locked: true });
  const wasArchived = channel.archived;
  try {
    if (wasArchived) {
      setPendingDiscordSync(thread, { archived: false });
      await channel.setArchived(false);
      thread.archived = false;
    }

    await channel.setLocked(true);
    thread.locked = true;

    if (wasArchived) {
      setPendingDiscordSync(thread, { archived: true });
      await channel.setArchived(true);
      thread.archived = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    logger.error(`Failed to lock thread: ${msg}`);
  } finally {
    clearPendingDiscordSyncField(thread, "archived");
    clearPendingDiscordSyncField(thread, "locked");
  }
}

export async function unlockThread(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel || !channel.locked) return;

  info(Actions.Unlocked, thread);

  setPendingDiscordSync(thread, { locked: false });
  const wasArchived = channel.archived;
  try {
    if (wasArchived) {
      setPendingDiscordSync(thread, { archived: false });
      await channel.setArchived(false);
      thread.archived = false;
    }

    await channel.setLocked(false);
    thread.locked = false;

    if (wasArchived) {
      setPendingDiscordSync(thread, { archived: true });
      await channel.setArchived(true);
      thread.archived = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    logger.error(`Failed to unlock thread: ${msg}`);
  } finally {
    clearPendingDiscordSyncField(thread, "archived");
    clearPendingDiscordSyncField(thread, "locked");
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

export async function reactToThreadStarter(
  node_id: string | undefined,
  addEmoji: string,
  removeEmoji?: string,
) {
  const { channel } = await getThreadChannel(node_id);
  if (!channel) return;

  try {
    const starter = await channel.fetchStarterMessage();
    if (!starter) return;

    if (removeEmoji) {
      const reaction = starter.reactions.cache.get(removeEmoji);
      const selfId = client.user?.id;
      if (reaction && selfId) {
        await reaction.users.remove(selfId).catch(() => undefined);
      }
    }

    await starter.react(addEmoji);
  } catch (err) {
    /* starter message may be unavailable */
  }
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

  setPendingDiscordSync(thread, { appliedTags: next });
  try {
    await channel.setAppliedTags(next);
    thread.appliedTags = next;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    logger.error(`Failed to apply closed-state tag: ${msg}`);
  } finally {
    clearPendingDiscordSyncField(thread, "appliedTags");
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

  setPendingDiscordSync(thread, { appliedTags: next });
  try {
    await channel.setAppliedTags(next);
    thread.appliedTags = next;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    logger.error(`Failed to remove closed-state tag: ${msg}`);
  } finally {
    clearPendingDiscordSyncField(thread, "appliedTags");
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

  setPendingDiscordSync(thread, { appliedTags: next });
  try {
    await channel.setAppliedTags(next);
    thread.appliedTags = next;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    logger.error(
      `Failed to sync issue label "${labelName}" to Discord tag "${discordTagName}": ${msg}`,
    );
  } finally {
    clearPendingDiscordSyncField(thread, "appliedTags");
  }
}
