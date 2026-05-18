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
  NonThreadGuildBasedChannel,
  PartialMessage,
  PermissionFlagsBits,
  ThreadChannel,
} from "discord.js";
import { config } from "../config";
import {
  addLabelsToIssue,
  closeIssue,
  createIssue,
  createIssueComment,
  deleteComment,
  deleteIssue,
  getIssues,
  listRepoLabels,
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
  if (
    !params.parentId ||
    !config.DISCORD_CHANNEL_IDS.includes(params.parentId)
  )
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

export async function handleThreadUpdate(params: AnyThreadChannel) {
  if (
    !params.parentId ||
    !config.DISCORD_CHANNEL_IDS.includes(params.parentId)
  )
    return;

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
  if (
    !params.parentId ||
    !config.DISCORD_CHANNEL_IDS.includes(params.parentId)
  )
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

  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case "create-issue":
      return handleCreateIssueCommand(interaction);
    case "subscribe-issue":
      return handleSubscribeIssueCommand(interaction);
    case "add-tag":
      return handleAddTagCommand(interaction);
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

function memberIsAdmin(interaction: ChatInputCommandInteraction): boolean {
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
      starter.react("👀").catch(() => undefined);
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

async function handleSubscribeIssueCommand(
  interaction: ChatInputCommandInteraction,
) {
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
    return;
  }

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
    return;
  }

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

  await interaction.deferReply({ ephemeral: true });

  const success = await addLabelsToIssue(thread, labels);
  if (success) {
    await interaction.editReply({
      content: `Added tag(s) to issue #${thread.number}: ${labels.join(", ")}`,
    });
  } else {
    await interaction.editReply({
      content: "Failed to add tags. Please check the logs.",
    });
  }
}
