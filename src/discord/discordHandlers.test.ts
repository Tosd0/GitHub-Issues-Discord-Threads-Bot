import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, ForumChannel } from "discord.js";
import {
  addLabelsToIssue,
  deleteIssue,
  lockIssue,
  openIssue,
  removeLabelsFromIssue,
  unlockIssue,
} from "../github/githubActions";
import { tagMapping } from "../tagMapping";
import { store } from "../store";
import { Thread } from "../interfaces";
import {
  buildMentionChunks,
  collectThreadParticipantIds,
  handleClientReady,
  handleInteractionCreate,
  handleThreadDelete,
  handleThreadUpdate,
} from "./discordHandlers";

// Every GitHub call is stubbed; these tests are about which of them the
// Discord-side handlers decide to make.
vi.mock("../github/githubActions", () => ({
  octokit: {},
  repoCredentials: {},
  getDiscordInfoFromGithubBody: vi.fn(() => ({})),
  addLabelsToIssue: vi.fn(),
  closeIssue: vi.fn(),
  createBotIssueComment: vi.fn(),
  createIssue: vi.fn(),
  createIssueComment: vi.fn(),
  deleteComment: vi.fn(),
  deleteIssue: vi.fn(),
  getIssues: vi.fn(async () => []),
  linkIssue: vi.fn(),
  listRepoLabels: vi.fn(async () => []),
  lockIssue: vi.fn(),
  openIssue: vi.fn(),
  removeLabelsFromIssue: vi.fn(),
  unlinkIssue: vi.fn(),
  unlockIssue: vi.fn(),
}));

// Matches DISCORD_CHANNEL_ID in vitest.config.mts.
const FORUM_ID = "100000000000000000";

/** A forum post whose lock state just changed to `locked`. */
function forumPost(id: string, locked: boolean) {
  const latest = {
    appliedTags: [] as string[],
    members: { thread: { id, archived: false, locked } },
  };
  return {
    id,
    parentId: FORUM_ID,
    appliedTags: [] as string[],
    fetch: async () => latest,
  } as unknown as Parameters<typeof handleThreadUpdate>[0];
}

function trackPost(overrides: Partial<Thread> = {}): Thread {
  const thread: Thread = {
    id: "700000000000000000",
    title: "a post",
    appliedTags: [],
    archived: false,
    locked: false,
    comments: [],
    ...overrides,
  };
  store.threads.push(thread);
  return thread;
}

const deployedLabels = tagMapping.labels;
const deployedGroups = tagMapping.tagGroups;
const deployedStatusLabels = tagMapping.statusCommandLabels;

beforeEach(() => {
  store.threads.length = 0;
  tagMapping.labels = [];
  tagMapping.tagGroups = [];
  tagMapping.statusCommandLabels = {
    confirmed: "confirmed",
    reopen: "needs triage",
  };
  vi.clearAllMocks();
  vi.mocked(addLabelsToIssue).mockResolvedValue(true);
  vi.mocked(openIssue).mockResolvedValue(true);
  vi.mocked(unlockIssue).mockResolvedValue(true);
});

afterEach(() => {
  tagMapping.labels = deployedLabels;
  tagMapping.tagGroups = deployedGroups;
  tagMapping.statusCommandLabels = deployedStatusLabels;
});

