import {
  AnyThreadChannel,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  DMChannel,
  ForumChannel,
  Interaction,
  Message,
  MessageContextMenuCommandInteraction,
  NonThreadGuildBasedChannel,
  PartialMessage,
  PermissionFlagsBits,
  ThreadChannel,
} from "discord.js";
import { config } from "../config";
import {
  getClosedStateTagIds,
  isDiscordToGithubSyncSuppressed,
} from "./discordActions";
import {
  addLabelsToIssue,
  closeIssue,
  createIssue,
  createIssueComment,
  deleteComment,
  deleteIssue,
  getIssues,
  linkIssue,
  listRepoLabels,
  lockIssue,
  openIssue,
  unlinkIssue,
  unlockIssue,
} from "../github/githubActions";
import { logger } from "../logger";
import { store } from "../store";
import { ClosedReason } from "../tagMapping";
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

  const guildIds = new Set<string>();
  for (const channelId of config.DISCORD_CHANNEL_IDS) {
    const forumChannel = (await client.channels
      .fetch(channelId)
      .catch(() => null)) as ForumChannel | null;
    if (!forumChannel) {
      logger.error(`Could not fetch forum channel ${channelId}`);
      continue;
    }
    store.setChannelTags(channelId, forumChannel.availableTags);
    guildIds.add(forumChannel.guild.id);
  }

  for (const guildId of guildIds) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    try {
      await guild.commands.set([
        {
          name: "create-issue",
          description:
            "Create a GitHub issue from this forum post. (Admin only)",
          type: ApplicationCommandType.ChatInput,
          dmPermission: false,
        },
        {
          name: "subscribe-issue",
          description:
            "Subscribe to status updates (close/reopen) for this issue.",
          type: ApplicationCommandType.ChatInput,
          dmPermission: false,
        },
        {
          name: "add-tag",
          description:
            "Add labels to this issue, creating them if missing. (Admin only)",
          type: ApplicationCommandType.ChatInput,
          dmPermission: false,
          options: [
            {
              name: "tags",
              description: "Comma-separated tag names to add.",
              type: ApplicationCommandOptionType.String,
              required: true,
              autocomplete: true,
            },
          ],
        },
        {
          name: "Sync to Issue",
          type: ApplicationCommandType.Message,
          dmPermission: false,
        },
        {
          name: "link-issue",
          description:
            "Link an existing GitHub issue to this forum post. (Admin only)",
          type: ApplicationCommandType.ChatInput,
          dmPermission: false,
          options: [
            {
              name: "number",
              description: "GitHub issue number to link.",
              type: ApplicationCommandOptionType.Integer,
              required: true,
              minValue: 1,
            },
          ],
        },
        {
          name: "unlink-issue",
          description:
            "Detach the GitHub issue from this forum post without deleting either side. (Admin only)",
          type: ApplicationCommandType.ChatInput,
          dmPermission: false,
        },
      ]);
      logger.info(`Slash commands registered in guild ${guild.name}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      logger.error(
        `Failed to register slash command in guild ${guild.name}: ${msg}`,
      );
    }
  }
}

export async function handleThreadCreate(params: AnyThreadChannel) {
  if (!params.parentId || !config.DISCORD_CHANNEL_IDS.includes(params.parentId))
    return;

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
  if (!config.DISCORD_CHANNEL_IDS.includes(params.id)) return;

  if (params.type === 15) {
    store.setChannelTags(params.id, params.availableTags);
  }
}

function syncAppliedTagsToGithub(
  thread: Thread,
  params: AnyThreadChannel,
  suppressGithubSync: boolean,
) {
  if (!thread.number) return;

  const prev = thread.appliedTags;
  const next = params.appliedTags;

  if (prev.length === next.length) {
    const prevSet = new Set(prev);
    if (next.every((t) => prevSet.has(t))) return;
  }

  const forum = params.parent;
  const closedIds =
    forum instanceof ForumChannel
      ? getClosedStateTagIds(forum)
      : { completed: undefined, not_planned: undefined };
  const prevSet = new Set(prev);
  const nextSet = new Set(next);

  const reasonFor = (tagId: string | undefined): ClosedReason | null => {
    if (!tagId) return null;
    if (tagId === closedIds.completed) return "completed";
    if (tagId === closedIds.not_planned) return "not_planned";
    return null;
  };

  let addedReason: ClosedReason | null = null;
  for (const tagId of next) {
    if (prevSet.has(tagId)) continue;
    addedReason = reasonFor(tagId);
    if (addedReason) break;
  }

  let removedClosedTag = false;
  for (const tagId of prev) {
    if (nextSet.has(tagId)) continue;
    if (reasonFor(tagId)) {
      removedClosedTag = true;
      break;
    }
  }

  // Sync in-memory tags BEFORE the GitHub call so the resulting
  // GitHub→Discord round trip recognizes the state and skips re-applying.
  thread.appliedTags = next;

  if (suppressGithubSync) return;

  if (addedReason) {
    closeIssue(thread, addedReason);
  } else if (removedClosedTag && thread.archived) {
    openIssue(thread);
  }
}

export async function handleThreadUpdate(params: AnyThreadChannel) {
  if (!params.parentId || !config.DISCORD_CHANNEL_IDS.includes(params.parentId))
    return;

  const { id, archived, locked } = params.members.thread;
  const thread = store.threads.find((item) => item.id === id);
  if (!thread) return;
  const suppressGithubSync = isDiscordToGithubSyncSuppressed(thread);

  // Only state tags (per tagMapping.closedState) drive issue state.
  // Other tag changes are tracked in memory but never pushed to GitHub labels.
  syncAppliedTagsToGithub(thread, params, suppressGithubSync);

  if (thread.locked !== locked && !thread.lockLocking) {
    if (suppressGithubSync) {
      thread.locked = locked;
    } else {
      if (thread.archived) {
        thread.lockArchiving = true;
      }
      thread.locked = locked;
      locked ? lockIssue(thread) : unlockIssue(thread);
    }
  }
  if (thread.archived !== archived) {
    if (suppressGithubSync) {
      thread.archived = archived;
      return;
    }

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
  if (!config.AUTO_SYNC_COMMENTS) return;

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
  if (!params.parentId || !config.DISCORD_CHANNEL_IDS.includes(params.parentId))
    return;

  const thread = store.threads.find((item) => item.id === params.id);
  if (!thread) return;

  deleteIssue(thread);
}

function issueUrl(number: number) {
  return `https://github.com/${config.GITHUB_USERNAME}/${config.GITHUB_REPOSITORY}/issues/${number}`;
}

export async function handleInteractionCreate(interaction: Interaction) {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === "add-tag") {
      await handleAddTagAutocomplete(interaction);
    }
    return;
  }

  if (interaction.isMessageContextMenuCommand()) {
    if (interaction.commandName === "Sync to Issue") {
      return handleSyncToIssueCommand(interaction);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case "create-issue":
      return handleCreateIssueCommand(interaction);
    case "subscribe-issue":
      return handleSubscribeIssueCommand(interaction);
    case "add-tag":
      return handleAddTagCommand(interaction);
    case "link-issue":
      return handleLinkIssueCommand(interaction);
    case "unlink-issue":
      return handleUnlinkIssueCommand(interaction);
  }
}

