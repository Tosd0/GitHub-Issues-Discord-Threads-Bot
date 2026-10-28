import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Client, ThreadChannel, ForumChannel, Message } from "discord.js";
import { config } from "../config";
import { tagMapping } from "../tagMapping";
import { createSerialQueue } from "../utils/serialQueue";

function closureNotice(tagName: string): string {
  return `此帖子已被标记为${tagName}。若2天内无新问题则会被折叠（关闭）。`;
}

// Recover pending deliveries from older versions without sending twice.
const LEGACY_COMPLETION_NOTICES = [
  "此帖子已被标记为完成。若2天内无新问题则会被折叠（关闭）。",
  "此帖子已被标记为完成。若7天内无新问题则会被折叠（关闭）。",
];
const ARCHIVE_DELAY = 2 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL = 60_000;

interface CompletionRecord {
  startedAt: number;
  noticeId?: string;
  notifiedAt?: number;
  handled: boolean;
}

// eslint-disable-next-line no-unused-vars
type ReportError = (message: string) => void;

function isRecord(value: unknown): value is CompletionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as CompletionRecord;
  return (
    Number.isFinite(record.startedAt) &&
    record.startedAt >= 0 &&
    typeof record.handled === "boolean" &&
    ((record.noticeId === undefined &&
      record.notifiedAt === undefined &&
      !record.handled) ||
      (typeof record.noticeId === "string" &&
        Number.isFinite(record.notifiedAt) &&
        record.notifiedAt! >= 0))
  );
}

function getClosedTagName(channel: ThreadChannel): string | undefined {
  if (
    !channel.parentId ||
    !config.DISCORD_CHANNEL_IDS.includes(channel.parentId)
  )
    return;
  const forum = channel.parent;
  if (!(forum instanceof ForumChannel)) return;
  return forum.availableTags.find(
    (tag) =>
      Object.values(tagMapping.closedState).includes(tag.name) &&
      channel.appliedTags.includes(tag.id),
  )?.name;
}

export class CompletedThreadArchiver {
  private records = new Map<string, CompletionRecord>();
  private revisions = new Map<string, number>();
  private loaded?: Promise<void>;
  // Serialize state writes and notice delivery, including gateway/command echoes.
  private enqueue = createSerialQueue<string>();
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  private dirty = false;
  private client: Client;
  private stateFile: string;
  private reportError: ReportError;

  constructor(client: Client, stateFile: string, reportError: ReportError) {
    this.client = client;
    this.stateFile = stateFile;
    this.reportError = reportError;
  }

  observe(channel: ThreadChannel, allowNewNotice = true): Promise<void> {
    // Snapshot before queuing: discord.js can mutate cached channel objects.
    const closedTagName = getClosedTagName(channel);
    this.revisions.set(channel.id, (this.revisions.get(channel.id) ?? 0) + 1);
    return this.run(async () => {
      if (!closedTagName) {
        await this.remove(channel.id);
        return;
      }
      const existing = this.records.get(channel.id);
      if (!allowNewNotice && existing?.notifiedAt === undefined) return;
      const record = existing ?? { startedAt: Date.now(), handled: false };
      this.records.set(channel.id, record);
      await this.ensureNotice(channel, record, !!existing, closedTagName);
    });
  }

  forget(threadId: string): Promise<void> {
    this.revisions.delete(threadId);
    return this.run(() => this.remove(threadId));
  }

  async start(): Promise<void> {
    if (this.timer) return;
    // Discover active posts independently of the GitHub issue cache. Historical
    // archived posts are only visited if they already have a saved countdown.
    for (const forumId of config.DISCORD_CHANNEL_IDS) {
      try {
        const forum = (await this.client.channels.fetch(
          forumId,
        )) as ForumChannel | null;
        if (!forum) continue;
        const { threads } = await forum.threads.fetchActive();
        for (const channel of threads.values()) await this.observe(channel);
      } catch (err) {
        this.report(err);
      }
    }
    await this.checkDue();
    this.timer = setInterval(() => void this.checkDue(), CHECK_INTERVAL);
    this.timer.unref();
  }