describe("status commands", () => {
  const tags = [
    { id: "done", name: tagMapping.closedState.completed },
    { id: "invalid", name: tagMapping.closedState.not_planned },
    { id: "duplicate", name: tagMapping.closedState.duplicate },
    { id: "triage", name: "needs triage" },
    { id: "confirmed", name: "confirmed" },
    { id: "priority", name: "priority: high" },
  ];

  function statusInteraction(
    commandName: string,
    appliedTags: string[],
    admin = true,
  ) {
    const forum = Object.assign(Object.create(ForumChannel.prototype), {
      availableTags: tags,
    });
    const channel = {
      id: "700000000000000000",
      name: "a post",
      parentId: FORUM_ID,
      parent: forum,
      appliedTags,
      archived: false,
      locked: false,
      isThread: () => true,
      edit: vi.fn(async () => undefined),
    };
    const interaction = {
      commandName,
      channel,
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => true,
      memberPermissions: { has: () => admin },
      inCachedGuild: () => false,
      user: { id: "admin" },
      deferred: false,
      replied: false,
      reply: vi.fn(),
      deferReply: vi.fn(async () => {
        interaction.deferred = true;
      }),
      editReply: vi.fn(),
    };
    return interaction;
  }

  async function runCommand(interaction: ReturnType<typeof statusInteraction>) {
    await handleInteractionCreate(
      interaction as unknown as Parameters<typeof handleInteractionCreate>[0],
    );
  }

  it("registers both commands on startup", async () => {
    const set = vi.fn();
    const client = {
      user: { tag: "test bot" },
      channels: {
        fetch: vi.fn(async () => ({
          availableTags: tags,
          guild: { id: "guild" },
        })),
      },
      guilds: {
        cache: new Map([["guild", { name: "test guild", commands: { set } }]]),
      },
    } as unknown as Client;
    await handleClientReady(client);
    expect(set).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: "confirmed" }),
        expect.objectContaining({ name: "reopen" }),
      ]),
    );
  });

  it("confirms a post and mirrors the status label", async () => {
    const thread = trackPost({
      number: 42,
      appliedTags: ["triage", "priority"],
    });
    const interaction = statusInteraction("confirmed", thread.appliedTags);
    await runCommand(interaction);
    expect(interaction.channel.edit).toHaveBeenCalledWith({
      appliedTags: ["priority", "confirmed"],
    });
    expect(removeLabelsFromIssue).toHaveBeenCalledWith(thread, [
      "needs triage",
    ]);
    expect(addLabelsToIssue).toHaveBeenCalledWith(thread, ["confirmed"]);
    expect(openIssue).not.toHaveBeenCalled();
  });

  it("reopens a closed, locked post with the default tag and preserves priority", async () => {
    const thread = trackPost({
      number: 42,
      appliedTags: ["done", "confirmed", "priority"],
      locked: true,
      archived: true,
    });
    const interaction = statusInteraction("reopen", thread.appliedTags);
    interaction.channel.locked = true;
    interaction.channel.archived = true;
    await runCommand(interaction);
    expect(interaction.channel.edit).toHaveBeenCalledWith({
      appliedTags: ["priority", "triage"],
      archived: false,
      locked: false,
    });
    expect(openIssue).toHaveBeenCalledWith(thread);
    expect(unlockIssue).toHaveBeenCalledWith(thread);
    expect(removeLabelsFromIssue).toHaveBeenCalledWith(thread, ["confirmed"]);
    expect(addLabelsToIssue).toHaveBeenCalledWith(thread, ["needs triage"]);
  });

  it("works on posts without a linked issue", async () => {
    const interaction = statusInteraction("reopen", ["invalid"]);
    await runCommand(interaction);
    expect(interaction.channel.edit).toHaveBeenCalledWith({
      appliedTags: ["triage"],
    });
    expect(openIssue).not.toHaveBeenCalled();
    expect(addLabelsToIssue).not.toHaveBeenCalled();
  });

  it.each(["confirmed", "reopen"])("rejects non-admin /%s", async (command) => {
    const interaction = statusInteraction(command, ["done"], false);
    await runCommand(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.channel.edit).not.toHaveBeenCalled();
  });

  it("asks to reopen before confirming a closed post", async () => {
    const interaction = statusInteraction("confirmed", ["done"]);
    await runCommand(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "This post is closed. Use /reopen first.",
    });
    expect(interaction.channel.edit).not.toHaveBeenCalled();
  });

  it("does not change the post if its target tag is missing", async () => {
    const interaction = statusInteraction("reopen", ["done"]);
    interaction.channel.parent.availableTags = tags.filter(
      (tag) => tag.id !== "triage",
    );
    await runCommand(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("not configured"),
      }),
    );
    expect(interaction.channel.edit).not.toHaveBeenCalled();
  });

  it("does not mirror changes to GitHub when Discord editing fails", async () => {
    trackPost({ number: 42, appliedTags: ["done"] });
    const interaction = statusInteraction("reopen", ["done"]);
    interaction.channel.edit.mockRejectedValue(
      new Error("Discord unavailable"),
    );
    await runCommand(interaction);
    expect(openIssue).not.toHaveBeenCalled();
    expect(addLabelsToIssue).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Something went wrong while running the command.",
    });
  });

  it("uses deployed label mappings and clears every triage tag", async () => {
    const previousLabels = tagMapping.labels;
    const previousGroups = tagMapping.tagGroups;
    tagMapping.labels = [
      { github: "confirmed", discord: "已确认" },
      { github: "needs triage", discord: "需要分拣" },
      { github: "needs info", discord: "需要信息" },
    ];
    tagMapping.tagGroups = [
      { name: "triage", clearOnClose: true, tags: ["需要分拣", "需要信息"] },
    ];
    try {
      const thread = trackPost({
        number: 42,
        appliedTags: ["triage", "info", "priority"],
      });
      const interaction = statusInteraction("confirmed", thread.appliedTags);
      interaction.channel.parent.availableTags = [
        ...tags.filter((tag) => !["triage", "confirmed"].includes(tag.id)),
        { id: "triage", name: "需要分拣" },
        { id: "info", name: "需要信息" },
        { id: "confirmed", name: "已确认" },
      ];
      await runCommand(interaction);
      expect(interaction.channel.edit).toHaveBeenCalledWith({
        appliedTags: ["priority", "confirmed"],
      });
      expect(removeLabelsFromIssue).toHaveBeenCalledWith(thread, [
        "needs triage",
        "needs info",
      ]);
      expect(addLabelsToIssue).toHaveBeenCalledWith(thread, ["confirmed"]);
    } finally {
      tagMapping.labels = previousLabels;
      tagMapping.tagGroups = previousGroups;
    }
  });

  it("keeps unrelated tags when Discord's tag limit would be exceeded", async () => {
    const interaction = statusInteraction("reopen", ["a", "b", "c", "d", "e"]);
    await runCommand(interaction);
    expect(interaction.channel.edit).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("5 tags") }),
    );
  });

  it("reports a GitHub label sync failure without claiming full success", async () => {
    trackPost({ number: 42, appliedTags: ["triage"] });
    vi.mocked(addLabelsToIssue).mockResolvedValue(false);
    const interaction = statusInteraction("confirmed", ["triage"]);
    await runCommand(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Post status updated, but GitHub label sync failed. Please check the logs.",
    });
  });

  it.each(["open", "unlock"])("reports a failed GitHub %s", async (action) => {
    trackPost({ number: 42, appliedTags: ["done"], locked: true });
    const interaction = statusInteraction("reopen", ["done"]);
    interaction.channel.locked = true;
    vi.mocked(action === "open" ? openIssue : unlockIssue).mockResolvedValue(
      false,
    );
    await runCommand(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "Post status updated, but GitHub reopen/unlock failed. Please check the logs.",
    });
    expect(addLabelsToIssue).not.toHaveBeenCalled();
  });

  it("suppresses gateway echoes so a reopen is mirrored only once", async () => {
    const thread = trackPost({
      number: 42,
      appliedTags: ["done"],
      locked: true,
    });
    const interaction = statusInteraction("reopen", ["done"]);
    interaction.channel.locked = true;
    interaction.channel.edit.mockImplementation(async () => {
      await handleThreadUpdate({
        id: thread.id,
        parentId: FORUM_ID,
        fetch: async () => ({
          parent: interaction.channel.parent,
          appliedTags: ["triage"],
          members: {
            thread: { id: thread.id, archived: false, locked: false },
          },
        }),
      } as unknown as Parameters<typeof handleThreadUpdate>[0]);
    });
    await runCommand(interaction);
    expect(openIssue).toHaveBeenCalledOnce();
    expect(unlockIssue).toHaveBeenCalledOnce();
    expect(thread.pendingDiscordSync).toBeUndefined();
    expect(thread.appliedTags).toEqual(["triage"]);
  });

  it.each(["done", "invalid", "duplicate"])(
    "reopens the %s closed-state reason",
    async (closedTag) => {
      const interaction = statusInteraction("reopen", [closedTag, "priority"]);
      await runCommand(interaction);
      expect(interaction.channel.edit).toHaveBeenCalledWith({
        appliedTags: ["priority", "triage"],
      });
    },
  );

  it("rejects commands outside a configured forum post", async () => {
    const interaction = statusInteraction("reopen", ["done"]);
    interaction.channel.parentId = "another-forum";
    await runCommand(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "This command must be used inside a forum post.",
      ephemeral: true,
    });
    expect(interaction.channel.edit).not.toHaveBeenCalled();
  });
});

