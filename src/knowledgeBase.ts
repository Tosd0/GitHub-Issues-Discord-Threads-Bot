import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface KnowledgeEntry {
  guildId: string;
  name: string;
  text: string;
}

export class KnowledgeInputError extends Error {}

function normalizeName(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

function entryKey(guildId: string, name: string): string {
  return JSON.stringify([guildId, normalizeName(name)]);
}

function validateName(guildId: string, name: string) {
  if (
    !guildId ||
    !name.trim() ||
    name.trim().length > 100 ||
    /[\r\n\t]/.test(name)
  ) {
    throw new KnowledgeInputError(
      "名称需要 1～100 个字符，不能包含换行或制表符。",
    );
  }
}

function validateEntry(guildId: string, name: string, text: string) {
  validateName(guildId, name);
  if (!text.trim() || text.length > 2000) {
    throw new KnowledgeInputError("内容不能为空，最多 2000 个字符。");
  }
}

/** Single-process storage. Publish memory changes only after an atomic disk write. */
export class KnowledgeBase {
  private entries = new Map<string, KnowledgeEntry>();
  private loading?: Promise<void>;
  private pending: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private load(): Promise<void> {
    this.loading ??= this.readEntries();
    return this.loading;
  }

  private async readEntries() {
    let source: string;
    try {
      source = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const data = JSON.parse(source);
    if (data?.version !== 1 || !Array.isArray(data.entries)) {
      throw new Error("Invalid knowledge base file");
    }
    const entries = new Map<string, KnowledgeEntry>();
    for (const entry of data.entries) {
      if (
        typeof entry?.guildId !== "string" ||
        typeof entry?.name !== "string" ||
        typeof entry?.text !== "string"
      )
        throw new Error("Invalid knowledge entry");
      validateEntry(entry.guildId, entry.name, entry.text);
      const key = entryKey(entry.guildId, entry.name);
      if (entries.has(key))
        throw new Error("Duplicate knowledge entry in file");
      entries.set(key, {
        guildId: entry.guildId,
        name: entry.name.trim(),
        text: entry.text,
      });
    }
    this.entries = entries;
  }

  private mutate(
    // eslint-disable-next-line no-unused-vars
    change: (entries: Map<string, KnowledgeEntry>) => void,
  ): Promise<void> {
    const operation = this.pending.then(async () => {
      await this.load();
      const entries = new Map(this.entries);
      change(entries);
      await mkdir(dirname(this.file), { recursive: true });
      const temporaryFile = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporaryFile,
          JSON.stringify(
            { version: 1, entries: [...entries.values()] },
            null,
            2,
          ) + "\n",
          { encoding: "utf8", mode: 0o600 },
        );
        await rename(temporaryFile, this.file);
      } finally {
        await rm(temporaryFile, { force: true });
      }
      this.entries = entries;
    });
    // A failed write must not prevent later commands from being processed.
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  async add(guildId: string, name: string, text: string): Promise<void> {
    validateEntry(guildId, name, text);
    return this.mutate((entries) => {
      const key = entryKey(guildId, name);
      if (entries.has(key))
        throw new KnowledgeInputError(
          "这个名称已经存在，请使用 /knowledge edit 修改。",
        );
      entries.set(key, { guildId, name: name.trim(), text });
    });
  }

  async edit(guildId: string, name: string, text: string): Promise<void> {
    validateEntry(guildId, name, text);
    return this.mutate((entries) => {
      const key = entryKey(guildId, name);
      const entry = entries.get(key);
      if (!entry) throw new KnowledgeInputError("找不到这个知识库条目。");
      entries.set(key, { ...entry, text });
    });
  }

  async rename(guildId: string, name: string, newName: string): Promise<void> {
    validateName(guildId, newName);
    return this.mutate((entries) => {
      const oldKey = entryKey(guildId, name);
      const entry = entries.get(oldKey);
      if (!entry) throw new KnowledgeInputError("找不到这个知识库条目。");
      const newKey = entryKey(guildId, newName);
      if (newKey !== oldKey && entries.has(newKey))
        throw new KnowledgeInputError("这个名称已经存在。");
      entries.delete(oldKey);
      entries.set(newKey, { ...entry, name: newName.trim() });
    });
  }

  async delete(guildId: string, name: string): Promise<void> {
    return this.mutate((entries) => {
      if (!entries.delete(entryKey(guildId, name)))
        throw new KnowledgeInputError("找不到这个知识库条目。");
    });
  }

  async get(
    guildId: string,
    name: string,
  ): Promise<KnowledgeEntry | undefined> {
    await this.pending;
    await this.load();
    const entry = this.entries.get(entryKey(guildId, name));
    return entry ? { ...entry } : undefined;
  }

  async list(guildId: string): Promise<KnowledgeEntry[]> {
    await this.pending;
    await this.load();
    return [...this.entries.values()]
      .filter((entry) => entry.guildId === guildId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({ ...entry }));
  }

  async search(
    guildId: string,
    query: string,
    limit = 25,
  ): Promise<KnowledgeEntry[]> {
    const normalizedQuery = normalizeName(query);
    return (await this.list(guildId))
      .filter((entry) => normalizeName(entry.name).includes(normalizedQuery))
      .slice(0, limit);
  }
}
