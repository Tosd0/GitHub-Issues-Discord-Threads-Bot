import dotenv from "dotenv";

dotenv.config();

const {
  DISCORD_TOKEN,
  GITHUB_ACCESS_TOKEN,
  GITHUB_USERNAME,
  GITHUB_REPOSITORY,
  DISCORD_CHANNEL_ID,
  DISCORD_ADMIN_ROLE_IDS,
  AUTO_SYNC_COMMENTS,
} = process.env;

const autoSyncComments = (AUTO_SYNC_COMMENTS ?? "true").trim().toLowerCase();
const AUTO_SYNC_COMMENTS_ENABLED = !["false", "0", "no", "off"].includes(
  autoSyncComments,
);

const channelIds = (DISCORD_CHANNEL_ID ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);

if (
  !DISCORD_TOKEN ||
  !GITHUB_ACCESS_TOKEN ||
  !GITHUB_USERNAME ||
  !GITHUB_REPOSITORY ||
  channelIds.length === 0
) {
  throw new Error("Missing environment variables");
}

export const config = {
  DISCORD_TOKEN,
  GITHUB_ACCESS_TOKEN,
  GITHUB_USERNAME,
  GITHUB_REPOSITORY,
  DISCORD_CHANNEL_IDS: channelIds,
  DISCORD_ADMIN_ROLE_IDS: (DISCORD_ADMIN_ROLE_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
  AUTO_SYNC_COMMENTS: AUTO_SYNC_COMMENTS_ENABLED,
};
