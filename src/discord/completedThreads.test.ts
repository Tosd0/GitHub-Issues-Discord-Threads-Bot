import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Collection, ForumChannel, AnyThreadChannel } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tagMapping } from "../tagMapping";
import { CompletedThreadArchiver } from "./completedThreads";

const FORUM_ID = "100000000000000000";
const DAY = 86_400_000;
let directory: string;
let stateFile: string;
let client: Client;
let reportError: ReturnType<typeof vi.fn<Console["error"]>>;
let posts: Map<string, ReturnType<typeof post>>;

function post(id = "700000000000000000", appliedTags = ["done"]) {
  const messages = new Collection<
    string,
    {
      id: string;
      content: string;
      createdTimestamp: number;
      author: { id: string };
    }
  >();
  const forum = Object.assign(Object.create(ForumChannel.prototype), {
    id: FORUM_ID,
    availableTags: [
      { id: "done", name: tagMapping.closedState.completed },
      { id: "invalid", name: tagMapping.closedState.not_planned },
      { id: "duplicate", name: tagMapping.closedState.duplicate },
    ],
  });
  const channel = {
    id,
    parentId: FORUM_ID,
    parent: forum,
    appliedTags,
    archived: false,
    locked: false,
    isThread: () => true,
    messages: { fetch: vi.fn(async () => messages) },
    send: vi.fn(async (options: { content: string }) => {
      const message = {
        id: String(messages.size + 1),
        content: options.content,
        createdTimestamp: Date.now(),
        author: { id: "bot" },
      };
      messages.set(message.id, message);
      return message;
    }),
    setArchived: vi.fn(async (archived: boolean) => {
      channel.archived = archived;
      return channel;
    }),
  };
  return channel;
}

const asThread = (channel: ReturnType<typeof post>) =>
  channel as unknown as AnyThreadChannel;
const service = () =>
  new CompletedThreadArchiver(client, stateFile, reportError);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
  directory = await mkdtemp(join(tmpdir(), "completed-threads-"));
  stateFile = join(directory, "state.json");
  reportError = vi.fn();
  posts = new Map();
  client = {
    user: { id: "bot" },
    channels: {
      fetch: vi.fn(async (id: string) => {
        if (id === FORUM_ID) {
          return {
            threads: {
              fetchActive: async () => ({ threads: new Collection(posts) }),
            },
          };
        }
        const channel = posts.get(id);
        if (!channel)
          throw Object.assign(new Error("Unknown channel"), { code: 10003 });
        return channel;
      }),
    },
  } as unknown as Client;
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

