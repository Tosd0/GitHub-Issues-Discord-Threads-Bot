import { beforeEach, describe, expect, it, vi } from "vitest";
import { createComment } from "../discord/discordActions";
import { markAsBotComment } from "../utils/botComments";
import { handleCreated } from "./githubHandlers";

// Stubbed so importing the handlers does not spin up a Discord client.
// vi.mock is hoisted above the imports above.
vi.mock("../discord/discordActions", () => ({
  addClosedStateTag: vi.fn(),
  createComment: vi.fn(),
  deleteThread: vi.fn(),
  lockThread: vi.fn(),
  notifySubscribers: vi.fn(),
  reactToThreadStarter: vi.fn(),
  removeClosedStateTag: vi.fn(),
  syncIssueLabelTag: vi.fn(),
  unlockThread: vi.fn(),
}));

/** A GitHub "issue_comment created" webhook carrying the given comment body. */
function commentWebhook(body: string) {
  return {
    body: {
      comment: {
        id: 4242,
        body,
        user: { login: "octocat", avatar_url: "https://example.test/a.png" },
      },
      issue: { node_id: "I_node_id" },
    },
  } as unknown as Parameters<typeof handleCreated>[0];
}

describe("handleCreated", () => {
  beforeEach(() => {
    vi.mocked(createComment).mockClear();
  });

  it("mirrors a comment written on GitHub into the Discord post", () => {
    handleCreated(commentWebhook("Any chance this lands this week?"));
    expect(createComment).toHaveBeenCalledOnce();
  });

  it("does not mirror a note the bot wrote on the issue itself", () => {
    // /duplicate leaves "Duplicate of #12" on the issue and posts its own
    // notice in the forum post. Mirroring the note back would double it up —
    // and the post is locked by then, so the mirror would fail anyway.
    handleCreated(commentWebhook(markAsBotComment("Duplicate of #12")));
    expect(createComment).not.toHaveBeenCalled();
  });

  it("does not mirror a comment that came from Discord in the first place", () => {
    handleCreated(
      commentWebhook(
        "> Generated from Discord\n\nhttps://discord.com/channels/1/2/3",
      ),
    );
    expect(createComment).not.toHaveBeenCalled();
  });
});
