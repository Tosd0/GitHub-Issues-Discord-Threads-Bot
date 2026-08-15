/**
 * Notes the bot writes on a GitHub issue by itself (e.g. "Duplicate of #12")
 * already have a Discord-side counterpart. Without a marker the GitHub→Discord
 * comment mirror would copy them back into the forum post, so every such note
 * carries one. GitHub renders an HTML comment as nothing, and the marker sits
 * inside the comment body rather than being derived from the author, so a
 * human using the same GitHub account still gets mirrored normally.
 */
const BOT_COMMENT_MARKER = "<!-- generated-by-discord-bot -->";

/** Tag a comment body as written by the bot itself. */
export function markAsBotComment(body: string): string {
  return `${BOT_COMMENT_MARKER}\n${body}`;
}

/** Whether a GitHub comment body was written by the bot itself. */
export function isBotAuthoredIssueComment(body: string | null | undefined) {
  return Boolean(body?.includes(BOT_COMMENT_MARKER));
}