describe("completed post archiving", () => {
  it.each([
    ["invalid", "无效"],
    ["duplicate", "重复"],
  ])(
    "starts a two-day countdown for an old post newly marked %s",
    async (tag, label) => {
      const channel = post("700000000000000000", [tag]);
      posts.set(channel.id, channel);
      const archiver = service();
      await archiver.observe(asThread(channel));
      await archiver.observe(asThread(channel));
      expect(channel.send).toHaveBeenCalledExactlyOnceWith({
        content: `此帖子已被标记为${label}。若2天内无新问题则会被折叠（关闭）。`,
        allowedMentions: { parse: [] },
      });
      vi.setSystemTime(Date.now() + 2 * DAY - 1);
      await service().checkDue();
      expect(channel.archived).toBe(false);
      vi.setSystemTime(Date.now() + 1);
      await service().checkDue();
      expect(channel.archived).toBe(true);
    },
  );

  it.each(["invalid", "duplicate"])(
    "cancels %s on reopen and restarts on a new closure",
    async (tag) => {
      const channel = post(undefined, [tag]);
      posts.set(channel.id, channel);
      const archiver = service();
      await archiver.observe(asThread(channel));
      channel.appliedTags = ["triage"];
      await archiver.observe(asThread(channel));
      vi.setSystemTime(Date.now() + 2 * DAY);
      await archiver.checkDue();
      expect(channel.archived).toBe(false);
      expect(JSON.parse(await readFile(stateFile, "utf8")).threads).toEqual({});
      channel.appliedTags = [tag];
      await archiver.observe(asThread(channel));
      await archiver.checkDue();
      expect(channel.send).toHaveBeenCalledTimes(2);
      expect(channel.archived).toBe(false);
      vi.setSystemTime(Date.now() + 2 * DAY);
      await archiver.checkDue();
      expect(channel.archived).toBe(true);
    },
  );

  it("keeps the deadline when switching between closed-state reasons", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    const archiver = service();
    await archiver.observe(asThread(channel));
    vi.setSystemTime(Date.now() + DAY);
    channel.appliedTags = ["invalid"];
    await archiver.observe(asThread(channel));
    channel.appliedTags = ["duplicate"];
    await archiver.observe(asThread(channel));
    vi.setSystemTime(Date.now() + DAY);
    await archiver.checkDue();
    expect(channel.archived).toBe(true);
    expect(channel.send).toHaveBeenCalledOnce();
  });

  it.each(["invalid", "duplicate"])(
    "enrolls active %s posts on startup and recovers lost notices",
    async (tag) => {
      const channel = post(undefined, [tag]);
      posts.set(channel.id, channel);
      const send = channel.send.getMockImplementation()!;
      channel.send.mockImplementationOnce(async (options) => {
        await send(options);
        throw new Error("response lost");
      });
      await service().start();
      expect(channel.send).toHaveBeenCalledOnce();
      vi.setSystemTime(Date.now() + 2 * DAY);
      await service().checkDue();
      expect(channel.send).toHaveBeenCalledOnce();
      expect(channel.archived).toBe(true);
    },
  );

  it("does not send a completion notice for an archive-only event on an untracked old post", async () => {
    const channel = post();
    channel.archived = true;
    await service().observe(asThread(channel), false);
    expect(channel.send).not.toHaveBeenCalled();
  });
  it("does not reopen a manually archived post to retry a failed completion notice", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    channel.send.mockRejectedValueOnce(new Error("temporary send failure"));
    const archiver = service();
    await archiver.observe(asThread(channel));
    channel.archived = true;
    await archiver.observe(asThread(channel), false);
    await archiver.checkDue();
    expect(channel.send).toHaveBeenCalledOnce();
    expect(channel.archived).toBe(true);
  });
  it("sends one notice for repeated completion events and archives only at two days", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    const archiver = service();
    await Promise.all([
      archiver.observe(asThread(channel)),
      archiver.observe(asThread(channel)),
    ]);
    expect(channel.send).toHaveBeenCalledOnce();
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "此帖子已被标记为已解决。若2天内无新问题则会被折叠（关闭）。",
      }),
    );
    vi.setSystemTime(Date.now() + 2 * DAY - 1);
    await archiver.checkDue();
    expect(channel.setArchived).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1);
    await archiver.checkDue();
    expect(channel.setArchived).toHaveBeenCalledWith(true);
    expect(channel.locked).toBe(false);
  });

  it("uses the sent message timestamp rather than the tag-change time", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    const send = channel.send.getMockImplementation()!;
    channel.send.mockImplementation(async (options) => {
      vi.setSystemTime(Date.now() + 60_000);
      return send(options);
    });
    const archiver = service();
    const taggedAt = Date.now();
    await archiver.observe(asThread(channel));
    vi.setSystemTime(taggedAt + 2 * DAY);
    await archiver.checkDue();
    expect(channel.setArchived).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 60_000);
    await archiver.checkDue();
    expect(channel.archived).toBe(true);
  });

  it("cancels on reopen and grants a fresh two days after completing again", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    const archiver = service();
    await archiver.observe(asThread(channel));
    vi.setSystemTime(Date.now() + DAY);
    channel.appliedTags = [];
    await archiver.observe(asThread(channel));
    channel.appliedTags = ["done"];
    await archiver.observe(asThread(channel));
    expect(channel.send).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + DAY);
    await archiver.checkDue();
    expect(channel.setArchived).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + DAY);
    await archiver.checkDue();
    expect(channel.archived).toBe(true);
  });

  it("rechecks current tags even if the reopen event was missed", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    const archiver = service();
    await archiver.observe(asThread(channel));
    channel.appliedTags = ["triage"];
    vi.setSystemTime(Date.now() + 2 * DAY);
    await archiver.checkDue();
    expect(channel.setArchived).not.toHaveBeenCalled();
    expect(client.channels.fetch).toHaveBeenCalledWith(channel.id, {
      force: true,
    });
    channel.appliedTags = ["done"];
    await archiver.observe(asThread(channel));
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it("restores the original deadline from disk after restart", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    await service().observe(asThread(channel));
    vi.setSystemTime(Date.now() + 2 * DAY);
    await service().start();
    expect(channel.send).toHaveBeenCalledOnce();
    expect(channel.archived).toBe(true);
  });

  it("does not repeat a completed cycle when a reply unarchives the post", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    const archiver = service();
    await archiver.observe(asThread(channel));
    vi.setSystemTime(Date.now() + 2 * DAY);
    await archiver.checkDue();
    channel.archived = false;
    const restarted = service();
    await restarted.observe(asThread(channel));
    await restarted.checkDue();
    expect(channel.send).toHaveBeenCalledOnce();
    expect(channel.setArchived).toHaveBeenCalledOnce();
  });

  it("does not postpone the deadline on ordinary replies or unrelated tag changes", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    const archiver = service();
    await archiver.observe(asThread(channel));
    vi.setSystemTime(Date.now() + DAY);
    channel.appliedTags.push("priority");
    await archiver.observe(asThread(channel));
    vi.setSystemTime(Date.now() + DAY);
    await archiver.checkDue();
    expect(channel.archived).toBe(true);
    expect(channel.send).toHaveBeenCalledOnce();
  });

  it("retries a failed notice before starting the two-day clock", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    channel.send.mockRejectedValueOnce(new Error("temporary send failure"));
    const archiver = service();
    await archiver.observe(asThread(channel));
    vi.setSystemTime(Date.now() + 3 * DAY);
    await archiver.checkDue();
    expect(channel.setArchived).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 2 * DAY);
    await archiver.checkDue();
    expect(channel.archived).toBe(true);
  });

  it("recovers an accepted notice after a lost send response without sending twice", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    const send = channel.send.getMockImplementation()!;
    channel.send.mockImplementationOnce(async (options) => {
      await send(options);
      throw new Error("response lost");
    });
    await service().observe(asThread(channel));
    vi.setSystemTime(Date.now() + 2 * DAY);
    await service().checkDue();
    expect(channel.send).toHaveBeenCalledOnce();
    expect(channel.archived).toBe(true);
  });

  it.each([2, 7])(
    "recovers a legacy %s-day notice and applies the two-day deadline",
    async (days) => {
      const channel = post();
      posts.set(channel.id, channel);
      const startedAt = Date.now();
      await channel.send({
        content: `此帖子已被标记为完成。若${days}天内无新问题则会被折叠（关闭）。`,
      });
      channel.send.mockClear();
      await writeFile(
        stateFile,
        JSON.stringify({
          version: 1,
          threads: { [channel.id]: { startedAt, handled: false } },
        }),
        "utf8",
      );
      vi.setSystemTime(startedAt + 2 * DAY);
      await service().start();
      expect(channel.send).not.toHaveBeenCalled();
      expect(channel.archived).toBe(true);
    },
  );

  it("retains failed archives for the next check", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    channel.setArchived.mockRejectedValueOnce(new Error("rate limited"));
    const archiver = service();
    await archiver.observe(asThread(channel));
    vi.setSystemTime(Date.now() + 2 * DAY);
    await archiver.checkDue();
    expect(channel.archived).toBe(false);
    await archiver.checkDue();
    expect(channel.archived).toBe(true);
  });

  it("enrolls unlinked active completed posts on startup and runs the minute check", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    const archiver = service();
    await archiver.start();
    expect(channel.send).toHaveBeenCalledOnce();
    const checkDue = archiver.checkDue.bind(archiver);
    const checked = new Promise<void>((resolve) => {
      vi.spyOn(archiver, "checkDue").mockImplementationOnce(async () => {
        await checkDue();
        resolve();
      });
    });
    vi.setSystemTime(Date.now() + 2 * DAY);
    await vi.advanceTimersByTimeAsync(60_000);
    // Fake clocks do not wait for real filesystem I/O inside timer callbacks.
    await checked;
    expect(channel.archived).toBe(true);
  });

  it("does not enroll posts in other forums or without a closed-state tag", async () => {
    const channel = post();
    channel.parentId = "unconfigured";
    const archiver = service();
    await archiver.observe(asThread(channel));
    channel.parentId = FORUM_ID;
    channel.appliedTags = ["triage"];
    await archiver.observe(asThread(channel));
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("removes deleted posts but retains records after temporary fetch failures", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    const archiver = service();
    await archiver.observe(asThread(channel));
    vi.mocked(client.channels.fetch).mockRejectedValueOnce(
      new Error("offline"),
    );
    vi.setSystemTime(Date.now() + 2 * DAY);
    await archiver.checkDue();
    await archiver.checkDue();
    expect(channel.archived).toBe(true);
    posts.delete(channel.id);
    await archiver.forget(channel.id);
    const restored = service();
    await restored.checkDue();
    expect(JSON.parse(await readFile(stateFile, "utf8")).threads).toEqual({});
  });

  it("refuses to overwrite invalid saved state or send notices without durable storage", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    await writeFile(stateFile, "broken json", "utf8");
    await service().observe(asThread(channel));
    expect(channel.send).not.toHaveBeenCalled();
    expect(await readFile(stateFile, "utf8")).toBe("broken json");
    expect(reportError).toHaveBeenCalled();
  });

  it("retries a failed cancellation write even when no countdowns remain in memory", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    const archiver = service();
    await archiver.observe(asThread(channel));
    await mkdir(`${stateFile}.tmp`);
    channel.appliedTags = [];
    await archiver.observe(asThread(channel));
    expect(reportError).toHaveBeenCalled();
    await rm(`${stateFile}.tmp`, { recursive: true });
    await archiver.checkDue();
    expect(JSON.parse(await readFile(stateFile, "utf8")).threads).toEqual({});
  });

  it("cleans up a deleted channel discovered during the periodic check", async () => {
    const channel = post();
    const archiver = service();
    await archiver.observe(asThread(channel));
    await archiver.checkDue();
    expect(JSON.parse(await readFile(stateFile, "utf8")).threads).toEqual({});
  });

  it("keeps the pending record when access is denied instead of treating it as deletion", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    const archiver = service();
    await archiver.observe(asThread(channel));
    vi.mocked(client.channels.fetch).mockRejectedValueOnce(
      Object.assign(new Error("Missing access"), { code: 50001 }),
    );
    vi.setSystemTime(Date.now() + 2 * DAY);
    await archiver.checkDue();
    expect(channel.archived).toBe(false);
    await service().checkDue();
    expect(channel.archived).toBe(true);
  });

  it("abandons an old deadline when reopen and recomplete arrive during the archive check", async () => {
    const channel = post();
    posts.set(channel.id, channel);
    const archiver = service();
    await archiver.observe(asThread(channel));
    vi.setSystemTime(Date.now() + 2 * DAY);
    const updates: Promise<void>[] = [];
    vi.mocked(client.channels.fetch).mockImplementationOnce(async () => {
      channel.appliedTags = [];
      updates.push(archiver.observe(asThread(channel)));
      channel.appliedTags = ["done"];
      updates.push(archiver.observe(asThread(channel)));
      return asThread(channel);
    });
    await archiver.checkDue();
    await Promise.all(updates);
    expect(channel.setArchived).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 2 * DAY);
    await archiver.checkDue();
    expect(channel.archived).toBe(true);
  });
});
