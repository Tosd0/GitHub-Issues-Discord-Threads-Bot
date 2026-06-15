import { Request } from "express";
import {
  addClosedStateTag,
  createComment,
  deleteThread,
  lockThread,
  notifySubscribers,
  reactToThreadStarter,
  removeClosedStateTag,
  syncIssueLabelTag,
  unlockThread,
} from "../discord/discordActions";
import { ClosedReason, getClosedReasonFromGithubLabels } from "../tagMapping";
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
  const { number, title, html_url, state_reason, labels } = req.body.issue;
  // GitHub records only "completed"/"not_planned". A "not_planned" close maps
  // back to a custom reason (e.g. "duplicate") when that reason's mirror label
  // is present on the issue.
  const labelNames: string[] = Array.isArray(labels)
    ? labels
        .map((label: { name?: string }) => label?.name)
        .filter((name: string | undefined): name is string => Boolean(name))
    : [];
  const reason: ClosedReason =
    state_reason === "not_planned"
      ? getClosedReasonFromGithubLabels(labelNames) ?? "not_planned"
      : "completed";

  // The closed-state tag is the single source of truth for issue state; we do
  // NOT archive the thread. A forum thread auto-unarchives on any new message,
  // and syncing that unarchive back to GitHub used to reopen the issue.
  await addClosedStateTag(node_id, reason);
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
