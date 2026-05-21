import { Request } from "express";
import {
  addClosedStateTag,
  archiveThread,
  createComment,
  createThread,
  deleteThread,
  lockThread,
  notifySubscribers,
  removeClosedStateTag,
  unarchiveThread,
  unlockThread,
} from "../discord/discordActions";
import { GitHubLabel } from "../interfaces";
import { store } from "../store";
import { ClosedReason } from "../tagMapping";
import { getDiscordInfoFromGithubBody } from "./githubActions";

function getIssueNodeId(req: Request): string | undefined {
  return req.body?.issue?.node_id;
}

export async function handleOpened(req: Request) {
  if (!req.body.issue) return;
  const { node_id, number, title, user, body, labels } = req.body.issue;
  // Loop guard: if body already references a Discord URL, this issue was created
  // from Discord by the bot — don't push it back to Discord.
  if (getDiscordInfoFromGithubBody(body).channelId) return;
  if (store.threads.some((thread) => thread.node_id === node_id)) return;

  const { login } = user;
  const appliedTags = (<GitHubLabel[]>labels)
    .map(
      (label) =>
        store.availableTags.find((tag) => tag.name === label.name)?.id || "",
    )
    .filter((i) => i);

  createThread({ login, appliedTags, number, title, body, node_id });
}

export async function handleCreated(req: Request) {
  const { user, id, body } = req.body.comment;
  const { login, avatar_url } = user;
  const { node_id } = req.body.issue;

  // Check if the comment already contains Discord info
  if (getDiscordInfoFromGithubBody(body).channelId) {
    // If it does, stop processing (assuming created with a bot)
    return;
  }

  createComment({
    git_id: id,
    body,
    login,
    avatar_url,
    node_id,
  });
}

export async function handleClosed(req: Request) {
  if (!req.body?.issue) return;
  const node_id = getIssueNodeId(req);
  const { number, title, html_url, state_reason } = req.body.issue;
  const reason: ClosedReason =
    state_reason === "not_planned" ? "not_planned" : "completed";

  // Apply the state tag first while the thread is still un-archived; setting
  // applied tags on an archived thread is fiddly.
  await addClosedStateTag(node_id, reason);
  archiveThread(node_id);

  notifySubscribers(
    node_id,
    `🔴 Issue #${number} "${title}" has been closed.\n${html_url}`,
  );
}

export async function handleReopened(req: Request) {
  if (!req.body?.issue) return;
  const node_id = getIssueNodeId(req);
  unarchiveThread(node_id);
  await removeClosedStateTag(node_id);

  const { number, title, html_url } = req.body.issue;
  notifySubscribers(
    node_id,
    `🟢 Issue #${number} "${title}" has been reopened.\n${html_url}`,
  );
}

export async function handleLocked(req: Request) {
  if (!req.body?.issue) return;
  lockThread(getIssueNodeId(req));
}

export async function handleUnlocked(req: Request) {
  if (!req.body?.issue) return;
  unlockThread(getIssueNodeId(req));
}

export async function handleDeleted(req: Request) {
  if (!req.body?.issue) return;
  deleteThread(getIssueNodeId(req));
}