describe("handleThreadUpdate lock mirroring", () => {
  it("mirrors the lock to the issue a post is linked to", async () => {
    const thread = trackPost({ number: 42 });
    await handleThreadUpdate(forumPost(thread.id, true));
    expect(lockIssue).toHaveBeenCalledOnce();
  });

  it("mirrors an unlock too", async () => {
    const thread = trackPost({ number: 42, locked: true });
    await handleThreadUpdate(forumPost(thread.id, false));
    expect(unlockIssue).toHaveBeenCalledOnce();
  });

  it("stays quiet when the post has no linked issue", async () => {
    // /duplicate locks the post it closes. On a post that was never linked to
    // an issue there is nothing to mirror, and calling through only logs an
    // error for something that is not a failure.
    const thread = trackPost();
    await handleThreadUpdate(forumPost(thread.id, true));
    expect(lockIssue).not.toHaveBeenCalled();
    // The in-memory flag still has to follow Discord.
    expect(thread.locked).toBe(true);
  });
});

describe("handleThreadDelete", () => {
  it("deletes the issue a post is linked to", async () => {
    const thread = trackPost({ node_id: "I_node_id" });
    await handleThreadDelete(forumPost(thread.id, false));
    expect(deleteIssue).toHaveBeenCalledOnce();
  });

  it("stays quiet when the post has no linked issue", async () => {
    const thread = trackPost();
    await handleThreadDelete(forumPost(thread.id, false));
    expect(deleteIssue).not.toHaveBeenCalled();
  });
});

