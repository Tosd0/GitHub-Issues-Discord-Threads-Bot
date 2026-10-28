import { afterEach, expect, it, vi } from "vitest";
import { Events, AnyThreadChannel } from "discord.js";
import client, { completionArchiver, initDiscord } from "./discord";

vi.mock("./discordHandlers", () => ({
  handleClientReady: vi.fn(),
  handleThreadCreate: vi.fn(),
  handleThreadUpdate: vi.fn(),
  handleChannelUpdate: vi.fn(),
  handleThreadDelete: vi.fn(),
  handleMessageDelete: vi.fn(),
  handleInteractionCreate: vi.fn(),
}));

afterEach(() => {
  client.removeAllListeners();
  vi.restoreAllMocks();
});

it("does not enroll an old completed post just because it was manually archived", async () => {
  vi.spyOn(client, "login").mockResolvedValue("test-token");
  const observe = vi.spyOn(completionArchiver, "observe").mockResolvedValue();
  initDiscord();
  const old = {
    id: "700000000000000000",
    parentId: "100000000000000000",
    appliedTags: ["done"],
    archived: false,
  } as AnyThreadChannel;
  const current = { ...old, archived: true } as AnyThreadChannel;
  client.emit(Events.ThreadUpdate, old, current);
  expect(observe).toHaveBeenCalledWith(current, false);
});

it("captures completion changes before queuing GitHub sync can lose a rapid reopen", async () => {
  vi.spyOn(client, "login").mockResolvedValue("test-token");
  const observed: string[][] = [];
  vi.spyOn(completionArchiver, "observe").mockImplementation(
    async (channel) => {
      observed.push([...channel.appliedTags]);
    },
  );
  initDiscord();
  const channel = {
    id: "700000000000000000",
    parentId: "100000000000000000",
    appliedTags: [] as string[],
  } as AnyThreadChannel;
  client.emit(Events.ThreadUpdate, channel, channel);
  channel.appliedTags = ["done"];
  client.emit(Events.ThreadUpdate, channel, channel);
  await Promise.resolve();
  expect(observed).toEqual([[], ["done"]]);
});
