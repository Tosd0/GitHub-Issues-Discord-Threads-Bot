import { describe, expect, it } from "vitest";
import { isBotAuthoredIssueComment, markAsBotComment } from "./botComments";

describe("bot-authored issue comments", () => {
  it("recognizes a body it marked itself", () => {
    // The mirror in handleCreated relies on this: without it the bot's own
    // note is copied back into the forum post it was written for.
    expect(
      isBotAuthoredIssueComment(markAsBotComment("Duplicate of #12")),
    ).toBe(true);
  });

  it("keeps the original text intact", () => {
    expect(markAsBotComment("Duplicate of #12")).toContain("Duplicate of #12");
  });

  it("does not claim ordinary comments", () => {
    const humanBodies = [
      "Duplicate of #12",
      "looks like a dupe of #12",
      "",
      null,
      undefined,
    ];
    for (const body of humanBodies) {
      expect(isBotAuthoredIssueComment(body), String(body)).toBe(false);
    }
  });
});
