import { rm } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
} from "discord.js";
import { handleInteractionCreate } from "./discordHandlers";
import { knowledgeBase } from "./knowledgeCommands";

const state = vi.hoisted(() => ({
  file: `/tmp/gitbot-knowledge-commands-${process.pid}-${Date.now()}.json`,
}));
vi.mock("../config", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config")>();
  return {
    config: {
      ...original.config,
      KNOWLEDGE_BASE_FILE: state.file,
      DISCORD_ADMIN_ROLE_IDS: ["staff-role"],
    },
  };
});
vi.mock("./discord", () => ({
  default: { channels: { cache: new Map(), fetch: vi.fn() } },
  completionArchiver: { observe: vi.fn(), forget: vi.fn() },
}));

let guildId: string;
let sequence = 0;
beforeEach(() => {
  guildId = `guild-${++sequence}`;
});
afterAll(async () => {
  await rm(state.file, { force: true });
});

function command(
  commandName: string,
  options: Record<string, string | number> = {},
  admin = true,
) {
  return {
    commandName,
    guildId,
    memberPermissions: { has: () => admin },
    inCachedGuild: () => false,
    isAutocomplete: () => false,
    isMessageContextMenuCommand: () => false,
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => options.subcommand,
      getString: (name: string) => options[name] ?? null,
      getInteger: (name: string) => options[name] ?? null,
    },
    channel: {
      isThread: () => true,
      parentId: "100000000000000000",
      send: vi.fn(async () => ({})),
    },
    reply: vi.fn(async () => ({})),
    deferReply: vi.fn(async () => ({})),
    editReply: vi.fn(async (options: { content: string }) => ({
      content: options.content,
    })),
  };
}

async function dispatch(interaction: ReturnType<typeof command>) {
  await handleInteractionCreate(
    interaction as unknown as ChatInputCommandInteraction,
  );
}

describe("knowledge commands", () => {
  it("manages entries privately and sends exact saved text into the current post", async () => {
    const text = "面板教程\nhttps://discord.com/channels/1/2 @everyone";
    const add = command("knowledge", {
      subcommand: "add",
      name: "debug panel",
      text,
    });
    await dispatch(add);
    expect((await knowledgeBase.get(guildId, "debug panel"))?.text).toBe(text);
    expect(add.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(add.channel.send).not.toHaveBeenCalled();

    const send = command("send", { name: "DEBUG PANEL" });
    await dispatch(send);
    expect(send.channel.send).toHaveBeenCalledWith({
      content: text,
      allowedMentions: { parse: [], repliedUser: false },
    });

    const edit = command("knowledge", {
      subcommand: "edit",
      name: "debug panel",
      text: "updated",
    });
    await dispatch(edit);
    expect((await knowledgeBase.get(guildId, "debug panel"))?.text).toBe(
      "updated",
    );
    const rename = command("knowledge", {
      subcommand: "rename",
      name: "debug panel",
      "new-name": "troubleshooting panel",
    });
    await dispatch(rename);
    expect(await knowledgeBase.get(guildId, "debug panel")).toBeUndefined();
    expect(
      (await knowledgeBase.get(guildId, "troubleshooting panel"))?.text,
    ).toBe("updated");
    const show = command("knowledge", {
      subcommand: "show",
      name: "troubleshooting panel",
    });
    await dispatch(show);
    expect(show.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "updated" }),
    );
    const remove = command("knowledge", {
      subcommand: "delete",
      name: "troubleshooting panel",
    });
    await dispatch(remove);
    expect(
      await knowledgeBase.get(guildId, "troubleshooting panel"),
    ).toBeUndefined();
  });

  it("denies all knowledge commands to non-admin members", async () => {
    for (const name of ["send", "knowledge"]) {
      const interaction = command(
        name,
        { subcommand: "add", name: "test", text: "text" },
        false,
      );
      await dispatch(interaction);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ ephemeral: true }),
      );
      expect(interaction.channel.send).not.toHaveBeenCalled();
    }
    expect(await knowledgeBase.list(guildId)).toEqual([]);
  });

  it("allows configured staff roles without Administrator permission", async () => {
    const interaction = Object.assign(
      command(
        "knowledge",
        { subcommand: "add", name: "test", text: "text" },
        false,
      ),
      {
        inCachedGuild: () => true,
        member: { roles: { cache: new Map([["staff-role", {}]]) } },
      },
    );
    await dispatch(interaction);
    expect((await knowledgeBase.get(guildId, "test"))?.text).toBe("text");
  });

  it("does not send into other channels or another server", async () => {
    await knowledgeBase.add(guildId, "debug panel", "saved");
    const outside = command("send", { name: "debug panel" });
    outside.channel.parentId = "other-forum";
    await dispatch(outside);
    expect(outside.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(outside.channel.send).not.toHaveBeenCalled();
    const otherServer = command("send", { name: "debug panel" });
    otherServer.guildId = "other-guild";
    await dispatch(otherServer);
    expect(otherServer.channel.send).not.toHaveBeenCalled();
    expect(otherServer.editReply).toHaveBeenCalled();
  });

  it("paginates the list without exceeding Discord message length", async () => {
    for (let i = 0; i < 30; i++)
      await knowledgeBase.add(
        guildId,
        `${i}`.padStart(2, "0") + "x".repeat(98),
        "text",
      );
    const interaction = command("knowledge", { subcommand: "list", page: 2 });
    await dispatch(interaction);
    const content = interaction.editReply.mock.calls[0]?.[0] as unknown as {
      content: string;
    };
    expect(content.content).toContain("15" + "x".repeat(98));
    expect(content.content).not.toContain("00" + "x".repeat(98));
    expect(content.content.length).toBeLessThanOrEqual(2000);
  });

  it("autocompletes current server entries immediately and clears suggestions after deletion", async () => {
    await knowledgeBase.add(guildId, "debug panel", "saved");
    await knowledgeBase.add("different-server", "debug other", "hidden");
    const interaction = Object.assign(command("send"), {
      isAutocomplete: () => true,
      options: { getFocused: () => "PANEL" },
      respond: vi.fn(async () => undefined),
    });
    await handleInteractionCreate(
      interaction as unknown as AutocompleteInteraction,
    );
    expect(interaction.respond).toHaveBeenLastCalledWith([
      { name: "debug panel", value: "debug panel" },
    ]);
    await knowledgeBase.delete(guildId, "debug panel");
    await handleInteractionCreate(
      interaction as unknown as AutocompleteInteraction,
    );
    expect(interaction.respond).toHaveBeenLastCalledWith([]);
  });

  it("keeps autocomplete private from non-admin members", async () => {
    await knowledgeBase.add(guildId, "secret", "text");
    const interaction = Object.assign(command("send", {}, false), {
      isAutocomplete: () => true,
      options: { getFocused: () => "" },
      respond: vi.fn(async () => undefined),
    });
    await handleInteractionCreate(
      interaction as unknown as AutocompleteInteraction,
    );
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it("reports a send failure privately without claiming success", async () => {
    await knowledgeBase.add(guildId, "test", "text");
    const interaction = command("send", { name: "test" });
    interaction.channel.send.mockRejectedValue(
      new Error("Missing permissions"),
    );
    await dispatch(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("失败") }),
    );
  });
});
