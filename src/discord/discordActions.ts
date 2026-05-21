import { MessagePayload, ThreadChannel } from "discord.js";
import { Thread } from "../interfaces";
import {
  ActionValue,
  Actions,
  Triggerer,
  getDiscordUrl,
  logger,
} from "../logger";
import { store } from "../store";
import client from "./discord";

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

  thread.archived = true;
  channel.setArchived(true);
}

export async function unarchiveThread(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel || !channel.archived) return;

  info(Actions.Reopened, thread);

  thread.archived = false;
  channel.setArchived(false);
}

export async function lockThread(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel || channel.locked) return;

  info(Actions.Locked, thread);

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