describe("collectThreadParticipantIds", () => {
  /** A thread whose history is `pages` (newest page first), 100 per page. */
  function threadWith(
    ownerId: string | null,
    pages: { id: string; author: { id: string; bot: boolean } }[][],
  ) {
    const fetch = vi.fn(async () => {
      const page = pages.shift() ?? [];
      return {
        size: page.length,
        values: () => page.values(),
        last: () => page[page.length - 1],
      };
    });
    return { ownerId, messages: { fetch } } as unknown as Parameters<
      typeof collectThreadParticipantIds
    >[0] & { messages: { fetch: typeof fetch } };
  }

  const msg = (id: string, author: string, bot = false) => ({
    id,
    author: { id: author, bot },
  });

  it("lists the post author first, then everyone else in posting order", async () => {
    const thread = threadWith("owner", [
      [msg("3", "bob"), msg("2", "alice"), msg("1", "owner")],
    ]);
    await expect(collectThreadParticipantIds(thread)).resolves.toEqual([
      "owner",
      "alice",
      "bob",
    ]);
  });

  it("skips bots and de-duplicates repeat posters", async () => {
    const thread = threadWith(null, [
      [
        msg("4", "alice"),
        msg("3", "the-bot", true),
        msg("2", "bob"),
        msg("1", "alice"),
      ],
    ]);
    await expect(collectThreadParticipantIds(thread)).resolves.toEqual([
      "alice",
      "bob",
    ]);
  });

  it("pages through histories longer than one fetch", async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
      msg(String(200 - i), "alice"),
    );
    const thread = threadWith(null, [full, [msg("1", "carol")]]);
    await expect(collectThreadParticipantIds(thread)).resolves.toEqual([
      "carol",
      "alice",
    ]);
    expect(thread.messages.fetch).toHaveBeenNthCalledWith(2, {
      limit: 100,
      before: "101",
    });
  });
});

describe("buildMentionChunks", () => {
  it("keeps every message under Discord's 2000 character limit", () => {
    const ids = Array.from({ length: 200 }, (_, i) =>
      String(100000000000000000 + i),
    );
    const chunks = buildMentionChunks(ids);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
    expect(chunks.join(" ").split(" ")).toEqual(ids.map((id) => `<@${id}>`));
  });

  it("returns nothing for an empty list", () => {
    expect(buildMentionChunks([])).toEqual([]);
  });
});
