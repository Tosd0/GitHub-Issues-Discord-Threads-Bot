import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import { Attachment, Collection, Message } from "discord.js";
import { config } from "../config";
import { GitIssue, Thread } from "../interfaces";
import {
  ActionValue,
  Actions,
  Triggerer,
  getGithubUrl,
  logger,
} from "../logger";
import { store } from "../store";

export const octokit = new Octokit({
  auth: config.GITHUB_ACCESS_TOKEN,
  baseUrl: "https://api.github.com",
});

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token  ${process.env.GITHUB_ACCESS_TOKEN}`,
  },
});

export const repoCredentials = {
  owner: config.GITHUB_USERNAME,
  repo: config.GITHUB_REPOSITORY,
};

const info = (action: ActionValue, thread: Thread) =>
  logger.info(`${Triggerer.Discord} | ${action} | ${getGithubUrl(thread)}`);
const error = (action: ActionValue | string, thread?: Thread) =>
  logger.error(
    `${Triggerer.Discord} | ${action} ` +
      (thread ? `| ${getGithubUrl(thread)}` : ""),
  );

function attachmentsToMarkdown(attachments: Collection<string, Attachment>) {
  let md = "";
  attachments.forEach(({ url, name, contentType }) => {
    switch (contentType) {
      case "image/png":
      case "image/jpeg":
        md += `![${name}](${url} "${name}")`;
        break;
    }
  });
  return md;
}

function getIssueBody(params: Message) {
  const { guildId, channelId, id, content, author, attachments } = params;
  const displayName = author.globalName ?? author.username;
  const discordUrl = `https://discord.com/channels/${guildId}/${channelId}/${id}`;
  const avatarImg = author.avatar
    ? `<img src="https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.webp?size=40" width="20" height="20" align="absmiddle" /> `
    : "";
  const attachmentsMd = attachmentsToMarkdown(attachments);

  const sections = [
    "> Generated from Discord",
    `**From (Discord):** ${avatarImg}${displayName}`,
    "---",
    content,
  ];
  if (attachmentsMd) sections.push(attachmentsMd);
  sections.push("---", discordUrl);

  return sections.join("\n\n") + "\n";
}

const regexForDiscordCredentials =
  /https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;
export function getDiscordInfoFromGithubBody(body: string | null | undefined) {
  if (!body) return { channelId: undefined, id: undefined };
  const match = body.match(regexForDiscordCredentials);
  if (!match || match.length !== 4)
    return { channelId: undefined, id: undefined };
  const [, , channelId, id] = match;
  return { channelId, id };
}

function formatIssuesToThreads(issues: GitIssue[]): Thread[] {
  const res: Thread[] = [];
  issues.forEach(({ title, body, number, node_id, locked, state }) => {
    const { id } = getDiscordInfoFromGithubBody(body);
    if (!id) return;
    res.push({
      id,
      title,
      number,
      body: body ?? undefined,
      node_id,
      locked,
      comments: [],
      appliedTags: [],
      archived: state === "closed",
    });
  });
  return res;
}

async function update(issue_number: number, state: "open" | "closed") {
  try {
    await octokit.rest.issues.update({
      ...repoCredentials,
      issue_number,
      state,
    });
    return true;
  } catch (err) {
    return err;
  }
}

export async function closeIssue(thread: Thread) {
  const { number: issue_number } = thread;

  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  const response = await update(issue_number, "closed");
  if (response === true) info(Actions.Closed, thread);
  else if (response instanceof Error)
    error(`Failed to close issue: ${response.message}`, thread);
  else error("Failed to close issue due to an unknown error", thread);
}

export async function openIssue(thread: Thread) {
  const { number: issue_number } = thread;

  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  const response = await update(issue_number, "open");
  if (response === true) info(Actions.Reopened, thread);
  else if (response instanceof Error)
    error(`Failed to open issue: ${response.message}`, thread);
  else error("Failed to open issue due to an unknown error", thread);
}

export async function lockIssue(thread: Thread) {
  const { number: issue_number } = thread;
  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  try {
    await octokit.rest.issues.lock({
      ...repoCredentials,
      issue_number,
    });

    info(Actions.Locked, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to lock issue: ${err.message}`, thread);
    } else {
      error("Failed to lock issue due to an unknown error", thread);
    }
  }
}

export async function unlockIssue(thread: Thread) {
  const { number: issue_number } = thread;
  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  try {
    await octokit.rest.issues.unlock({
      ...repoCredentials,
      issue_number,
    });

    info(Actions.Unlocked, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to unlock issue: ${err.message}`, thread);
    } else {
      error("Failed to unlock issue due to an unknown error", thread);
    }
  }
}

