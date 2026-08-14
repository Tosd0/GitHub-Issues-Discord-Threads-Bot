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
  getClearOnCloseTagIds,
  getClosedStateTagIds,
  removeGithubLabelsForTagIds,
  resolvePendingDiscordSync,
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
import {
  ClosedReason,
  getClosedReasonByCommandName,
  getClosedReasonCommands,
  getClosedReasonLabel,
} from "../tagMapping";
import { areTagSetsEqual } from "../utils/tagSets";
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
          // Message context menu rather than a slash command: the interaction
          // payload carries the post's text and attachments, so the bot needs
          // no MessageContent intent to build the issue body.
          name: "Create Issue",
          type: ApplicationCommandType.Message,
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
        // Close commands are config-driven (see closedStateCommands in
        // tagMapping.config.json); one slash command per closed-state reason.
        ...getClosedReasonCommands().map((c) => ({
          name: c.command,
          description: c.description,
          type: ApplicationCommandType.ChatInput,
          dmPermission: false,
        })),
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

async function fetchLatestThreadChannel(params: AnyThreadChannel) {
  try {
    return await params.fetch();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    logger.warn(
      `Skipping Discord→GitHub sync for thread ${params.id}; failed to fetch latest thread state: ${msg}`,
    );
    return undefined;
  }
}

async function syncAppliedTagsToGithub(
  thread: Thread,
  params: AnyThreadChannel,
) {
  const prev = thread.appliedTags;
  const next = params.appliedTags;

  if (areTagSetsEqual(prev, next)) return;

  const forum = params.parent;
  const closedIds =
    forum instanceof ForumChannel
      ? getClosedStateTagIds(forum)
      : ({} as Record<ClosedReason, string | undefined>);
  const prevSet = new Set(prev);
  const nextSet = new Set(next);

  const reasonFor = (tagId: string | undefined): ClosedReason | null => {
    if (!tagId) return null;
    for (const [reason, id] of Object.entries(closedIds)) {
      if (id && id === tagId) return reason as ClosedReason;
    }
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

  if (!thread.number) return;

  if (addedReason) {
    await closeIssue(thread, addedReason);
  } else if (removedClosedTag) {
    // Removing the closed-state tag is the one and only way to reopen from
    // Discord. We no longer gate this on the thread being archived, since
    // closing an issue no longer archives the thread.
    await openIssue(thread);
  }
}

export async function handleThreadUpdate(params: AnyThreadChannel) {
  if (!params.parentId || !config.DISCORD_CHANNEL_IDS.includes(params.parentId))
    return;

  const latest = await fetchLatestThreadChannel(params);
  if (!latest) return;

  const { id, archived, locked } = latest.members.thread;
  const thread = store.threads.find((item) => item.id === id);
  if (!thread) return;
  const pending = resolvePendingDiscordSync(thread, {
    appliedTags: latest.appliedTags,
    archived,
    locked,
  });

  // Only state tags (per tagMapping.closedState) drive issue state.
  // Other tag changes are tracked in memory but never pushed to GitHub labels.
  if (!pending.appliedTags) {
    await syncAppliedTagsToGithub(thread, latest);
  }

  if (!pending.locked && thread.locked !== locked) {
    thread.locked = locked;
    locked ? await lockIssue(thread) : await unlockIssue(thread);
  }
  // Archive state is NO LONGER synced to GitHub issue state. A Discord forum
  // thread auto-unarchives whenever a message is posted to it, so treating
  // "unarchived" as "reopen" caused the issue to be reopened the moment anyone
  // replied in a resolved post. Issue open/close is driven solely by the
  // closed-state tag (see syncAppliedTagsToGithub). We keep the in-memory flag
  // up to date for bookkeeping only.
  if (!pending.archived && thread.archived !== archived) {
    thread.archived = archived;
  }
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
    switch (interaction.commandName) {
      case "Create Issue":
        return handleCreateIssueCommand(interaction);
      case "Sync to Issue":
        return handleSyncToIssueCommand(interaction);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case "subscribe-issue":
      return handleSubscribeIssueCommand(interaction);
    case "add-tag":
      return handleAddTagCommand(interaction);
    case "link-issue":
      return handleLinkIssueCommand(interaction);
    case "unlink-issue":
      return handleUnlinkIssueCommand(interaction);
  }

  // Close commands are config-driven; dispatch by matching the command name
  // against the configured closed-state reasons.
  const closeReason = getClosedReasonByCommandName(interaction.commandName);
  if (closeReason !== undefined) {
    return handleCloseCommand(interaction, closeReason);
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
  interaction: MessageContextMenuCommandInteraction,
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

    const starter = interaction.targetMessage;

    // A forum post's first message shares its id with the post itself. The
    // issue body embeds this message's URL, and that URL is what re-attaches
    // the issue to its post on restart, so only the first message can back an
    // issue — any other one would point the issue at a non-existent post.
    if (starter.id !== channel.id) {
      await interaction.reply({
        content:
          "Run this on the first message of the post (the one that opened it).",
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
    logger.error(`"Create Issue" handler failed: ${msg}`);
    const fallback = "Something went wrong while creating the issue.";
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
    const issueLink = `[#${thread.number}](<${issueUrl(thread.number!)}>)`;
    await interaction.editReply({
      content: [
        `Linked to issue ${issueLink} by <@${interaction.user.id}>.`,
        result.title,
      ].join("\n"),
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

async function handleCloseCommand(
  interaction: ChatInputCommandInteraction,
  reason: ClosedReason,
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

    await interaction.deferReply();

    const forum = channel.parent;
    if (!(forum instanceof ForumChannel)) {
      await interaction.editReply({ content: "This is not a forum channel." });
      return;
    }

    const closedIds = getClosedStateTagIds(forum);
    const targetId = closedIds[reason];

    if (!targetId) {
      await interaction.editReply({
        content: `The "${reason}" tag is not configured in this forum.`,
      });
      return;
    }

    // Drop every other closed-state tag (they are mutually exclusive) and any
    // in-progress (clear-on-close) tag, then apply the target closed-state tag.
    const allClosedIds = Object.values(closedIds).filter(
      (id): id is string => Boolean(id),
    );
    const clearIds = getClearOnCloseTagIds(forum);
    const removedClearTags = channel.appliedTags.filter((id) =>
      clearIds.includes(id),
    );

    const otherTags = channel.appliedTags.filter(
      (id) => !allClosedIds.includes(id) && !clearIds.includes(id),
    );
    if (otherTags.length >= 5) {
      await interaction.editReply({
        content:
          "This post already has 5 tags. Remove one tag before closing it.",
      });
      return;
    }

    const nextTags = [...otherTags, targetId];

    // Apply the closed-state tag only; the tag drives the GitHub close. We do
    // not archive the thread (archiving is no longer tied to issue state).
    await channel.edit({ appliedTags: nextTags });

    // The Discord tag change does not push label removals to GitHub on its
    // own, so mirror the cleared in-progress tags by removing their labels.
    const thread = store.threads.find((t) => t.id === channel.id);
    if (thread) {
      await removeGithubLabelsForTagIds(thread, forum, removedClearTags);
    }

    await interaction.editReply({
      content: `Marked as ${getClosedReasonLabel(reason)} and closed the issue.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    logger.error(`close command (${reason}) handler failed: ${msg}`);
    const fallback = "Something went wrong while running the command.";
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
