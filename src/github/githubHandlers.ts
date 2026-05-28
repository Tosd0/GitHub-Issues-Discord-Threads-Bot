import { Request } from "express";
import {
  addClosedStateTag,
  archiveThread,
  createComment,
  deleteThread,
  lockThread,
  notifySubscribers,
  reactToThreadStarter,
  removeClosedStateTag,
  syncIssueLabelTag,
  unarchiveThread,
  unlockThread,
} from "../discord/discordActions";
import { ClosedReason } from "../tagMapping";
import { getDiscordInfoFromGithubBody } from "./githubActions";

function getIssueNodeId(req: Request): string | undefined {
  return req.body?.issue?.node_id;
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
  await archiveThread(node_id);
  await reactToThreadStarter(
    node_id,
    state_reason === "not_planned" ? "❌" : "✅",
    "👀",
  );

  await notifySubscribers(
    node_id,
    `🔴 Issue #${number} "${title}" has been closed.\n${html_url}`,
  );
}

export async function handleReopened(req: Request) {
  if (!req.body?.issue) return;

  const node_id = getIssueNodeId(req);
  await unarchiveThread(node_id);
  await removeClosedStateTag(node_id);

  const { number, title, html_url } = req.body.issue;
  await notifySubscribers(
    node_id,
    `🟢 Issue #${number} "${title}" has been reopened.\n${html_url}`,
  );
}

export async function handleLabeled(req: Request) {
  if (!req.body?.issue) return;
  await syncIssueLabelTag(getIssueNodeId(req), req.body.label?.name, "add");
}

export async function handleUnlabeled(req: Request) {
  if (!req.body?.issue) return;
  await syncIssueLabelTag(getIssueNodeId(req), req.body.label?.name, "remove");
}

export async function handleLocked(req: Request) {
  if (!req.body?.issue) return;
  await lockThread(getIssueNodeId(req));
}

export async function handleUnlocked(req: Request) {
  if (!req.body?.issue) return;
  await unlockThread(getIssueNodeId(req));
}

export async function handleDeleted(req: Request) {
  if (!req.body?.issue) return;
  await deleteThread(getIssueNodeId(req));
}