async function handleAddTagAutocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused();
  const tokens = focused.split(",");
  const current = (tokens[tokens.length - 1] ?? "").trim().toLowerCase();
  const prefix = tokens.slice(0, -1).map((token) => token.trim());
  const alreadyChosen = new Set(
    prefix
      .filter((token) => token.length > 0)
      .map((token) => token.toLowerCase()),
  );

  const labels = await listRepoLabels();
  const choices = labels
    .filter(
      (label) =>
        label.toLowerCase().includes(current) &&
        !alreadyChosen.has(label.toLowerCase()),
    )
    .map((label) =>
      prefix.length > 0 ? `${prefix.join(", ")}, ${label}` : label,
    )
    .filter((value) => value.length <= 100)
    .slice(0, 25)
    .map((value) => ({ name: value, value }));

  await interaction.respond(choices).catch(() => undefined);
}

function memberIsAdmin(
  interaction:
    | ChatInputCommandInteraction
    | MessageContextMenuCommandInteraction,
): boolean {
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
  return hasAdminPerm || hasAllowedRole;
}

async function ensureForumThread(
  interaction:
    | ChatInputCommandInteraction
    | MessageContextMenuCommandInteraction,
): Promise<ThreadChannel | null> {
  const channel = interaction.channel;
  if (
    !channel ||
    !channel.isThread() ||
    !channel.parentId ||
    !config.DISCORD_CHANNEL_IDS.includes(channel.parentId)
  ) {
    await interaction.reply({
      content: "This command must be used inside a forum post.",
      ephemeral: true,
    });
    return null;
  }
  return channel as ThreadChannel;
}

