import {
  AnyThreadChannel,
  ApplicationCommandType,
  Client,
  DMChannel,
  ForumChannel,
  Interaction,
  Message,
  NonThreadGuildBasedChannel,
  PartialMessage,
  PermissionFlagsBits,
  ThreadChannel,
} from "discord.js";
import { config } from "../config";
import {
  closeIssue,
  createIssue,
  createIssueComment,
  deleteComment,
  deleteIssue,
  getIssues,
  lockIssue,
  openIssue,
  unlockIssue,
} from "../github/githubActions";
import { logger } from "../logger";
import { store } from "../store";
import { Thread } from "../interfaces";

export async function handleClientReady(client: Client) {
  logger.info(`Logged in as ${client.user?.tag}!`);

  store.threads = await getIssues();

  // Fetch cache for closed threads
  const threadPromises = store.threads.map(async (thread) => {
    const cachedChannel = client.channels.cache.get(thread.id) as
      | ThreadChannel
      | undefined;
    if (cachedChannel) {
      cachedChannel.messages.cache.forEach((message) => message.id);
      return thread; // Returning thread as valid
    } else {
      try {
        const channel = (await client.channels.fetch(
          thread.id,
        )) as ThreadChannel;
        channel.messages.cache.forEach((message) => message.id);
        return thread; // Returning thread as valid
      } catch (error) {
        return; // Marking thread as invalid
      }
    }
  });
  const threadPromisesResults = await Promise.all(threadPromises);
  store.threads = threadPromisesResults.filter(
    (thread) => thread !== undefined,
  ) as Thread[];

  logger.info(`Issues loaded : ${store.threads.length}`);

  const forumChannel = (await client.channels.fetch(
    config.DISCORD_CHANNEL_ID,
  )) as ForumChannel | null;
  if (forumChannel) {
    store.availableTags = forumChannel.availableTags;

    try {
      await forumChannel.guild.commands.set([
        {
          name: "create-issue",
          description: "Create a GitHub issue from this forum post.",
          type: ApplicationCommandType.ChatInput,
          dmPermission: false,
        },
      ]);
      logger.info("Slash command /create-issue registered.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      logger.error(`Failed to register slash command: ${msg}`);
    }
  }
}

export async function handleThreadCreate(params: AnyThreadChannel) {
  if (params.parentId !== config.DISCORD_CHANNEL_ID) return;

  const { id, name, appliedTags } = params;

  store.threads.push({
    id,
    appliedTags,
    title: name,
    archived: false,
    locked: false,
    comments: [],
  });
}

export async function handleChannelUpdate(
  params: DMChannel | NonThreadGuildBasedChannel,
) {
  if (params.id !== config.DISCORD_CHANNEL_ID) return;

  if (params.type === 15) {
    store.availableTags = params.availableTags;
  }
}

export async function handleThreadUpdate(params: AnyThreadChannel) {
  if (params.parentId !== config.DISCORD_CHANNEL_ID) return;

  const { id, archived, locked } = params.members.thread;
  const thread = store.threads.find((item) => item.id === id);
  if (!thread) return;

  if (thread.locked !== locked && !thread.lockLocking) {
    if (thread.archived) {
      thread.lockArchiving = true;
    }
    thread.locked = locked;
    locked ? lockIssue(thread) : unlockIssue(thread);
  }
  if (thread.archived !== archived) {
    setTimeout(() => {
      // timeout for fixing discord archived post locking
      if (thread.lockArchiving) {
        if (archived) {
          thread.lockArchiving = false;
        }
        thread.lockLocking = false;
        return;
      }
      thread.archived = archived;
      archived ? closeIssue(thread) : openIssue(thread);
    }, 500);
  }
}

export async function handleMessageCreate(params: Message) {
  const { channelId, author } = params;

  if (author.bot) return;

  const thread = store.threads.find((thread) => thread.id === channelId);

  if (!thread) return;
  if (!thread.number) return;

  createIssueComment(thread, params);
}

export async function handleMessageDelete(params: Message | PartialMessage) {
  const { channelId, id } = params;
  const thread = store.threads.find((i) => i.id === channelId);
  if (!thread) return;

  const commentIndex = thread.comments.findIndex((i) => i.id === id);
  if (commentIndex === -1) return;

  const comment = thread.comments.splice(commentIndex, 1)[0];
  deleteComment(thread, comment.git_id);
}

export async function handleThreadDelete(params: AnyThreadChannel) {
  if (params.parentId !== config.DISCORD_CHANNEL_ID) return;

  const thread = store.threads.find((item) => item.id === params.id);
  if (!thread) return;

  deleteIssue(thread);
}

function issueUrl(number: number) {
  return `https://github.com/${config.GITHUB_USERNAME}/${config.GITHUB_REPOSITORY}/issues/${number}`;
}

export async function handleInteractionCreate(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "create-issue") return;

  try {
    const hasAdminPerm =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ??
      false;
    const allowedRoleIds = config.DISCORD_ADMIN_ROLE_IDS;
    const hasAllowedRole =
      interaction.inCachedGuild() && allowedRoleIds.length > 0
        ? allowedRoleIds.some((roleId) =>
            interaction.member.roles.cache.has(roleId),
          )
        : false;

    if (!hasAdminPerm && !hasAllowedRole) {
      await interaction.reply({
        content: "You don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    const channel = interaction.channel;
    if (
      !channel ||
      !channel.isThread() ||
      channel.parentId !== config.DISCORD_CHANNEL_ID
    ) {
      await interaction.reply({
        content: "This command must be used inside a forum post.",
        ephemeral: true,
      });
      return;
    }

    let thread = store.threads.find((t) => t.id === channel.id);
    if (!thread) {
      thread = {
        id: channel.id,
        title: channel.name,
        appliedTags: channel.appliedTags,
        archived: false,
        locked: false,
        comments: [],
      };
      store.threads.push(thread);
    }

    if (thread.number) {
      await interaction.reply({
        content: `This post is already linked to an issue: ${issueUrl(thread.number)}`,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    const starter = await channel.fetchStarterMessage().catch(() => null);
    if (!starter) {
      await interaction.editReply({
        content: "Could not read the starter message of this post.",
      });
      return;
    }

    thread.title = channel.name;
    thread.appliedTags = channel.appliedTags;

    await createIssue(thread, starter);

    if (thread.number) {
      const url = issueUrl(thread.number);
      await interaction.editReply({ content: `Issue created: ${url}` });
    } else {
      await interaction.editReply({
        content: "Failed to create the issue. Please check the logs.",
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    logger.error(`/create-issue handler failed: ${msg}`);
    const fallback = "Something went wrong while running /create-issue.";
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: fallback });
      } else {
        await interaction.reply({ content: fallback, ephemeral: true });
      }
    } catch {
      /* interaction may already be expired */
    }
  }
}
