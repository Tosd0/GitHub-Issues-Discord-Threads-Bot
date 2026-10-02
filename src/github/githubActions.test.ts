import { afterEach, describe, expect, it, vi } from "vitest";
import { Thread } from "../interfaces";
import { octokit, openIssue, unlockIssue } from "./githubActions";

const thread: Thread = {
  id: "700000000000000000",
  title: "a post",
  number: 42,
  appliedTags: [],
  comments: [],
  archived: false,
  locked: true,
};

afterEach(() => vi.restoreAllMocks());

describe("GitHub reopen results", () => {
  it("reports success and removes the old close-reason label", async () => {
    const update = vi
      .spyOn(octokit.rest.issues, "update")
      .mockResolvedValue({} as never);
    const remove = vi
      .spyOn(octokit.rest.issues, "removeLabel")
      .mockResolvedValue({} as never);
    await expect(openIssue(thread)).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, state: "open" }),
    );
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, name: "duplicate" }),
    );
  });

  it("reports an API failure and keeps the close-reason label", async () => {
    vi.spyOn(octokit.rest.issues, "update").mockRejectedValue(
      new Error("GitHub unavailable"),
    );
    const remove = vi.spyOn(octokit.rest.issues, "removeLabel");
    await expect(openIssue(thread)).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports successful unlocks", async () => {
    vi.spyOn(octokit.rest.issues, "unlock").mockResolvedValue({} as never);
    await expect(unlockIssue(thread)).resolves.toBe(true);
  });

  it("reports failed unlocks", async () => {
    vi.spyOn(octokit.rest.issues, "unlock").mockRejectedValue(
      new Error("GitHub unavailable"),
    );
    await expect(unlockIssue(thread)).resolves.toBe(false);
  });

  it.each([openIssue, unlockIssue])(
    "rejects unlinked posts",
    async (action) => {
      await expect(action({ ...thread, number: undefined })).resolves.toBe(
        false,
      );
    },
  );
});