export async function createIssue(thread: Thread, params: Message) {
  const { title, appliedTags, number } = thread;

  if (number) {
    error("Thread already has an issue number", thread);
    return;
  }

  try {
    const labels = appliedTags?.map(
      (id) => store.availableTags.find((item) => item.id === id)?.name || "",
    );

    const body = getIssueBody(params);
    const response = await octokit.rest.issues.create({
      ...repoCredentials,
      labels,
      title,
      body,
    });

    if (response && response.data) {
      thread.node_id = response.data.node_id;
      thread.body = response.data.body!;
      thread.number = response.data.number;
      info(Actions.Created, thread);
    } else {
      error("Failed to create issue - No response data", thread);
    }
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to create issue: ${err.message}`, thread);
    } else {
      error("Failed to create issue due to an unknown error", thread);
    }
  }
}

export type LinkIssueResult =
  | { ok: true }
  | { ok: false; reason: string; code?: "not_found" | "already_linked" };

export async function linkIssue(
  thread: Thread,
  issue_number: number,
  starter: Message,
): Promise<LinkIssueResult> {
  let issueData;
  try {
    const { data } = await octokit.rest.issues.get({
      ...repoCredentials,
      issue_number,
    });
    issueData = data;
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 404) {
      return {
        ok: false,
        code: "not_found",
        reason: `Issue #${issue_number} was not found.`,
      };
    }
    const message = err instanceof Error ? err.message : "unknown error";
    error(`Failed to fetch issue #${issue_number}: ${message}`, thread);
    return { ok: false, reason: message };
  }

  const existingDiscord = getDiscordInfoFromGithubBody(issueData.body);
  if (
    existingDiscord.channelId &&
    existingDiscord.channelId !== thread.id
  ) {
    return {
      ok: false,
      code: "already_linked",
      reason: `Issue #${issue_number} is already linked to another Discord post.`,
    };
  }

  let body = issueData.body ?? "";
  if (!existingDiscord.id) {
    const discordUrl = `https://discord.com/channels/${starter.guildId}/${starter.channelId}/${starter.id}`;
    body =
      body.length > 0
        ? `${body}\n\n---\n\n${discordUrl}\n`
        : `${discordUrl}\n`;

    try {
      await octokit.rest.issues.update({
        ...repoCredentials,
        issue_number,
        body,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      error(
        `Failed to update issue #${issue_number} body: ${message}`,
        thread,
      );
      return { ok: false, reason: message };
    }
  }

  thread.number = issueData.number;
  thread.node_id = issueData.node_id;
  thread.body = body;
  thread.locked = issueData.locked;
  thread.archived = issueData.state === "closed";

  try {
    const comments = await octokit.paginate(
      octokit.rest.issues.listComments,
      { ...repoCredentials, issue_number, per_page: 100 },
    );
    for (const comment of comments) {
      const { channelId, id } = getDiscordInfoFromGithubBody(comment.body);
      if (!id || channelId !== thread.id) continue;
      if (thread.comments.some((c) => c.id === id)) continue;
      thread.comments.push({ id, git_id: comment.id });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    error(
      `Linked, but failed to load existing comments for #${issue_number}: ${message}`,
      thread,
    );
  }

  info(Actions.Linked, thread);
  return { ok: true };
}

export type UnlinkIssueResult =
  | { ok: true }
  | { ok: false; reason: string };

function stripDiscordMarker(body: string): string {
  const match = regexForDiscordCredentials.exec(body);
  if (!match || match.index === undefined) return body;

  const after = body.slice(match.index + match[0].length);
  if (after.trim().length > 0) return body;

  let cutoff = match.index;
  const sep = body.slice(0, cutoff).match(/\n+---\n+$/);
  if (sep) cutoff -= sep[0].length;

  return body.slice(0, cutoff).trimEnd();
}

export async function unlinkIssue(thread: Thread): Promise<UnlinkIssueResult> {
  const issue_number = thread.number;
  if (!issue_number) {
    return { ok: false, reason: "This post is not linked to a GitHub issue." };
  }

  let currentBody: string;
  try {
    const { data } = await octokit.rest.issues.get({
      ...repoCredentials,
      issue_number,
    });
    currentBody = data.body ?? "";
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    error(`Failed to fetch issue #${issue_number}: ${message}`, thread);
    return { ok: false, reason: message };
  }

  const newBody = stripDiscordMarker(currentBody);
  if (newBody !== currentBody) {
    try {
      await octokit.rest.issues.update({
        ...repoCredentials,
        issue_number,
        body: newBody,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      error(
        `Failed to update issue #${issue_number} body: ${message}`,
        thread,
      );
      return { ok: false, reason: message };
    }
  }

  thread.number = undefined;
  thread.node_id = undefined;
  thread.body = undefined;
  thread.comments = [];

  return { ok: true };
}

let cachedLabels: { names: string[]; fetchedAt: number } | null = null;
const LABEL_CACHE_TTL = 5 * 60 * 1000;

export async function listRepoLabels(): Promise<string[]> {
  if (cachedLabels && Date.now() - cachedLabels.fetchedAt < LABEL_CACHE_TTL) {
    return cachedLabels.names;
  }

  try {
    const labels = await octokit.paginate(
      octokit.rest.issues.listLabelsForRepo,
      { ...repoCredentials, per_page: 100 },
    );
    const names = labels.map((label) => label.name);
    cachedLabels = { names, fetchedAt: Date.now() };
    return names;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    error(`Failed to list repository labels: ${message}`);
    return cachedLabels?.names ?? [];
  }
}

export async function addLabelsToIssue(
  thread: Thread,
  labels: string[],
): Promise<boolean> {
  const { number: issue_number } = thread;
  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return false;
  }

  try {
    await octokit.rest.issues.addLabels({
      ...repoCredentials,
      issue_number,
      labels,
    });
    cachedLabels = null;
    info(Actions.Labeled, thread);
    return true;
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to add labels: ${err.message}`, thread);
    } else {
      error("Failed to add labels due to an unknown error", thread);
    }
    return false;
  }
}

export async function createIssueComment(thread: Thread, params: Message) {
  const body = getIssueBody(params);
  const { number: issue_number } = thread;

  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  try {
    const response = await octokit.rest.issues.createComment({
      ...repoCredentials,
      issue_number: thread.number!,
      body,
    });
    if (response && response.data) {
      const git_id = response.data.id;
      const id = params.id;
      thread.comments.push({ id, git_id });
      info(Actions.Commented, thread);
    } else {
      error("Failed to create comment - No response data", thread);
    }
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to create comment: ${err.message}`, thread);
    } else {
      error("Failed to create comment due to an unknown error", thread);
    }
  }
}

export async function deleteIssue(thread: Thread) {
  const { node_id } = thread;
  if (!node_id) {
    error("Thread does not have a node ID", thread);
    return;
  }

  try {
    await graphqlWithAuth(
      `mutation {deleteIssue(input: {issueId: "${node_id}"}) {clientMutationId}}`,
    );
    info(Actions.Deleted, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Error deleting issue: ${err.message}`, thread);
    } else {
      error("Error deleting issue due to an unknown error", thread);
    }
  }
}

export async function deleteComment(thread: Thread, comment_id: number) {
  try {
    await octokit.rest.issues.deleteComment({
      ...repoCredentials,
      comment_id,
    });
    info(Actions.DeletedComment, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to delete comment: ${err.message}`, thread);
    } else {
      error("Failed to delete comment due to an unknown error", thread);
    }
  }
}

export async function getIssues() {
  try {
    const response = await octokit.rest.issues.listForRepo({
      ...repoCredentials,
      state: "all",
    });

    if (!response || !response.data) {
      error("Failed to get issues - No response data");
      return [];
    }

    await fillCommentsData(); // Wait for comments data to be filled

    return formatIssuesToThreads(response.data as GitIssue[]);
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to get issues: ${err.message}`);
    } else {
      error("Failed to get issues due to an unknown error");
    }
    return [];
  }
}

async function fillCommentsData() {
  try {
    const response = await octokit.rest.issues.listCommentsForRepo({
      ...repoCredentials,
    });

    if (response && response.data) {
      response.data.forEach((comment) => {
        const { channelId, id } = getDiscordInfoFromGithubBody(comment.body!);
        if (!channelId || !id) return;

        const thread = store.threads.find((i) => i.id === channelId);
        thread?.comments.push({ id, git_id: comment.id });
      });
    } else {
      error("Failed to load comments - No response data");
    }
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to load comments: ${err.message}`);
    } else {
      error("Failed to load comments due to an unknown error");
    }
  }
}
