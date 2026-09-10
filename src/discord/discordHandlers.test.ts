import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteIssue, lockIssue, unlockIssue } from "../github/githubActions";
import { store } from "../store";
import { Thread } from "../interfaces";
import {
  buildMentionChunks,
  collectThreadParticipantIds,
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

beforeEach(() => {
  store.threads.length = 0;
  vi.mocked(lockIssue).mockClear();
  vi.mocked(unlockIssue).mockClear();
  vi.mocked(deleteIssue).mockClear();
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
