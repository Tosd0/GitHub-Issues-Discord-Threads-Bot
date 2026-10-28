import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "./knowledgeBase";

let directory: string;
let file: string;
let knowledge: KnowledgeBase;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "knowledge-test-"));
  file = join(directory, "data", "knowledge.json");
  knowledge = new KnowledgeBase(file);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("durable knowledge entries", () => {
  it("preserves text and names with spaces across restarts", async () => {
    await knowledge.add(
      "server-a",
      "debug panel",
      "打开面板：\nhttps://discord.com/channels/1/2\n",
    );
    const restarted = new KnowledgeBase(file);
    expect(await restarted.get("server-a", " DEBUG PANEL ")).toEqual({
      guildId: "server-a",
      name: "debug panel",
      text: "打开面板：\nhttps://discord.com/channels/1/2\n",
    });
  });

  it("isolates entries and search by server", async () => {
    await knowledge.add("server-a", "debug panel", "a");
    await knowledge.add("server-b", "debug panel", "b");
    expect((await knowledge.get("server-a", "debug panel"))?.text).toBe("a");
    expect(await knowledge.list("server-c")).toEqual([]);
    expect((await knowledge.search("server-b", "PANEL"))[0].text).toBe("b");
  });

  it("rejects duplicate names without replacing the original", async () => {
    await knowledge.add("server-a", "debug panel", "original");
    await expect(
      knowledge.add("server-a", "DEBUG PANEL", "replacement"),
    ).rejects.toThrow();
    expect((await knowledge.get("server-a", "debug panel"))?.text).toBe(
      "original",
    );
  });

  it("persists edits, renames, and deletions", async () => {
    await knowledge.add("server-a", "debug panel", "old");
    await knowledge.edit("server-a", "debug panel", "new");
    expect(
      (await new KnowledgeBase(file).get("server-a", "debug panel"))?.text,
    ).toBe("new");
    await knowledge.rename("server-a", "DEBUG PANEL", " Troubleshooting Panel ");
    expect(await knowledge.get("server-a", "debug panel")).toBeUndefined();
    expect(
      await new KnowledgeBase(file).get("server-a", "troubleshooting panel"),
    ).toEqual({
      guildId: "server-a",
      name: "Troubleshooting Panel",
      text: "new",
    });
    await knowledge.rename(
      "server-a",
      "troubleshooting panel",
      "troubleshooting panel",
    );
    expect(
      (await new KnowledgeBase(file).get("server-a", "troubleshooting panel"))
        ?.name,
    ).toBe("troubleshooting panel");
    await knowledge.add("server-a", "existing", "other");
    await expect(
      knowledge.rename("server-a", "troubleshooting panel", "EXISTING"),
    ).rejects.toThrow();
    await knowledge.delete("server-a", "troubleshooting panel");
    await knowledge.delete("server-a", "existing");
    expect(await new KnowledgeBase(file).list("server-a")).toEqual([]);
    await expect(
      knowledge.edit("server-a", "missing", "new"),
    ).rejects.toThrow();
    await expect(
      knowledge.rename("server-a", "missing", "renamed"),
    ).rejects.toThrow();
    await expect(knowledge.delete("server-a", "missing")).rejects.toThrow();
  });

  it("does not lose concurrent changes", async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        knowledge.add("server-a", `entry ${i}`, `${i}`),
      ),
    );
    expect(await new KnowledgeBase(file).list("server-a")).toHaveLength(30);
    expect(await knowledge.search("server-a", "entry", 25)).toHaveLength(25);
  });

  it.each([
    ["", "text"],
    ["   ", "text"],
    ["a".repeat(101), "text"],
    ["name", "   "],
    ["name", "a".repeat(2001)],
  ])("rejects unusable names or text", async (name, text) => {
    await expect(knowledge.add("server-a", name, text)).rejects.toThrow();
    expect(await knowledge.list("server-a")).toEqual([]);
  });

  it("leaves a corrupt file untouched", async () => {
    await mkdir(join(directory, "data"));
    await writeFile(file, "broken", "utf8");
    await expect(knowledge.add("server-a", "name", "text")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("broken");
  });

  it("does not report a successful mutation when persistence fails", async () => {
    await knowledge.add("server-a", "name", "original");
    await rm(file);
    await mkdir(file);
    await expect(
      knowledge.edit("server-a", "name", "changed"),
    ).rejects.toThrow();
    expect((await knowledge.get("server-a", "name"))?.text).toBe("original");
  });
});
