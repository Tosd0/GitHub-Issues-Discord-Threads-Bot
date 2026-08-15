import { describe, expect, it } from "vitest";
import { parseDiscordPostId } from "./discordLinks";

const GUILD = "123456789012345678";
const POST = "987654321098765432";
const MESSAGE = "111111111111111111";

describe("parseDiscordPostId", () => {
  it("reads the post id out of a post link", () => {
    expect(
      parseDiscordPostId(`https://discord.com/channels/${GUILD}/${POST}`),
    ).toBe(POST);
  });

  it("reads the post id out of a message link, ignoring the message id", () => {
    expect(
      parseDiscordPostId(
        `https://discord.com/channels/${GUILD}/${POST}/${MESSAGE}`,
      ),
    ).toBe(POST);
  });

  it("accepts a bare post id", () => {
    expect(parseDiscordPostId(POST)).toBe(POST);
  });

  it("accepts the link forms Discord clients produce", () => {
    const variants = [
      `https://canary.discord.com/channels/${GUILD}/${POST}`,
      `https://ptb.discord.com/channels/${GUILD}/${POST}`,
      `https://discordapp.com/channels/${GUILD}/${POST}`,
      `http://discord.com/channels/${GUILD}/${POST}`,
      `https://discord.com/channels/@me/${POST}`,
      `  https://discord.com/channels/${GUILD}/${POST}  `,
    ];
    for (const variant of variants) {
      expect(parseDiscordPostId(variant), variant).toBe(POST);
    }
  });

  it("rejects input that is not a Discord link or id", () => {
    const rejected = [
      "",
      "   ",
      "not a link",
      "12345",
      `https://example.com/channels/${GUILD}/${POST}`,
      // A guild link has no post segment.
      `https://discord.com/channels/${GUILD}`,
      // Look-alike hosts must not pass.
      `https://discord.com.evil.test/channels/${GUILD}/${POST}`,
      `https://notdiscord.com/channels/${GUILD}/${POST}`,
      // Nor may a real link smuggled into some other URL: the pattern has to
      // match from the very start of the input, not just somewhere inside it.
      `https://evil.test/go?to=https://discord.com/channels/${GUILD}/${POST}`,
    ];
    for (const input of rejected) {
      expect(parseDiscordPostId(input), input).toBeUndefined();
    }
  });
});