  async checkDue(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      let ids: string[] = [];
      await this.run(async () => {
        ids = [...this.records.entries()]
          .filter(([, record]) => !record.handled)
          .map(([id]) => id);
      });
      for (const id of ids) {
        // Let tag events run between requests instead of blocking a whole sweep.
        await this.run(async () => {
          const record = this.records.get(id);
          if (!record || record.handled) return;
          const revision = this.revisions.get(id);
          const channel = await this.fetchThread(id);
          if (!channel) return;
          if (revision !== this.revisions.get(id)) return;
          const closedTagName = getClosedTagName(channel);
          if (!closedTagName) {
            await this.remove(id);
            return;
          }
          // Manual closure takes precedence over retrying an unsent notice.
          if (channel.archived && record.notifiedAt === undefined) return;
          await this.ensureNotice(channel, record, true, closedTagName);
          if (
            record.notifiedAt === undefined ||
            Date.now() - record.notifiedAt < ARCHIVE_DELAY
          )
            return;

          // Never archive against an unsaved notice or stale cached tags.
          await this.persist();
          const latest = await this.fetchThread(id);
          if (!latest) return;
          // A queued reopen/recomplete must supersede this cycle even when the
          // freshly fetched tags happen to contain a closed-state tag again.
          if (revision !== this.revisions.get(id)) return;
          if (!getClosedTagName(latest)) {
            await this.remove(id);
            return;
          }
          if (!latest.archived) await latest.setArchived(true);
          record.handled = true;
          // Retain this marker until all closed-state tags are removed. Replying to
          // an archived post must not start another countdown or close it again.
          await this.persist();
        });
      }
    } finally {
      this.checking = false;
    }
  }

  private async fetchThread(id: string): Promise<ThreadChannel | null> {
    try {
      const channel = await this.client.channels.fetch(id, { force: true });
      if (channel?.isThread()) return channel;
      await this.remove(id);
      return null;
    } catch (err) {
      if ((err as { code?: number }).code !== 10003) throw err;
      await this.remove(id);
      return null;
    }
  }

  private async ensureNotice(
    channel: ThreadChannel,
    record: CompletionRecord,
    recover: boolean,
    closedTagName: string,
  ) {
    if (record.notifiedAt !== undefined) return;
    // Save a pending record before sending. On a crash/lost response, find our
    // already-delivered message instead of sending a second copy.
    await this.persist();
    const previous = recover
      ? await this.findNotice(channel, record.startedAt)
      : undefined;
    const notice =
      previous ??
      (await channel.send({
        content: closureNotice(closedTagName),
        allowedMentions: { parse: [] },
      }));
    record.noticeId = notice.id;
    record.notifiedAt = notice.createdTimestamp;
    await this.persist();
  }

  private async findNotice(
    channel: ThreadChannel,
    startedAt: number,
  ): Promise<Message | undefined> {
    const notices = new Set([
      ...LEGACY_COMPLETION_NOTICES,
      ...Object.values(tagMapping.closedState).map(closureNotice),
    ]);
    let before: string | undefined;
    do {
      const messages = await channel.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });
      const notice = messages.find(
        (message) =>
          message.author.id === this.client.user?.id &&
          notices.has(message.content) &&
          message.createdTimestamp >= startedAt,
      );
      if (notice) return notice;
      const oldest = messages.last();
      if (messages.size < 100 || !oldest || oldest.createdTimestamp < startedAt)
        return;
      before = oldest.id;
    } while (before);
  }

  private async remove(id: string) {
    if (this.records.delete(id)) await this.persist();
  }

  private run(action: () => Promise<void>): Promise<void> {
    return this.enqueue("state", async () => {
      this.loaded ??= this.load();
      await this.loaded;
      if (this.dirty) await this.persist();
      await action();
    }).catch((err) => this.report(err));
  }

  private report(err: unknown) {
    this.reportError(
      `Closed-post archiving failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  private async load() {
    let text: string;
    try {
      text = await readFile(this.stateFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const state = JSON.parse(text);
    if (
      state?.version !== 1 ||
      !state.threads ||
      typeof state.threads !== "object" ||
      Array.isArray(state.threads) ||
      !Object.values(state.threads).every(isRecord)
    ) {
      throw new Error(
        `Invalid completion state in ${this.stateFile}; refusing to overwrite it`,
      );
    }
    this.records = new Map(Object.entries(state.threads));
  }

  private async persist() {
    this.dirty = true;
    await mkdir(dirname(this.stateFile), { recursive: true });
    const temporaryFile = `${this.stateFile}.tmp`;
    await writeFile(
      temporaryFile,
      JSON.stringify(
        {
          version: 1,
          threads: Object.fromEntries(this.records),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await rename(temporaryFile, this.stateFile);
    this.dirty = false;
  }
}
