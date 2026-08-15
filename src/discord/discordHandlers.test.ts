import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteIssue, lockIssue, unlockIssue } from "../github/githubActions";
import { store } from "../store";
import { Thread } from "../interfaces";
import { handleThreadDelete, handleThreadUpdate } from "./discordHandlers";

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
