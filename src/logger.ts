import winston, { format } from "winston";
import { config } from "./config";
import { Thread } from "./interfaces";
import client from "./discord/discord";

export const logger = winston.createLogger({
  level: "info",
  format: format.combine(
    format.colorize({ all: true }),
    format.timestamp({
      format: "MM-DD HH:mm:ss",
    }),
    format.printf(
      (info) =>
        `${info.timestamp} [${info.level}]: ${info.message}` +
        (info.splat !== undefined ? `${info.splat}` : " "),
    ),
  ),
  transports: [
    new winston.transports.Console(),
    // new winston.transports.File({ filename: "./logs/logs.log" }),
  ],
});

export const Triggerer = {
  Discord: "discord->github",
  Github: "github->discord",
};

export const Actions = {
  Created: "created",
  Closed: "closed",
  Commented: "commented",
  Reopened: "reopened",
  Locked: "locked",
  Unlocked: "unlocked",
  Deleted: "deleted",
  DeletedComment: "deleted comment",
  Labeled: "labeled",
} as const;

export type ActionValue = (typeof Actions)[keyof typeof Actions];

export const getDiscordUrl = (thread: Thread) => {
  for (const channelId of config.DISCORD_CHANNEL_IDS) {
    const channel = client.channels.cache.get(channelId);
    if (channel?.url) return `${channel.url}/threads/${thread.id}`;
  }
  return `https://discord.com/channels/?/${thread.id}`;
};

export const getGithubUrl = (thread: Thread) => {
  return `https://github.com/${config.GITHUB_USERNAME}/${config.GITHUB_REPOSITORY}/issues/${thread.number}`;
};
