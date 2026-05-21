export type ClosedReason = "completed" | "not_planned";

/**
 * Mapping between GitHub issue states/labels and Discord forum tags.
 *
 * - Discord tag names must match exactly what is configured on the forum
 *   channel. If a name does not exist on the forum the bot logs a warning
 *   and skips silently.
 * - Set a value to "" to disable that mapping entry.
 *
 * Edit this file (not .env) to change which tag means what.
 */

export const tagMapping = {
  /**
   * Drives issue close/reopen state.
   *
   * GitHub → Discord:
   *   Closing an issue as "completed"   → apply this tag in Discord.
   *   Closing an issue as "not_planned" → apply this tag in Discord.
   *   Reopening → both tags are removed.
   *
   * Discord → GitHub:
   *   Applying the "completed" tag on a post   → close issue as completed.
   *   Applying the "not_planned" tag on a post → close issue as not_planned.
   *   Removing either tag from a closed post   → reopen the issue.
   */
  closedState: {
    completed: "已解决",
    not_planned: "无效",
  } satisfies Record<ClosedReason, string>,

  // Future: high-frequency GitHub label ↔ Discord tag bidirectional pairs.
  // Schema is not finalized yet; sketch only.
  //
  // labels: [
  //   { github: "Invalid", discord: "无效" },
  //   { github: "bug",     discord: "Bug" },
  // ],
};
