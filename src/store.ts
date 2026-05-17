import { GuildForumTag } from "discord.js";
import { Thread } from "./interfaces";

class Store {
  threads: Thread[] = [];
  private tagsByChannel: Map<string, GuildForumTag[]> = new Map();

  setChannelTags(channelId: string, tags: GuildForumTag[]) {
    this.tagsByChannel.set(channelId, tags);
  }

  get availableTags(): GuildForumTag[] {
    return Array.from(this.tagsByChannel.values()).flat();
  }

  deleteThread(id: string | undefined) {
    const index = this.threads.findIndex((obj) => obj.id === id);
    if (index !== -1) {
      this.threads.splice(index, 1);
    }
    return this.threads;
  }
}

export const store = new Store();
