import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // src/config.ts refuses to load without these. The values are never used —
    // they only get the module past its startup check so tests can import
    // handlers that sit downstream of it. dotenv does not override variables
    // that are already set, so a local .env cannot interfere.
    env: {
      DISCORD_TOKEN: "test-discord-token",
      GITHUB_ACCESS_TOKEN: "test-github-token",
      GITHUB_USERNAME: "test-owner",
      GITHUB_REPOSITORY: "test-repo",
      DISCORD_CHANNEL_ID: "100000000000000000",
    },
  },
});