async function handleCreateIssueCommand(
  interaction: ChatInputCommandInteraction,
) {
  try {
    if (!memberIsAdmin(interaction)) {
      await interaction.reply({
        content: "You don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    const channel = await ensureForumThread(interaction);
    if (!channel) return;

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
      starter.react("👀").catch(() => undefined);
      const url = issueUrl(thread.number);
      await interaction.editReply({
        content: `Issue created by <@${interaction.user.id}>: ${url}`,
      });
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

async function handleSubscribeIssueCommand(
  interaction: ChatInputCommandInteraction,
) {
  const channel = await ensureForumThread(interaction);
  if (!channel) return;

  const thread = store.threads.find((t) => t.id === channel.id);
  if (!thread || !thread.number) {
    await interaction.reply({
      content: "This post is not linked to a GitHub issue yet.",
      ephemeral: true,
    });
    return;
  }

  if (!thread.subscribers) thread.subscribers = [];
  const userId = interaction.user.id;
  const index = thread.subscribers.indexOf(userId);

  if (index === -1) {
    thread.subscribers.push(userId);
    await interaction.reply({
      content: `Subscribed to issue #${thread.number}. You'll get a DM when it is closed or reopened.`,
      ephemeral: true,
    });
  } else {
    thread.subscribers.splice(index, 1);
    await interaction.reply({
      content: `Unsubscribed from issue #${thread.number}.`,
      ephemeral: true,
    });
  }
}

async function handleAddTagCommand(interaction: ChatInputCommandInteraction) {
  if (!memberIsAdmin(interaction)) {
    await interaction.reply({
      content: "You don't have permission to use this command.",
      ephemeral: true,
    });
    return;
  }

  const channel = await ensureForumThread(interaction);
  if (!channel) return;

  const thread = store.threads.find((t) => t.id === channel.id);
  if (!thread || !thread.number) {
    await interaction.reply({
      content: "This post is not linked to a GitHub issue yet.",
      ephemeral: true,
    });
    return;
  }

  const labels = interaction.options
    .getString("tags", true)
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

  if (labels.length === 0) {
    await interaction.reply({
      content: "Please provide at least one tag.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const success = await addLabelsToIssue(thread, labels);
  if (success) {
    await interaction.editReply({
      content: `Tag(s) added to issue [#${thread.number}](<${issueUrl(thread.number)}>) by <@${interaction.user.id}>: ${labels.join(", ")}`,
    });
  } else {
    await interaction.editReply({
      content: "Failed to add tags. Please check the logs.",
    });
  }
}

async function handleLinkIssueCommand(
  interaction: ChatInputCommandInteraction,
) {
  try {
    if (!memberIsAdmin(interaction)) {
      await interaction.reply({
        content: "You don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    const channel = await ensureForumThread(interaction);
    if (!channel) return;

    const issueNumber = interaction.options.getInteger("number", true);

    let thread = store.threads.find((t) => t.id === channel.id);
    if (thread?.number) {
      await interaction.reply({
        content: `This post is already linked to an issue: ${issueUrl(thread.number)}`,
        ephemeral: true,
      });
      return;
    }

    const conflict = store.threads.find(
      (t) => t.number === issueNumber && t.id !== channel.id,
    );
    if (conflict) {
      await interaction.reply({
        content: `Issue #${issueNumber} is already linked to another Discord post.`,
        ephemeral: true,
      });
      return;
    }

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

    await interaction.deferReply();

    const starter = await channel.fetchStarterMessage().catch(() => null);
    if (!starter) {
      await interaction.editReply({
        content: "Could not read the starter message of this post.",
      });
      return;
    }

    const result = await linkIssue(thread, issueNumber, starter);
    if (!result.ok) {
      await interaction.editReply({ content: result.reason });
      return;
    }

    starter.react("👀").catch(() => undefined);
    await interaction.editReply({
      content: `Linked to issue [#${thread.number}](<${issueUrl(thread.number!)}>) by <@${interaction.user.id}>.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    logger.error(`/link-issue handler failed: ${msg}`);
    const fallback = "Something went wrong while running /link-issue.";
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

async function handleUnlinkIssueCommand(
  interaction: ChatInputCommandInteraction,
) {
  try {
    if (!memberIsAdmin(interaction)) {
      await interaction.reply({
        content: "You don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    const channel = await ensureForumThread(interaction);
    if (!channel) return;

    const thread = store.threads.find((t) => t.id === channel.id);
    if (!thread || !thread.number) {
      await interaction.reply({
        content: "This post is not linked to a GitHub issue.",
        ephemeral: true,
      });
      return;
    }

    const issueNumber = thread.number;
    await interaction.deferReply();

    const result = await unlinkIssue(thread);
    if (!result.ok) {
      await interaction.editReply({ content: result.reason });
      return;
    }

    await interaction.editReply({
      content: `Unlinked issue [#${issueNumber}](<${issueUrl(issueNumber)}>) from this post by <@${interaction.user.id}>. The issue and this post both remain; deleting/closing this post will no longer affect the issue.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    logger.error(`/unlink-issue handler failed: ${msg}`);
    const fallback = "Something went wrong while running /unlink-issue.";
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

async function handleSyncToIssueCommand(
  interaction: MessageContextMenuCommandInteraction,
) {
  if (!memberIsAdmin(interaction)) {
    await interaction.reply({
      content: "You don't have permission to use this command.",
      ephemeral: true,
    });
    return;
  }

  const channel = await ensureForumThread(interaction);
  if (!channel) return;

  const thread = store.threads.find((t) => t.id === channel.id);
  if (!thread || !thread.number) {
    await interaction.reply({
      content: "This post is not linked to a GitHub issue yet.",
      ephemeral: true,
    });
    return;
  }

  const target = interaction.targetMessage;

  if (target.author.bot) {
    await interaction.reply({
      content: "Cannot sync bot messages.",
      ephemeral: true,
    });
    return;
  }

  if (thread.comments.some((c) => c.id === target.id)) {
    await interaction.reply({
      content: `This message is already synced to issue [#${thread.number}](<${issueUrl(thread.number)}>).`,
      ephemeral: true,
    });
    return;
  }

  if (!target.content && target.attachments.size === 0) {
    await interaction.reply({
      content: "Cannot sync an empty message.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const before = thread.comments.length;
  await createIssueComment(thread, target);

  if (thread.comments.length > before) {
    await interaction.editReply({
      content: `Message synced to issue [#${thread.number}](<${issueUrl(thread.number)}>).`,
    });
  } else {
    await interaction.editReply({
      content: "Failed to sync the message. Please check the logs.",
    });
  }
}
