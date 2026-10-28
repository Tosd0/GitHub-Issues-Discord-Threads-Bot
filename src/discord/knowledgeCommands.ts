import {
  ApplicationCommandAutocompleteStringOptionData,
  ApplicationCommandStringOptionData,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  AutocompleteInteraction,
  ChatInputApplicationCommandData,
  ChatInputCommandInteraction,
  ThreadChannel,
} from "discord.js";
import { config } from "../config";
import { KnowledgeBase, KnowledgeInputError } from "../knowledgeBase";
import { logger } from "../logger";

export const knowledgeBase = new KnowledgeBase(config.KNOWLEDGE_BASE_FILE);

function nameOption(
  autocomplete: boolean,
):
  | ApplicationCommandStringOptionData
  | ApplicationCommandAutocompleteStringOptionData {
  return {
    name: "name",
    description: "Knowledge entry name, for example debug panel.",
    type: ApplicationCommandOptionType.String,
    required: true,
    autocomplete,
    minLength: 1,
    maxLength: 100,
  };
}

const newNameOption: ApplicationCommandStringOptionData = {
  name: "new-name",
  description: "New name for the knowledge entry.",
  type: ApplicationCommandOptionType.String,
  required: true,
  minLength: 1,
  maxLength: 100,
};

const textOption: ApplicationCommandStringOptionData = {
  name: "text",
  description: "Text or tutorial link to save (up to 2000 characters).",
  type: ApplicationCommandOptionType.String,
  required: true,
  minLength: 1,
  maxLength: 2000,
};

export const knowledgeCommands: ChatInputApplicationCommandData[] = [
  {
    name: "send",
    description:
      "Send a saved knowledge entry into this forum post. (Admin only)",
    type: ApplicationCommandType.ChatInput,
    dmPermission: false,
    options: [nameOption(true)],
  },
  {
    name: "knowledge",
    description: "Manage saved text and tutorial links. (Admin only)",
    type: ApplicationCommandType.ChatInput,
    dmPermission: false,
    options: [
      {
        name: "add",
        description: "Add a knowledge entry.",
        type: ApplicationCommandOptionType.Subcommand,
        options: [nameOption(false), textOption],
      },
      {
        name: "edit",
        description: "Replace a knowledge entry's text.",
        type: ApplicationCommandOptionType.Subcommand,
        options: [nameOption(true), textOption],
      },
      {
        name: "rename",
        description: "Rename a knowledge entry.",
        type: ApplicationCommandOptionType.Subcommand,
        options: [nameOption(true), newNameOption],
      },
      {
        name: "delete",
        description: "Delete a knowledge entry.",
        type: ApplicationCommandOptionType.Subcommand,
        options: [nameOption(true)],
      },
      {
        name: "show",
        description: "Preview a knowledge entry privately.",
        type: ApplicationCommandOptionType.Subcommand,
        options: [nameOption(true)],
      },
      {
        name: "list",
        description: "List this server's knowledge entries privately.",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "page",
            description: "Page number (15 entries per page).",
            type: ApplicationCommandOptionType.Integer,
            minValue: 1,
          },
        ],
      },
    ],
  },
];

const allowedMentions = { parse: [] as [], repliedUser: false };

export async function handleKnowledgeAutocomplete(
  interaction: AutocompleteInteraction,
  isAdmin: boolean,
) {
  try {
    const entries =
      isAdmin && interaction.guildId
        ? await knowledgeBase.search(
            interaction.guildId,
            interaction.options.getFocused(),
          )
        : [];
    await interaction.respond(
      entries.map((entry) => ({ name: entry.name, value: entry.name })),
    );
  } catch (error) {
    logger.error(
      `Knowledge autocomplete failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await interaction.respond([]).catch(() => undefined);
  }
}

export async function handleKnowledgeCommand(
  interaction: ChatInputCommandInteraction,
  isAdmin: boolean,
) {
  let deferred = false;
  try {
    if (!isAdmin || !interaction.guildId) {
      await interaction.reply({
        content: "只有服务器管理员或配置的管理角色可以使用这个命令。",
        ephemeral: true,
      });
      return;
    }
    const channel = interaction.channel;
    if (
      interaction.commandName === "send" &&
      (!channel?.isThread() ||
        !channel.parentId ||
        !config.DISCORD_CHANNEL_IDS.includes(channel.parentId))
    ) {
      await interaction.reply({
        content: "请在机器人配置的论坛帖子里使用 /send。",
        ephemeral: true,
      });
      return;
    }
    // Acknowledge privately before disk or Discord I/O. Only /send publishes text.
    await interaction.deferReply({ ephemeral: true });
    deferred = true;
    const guildId = interaction.guildId;
    const action =
      interaction.commandName === "send"
        ? "send"
        : interaction.options.getSubcommand();
    let content: string;
    if (action === "list") {
      const entries = await knowledgeBase.list(guildId);
      const page = interaction.options.getInteger("page") ?? 1;
      const pages = Math.max(1, Math.ceil(entries.length / 15));
      if (page > pages)
        throw new KnowledgeInputError(`只有 ${pages} 页，请选择有效的页码。`);
      content =
        entries.length === 0
          ? "知识库还是空的。使用 /knowledge add 添加条目。"
          : `知识库：第 ${page}/${pages} 页，共 ${entries.length} 条\n` +
            entries
              .slice((page - 1) * 15, page * 15)
              .map((entry) => `• \`${entry.name.replace(/`/g, "ˋ")}\``)
              .join("\n");
    } else {
      const name = interaction.options.getString("name", true);
      switch (action) {
        case "add":
          await knowledgeBase.add(
            guildId,
            name,
            interaction.options.getString("text", true),
          );
          content = "知识库条目已添加，可以使用 /send 发送。";
          break;
        case "edit":
          await knowledgeBase.edit(
            guildId,
            name,
            interaction.options.getString("text", true),
          );
          content = "知识库条目已更新。";
          break;
        case "rename":
          await knowledgeBase.rename(
            guildId,
            name,
            interaction.options.getString("new-name", true),
          );
          content = "知识库条目已重命名。";
          break;
        case "delete":
          await knowledgeBase.delete(guildId, name);
          content = "知识库条目已删除。";
          break;
        case "show":
        case "send": {
          const entry = await knowledgeBase.get(guildId, name);
          if (!entry)
            throw new KnowledgeInputError(
              "找不到这个知识库条目。请使用 /knowledge list 查看已有条目。",
            );
          if (action === "send") {
            await (channel as ThreadChannel).send({
              content: entry.text,
              allowedMentions,
            });
            content = "已发送到当前帖子。";
          } else content = entry.text;
          break;
        }
        default:
          throw new KnowledgeInputError("未知的知识库操作。");
      }
    }
    await interaction.editReply({ content, allowedMentions });
  } catch (error) {
    logger.error(
      `/${interaction.commandName} knowledge handler failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    const content =
      error instanceof KnowledgeInputError
        ? error.message
        : "操作失败，请检查知识库文件或机器人的发帖权限，稍后重试。";
    try {
      if (deferred || interaction.deferred || interaction.replied)
        await interaction.editReply({ content, allowedMentions });
      else
        await interaction.reply({ content, ephemeral: true, allowedMentions });
    } catch {
      /* The interaction may have expired. */
    }
  }
}
