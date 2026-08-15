# Managing GitHub Issues via Discord Threads

This Discord bot serves as a seamless bridge between Discord thread channel and GitHub repository issues, enabling efficient issue management and synchronization between the two platforms. This integration allows for efficient project management, ensuring that actions performed on either Discord or GitHub are reflected in both platforms, facilitating smoother collaboration and issue tracking across teams.

## Functionality Overview

#### Issues

- \[x] Create issue from a post (**Create Issue**) -> Admin-only message
  context menu command. Right-click the post's first message -> Apps ->
  Create Issue, and the bot opens a GitHub issue from that message's text
  and attachments. It only accepts the first message of a post, since that
  message's URL is what re-attaches the issue to the post after a restart.
- \[x] Link existing issue (`/link-issue number:<n>`) -> Admin-only slash
  command that links an existing GitHub issue to the current forum post.
  Appends the Discord URL to the issue body if it isn't there yet, so the
  link persists across bot restarts.
- \[x] Unlink issue (`/unlink-issue`) -> Admin-only slash command that
  detaches the current post from its GitHub issue without touching either
  side. Strips the Discord URL marker from the issue body so the link no
  longer survives bot restarts, and lets you re-link a different post (or
  safely delete the current one without deleting the issue).
- \[ ] GitHub Issue Creation -> Not auto-mirrored. Use `/link-issue number:<n>`
  from an existing Discord post to attach a GitHub issue manually.

#### Comments

- \[x] Discord Post Comments -> Pushed to the linked GitHub issue on demand
  via the **Sync to Issue** message context menu command (right-click a
  message -> Apps -> Sync to Issue). Picking messages one by one is what
  keeps the bot off Discord's privileged intents; see
  [Privileged intents](#privileged-intents).
- \[ ] GitHub Issue Comments -> Pending feature: Synchronization with Discord post comments.

#### Tags & Labels

- \[x] Discord Post Tags -> Translated into GitHub issue labels for better categorization.
- \[ ] Discord Post Tag Changes -> Future implementation: Update GitHub issue labels from Discord.
- \[x] GitHub Issue Label Changes -> Reflect GitHub label add/remove actions in Discord post tags.

Tag mappings live in `src/tagMapping.config.json`. This file is per-deployment
and git-ignored, so updates never overwrite your values. It is seeded
automatically from the committed `src/tagMapping.config.example.json` on the
first `npm run dev` / `build` / `start` (or run `npm run ensure-config`). Edit
your local copy to match your Discord forum tags and GitHub labels. Shape:

```json
{
  "closedState": {
    "completed": "已解决",
    "not_planned": "无效",
    "duplicate": "重复"
  },
  "closedStateGithubLabels": {
    "duplicate": "duplicate"
  },
  "closedStateCommands": {
    "completed": {
      "command": "complete",
      "description": "Close this post as completed. (Admin only)",
      "label": "completed"
    },
    "not_planned": {
      "command": "invalid",
      "description": "Close this post as not planned / invalid. (Admin only)",
      "label": "invalid / not planned"
    },
    "duplicate": {
      "command": "duplicate",
      "description": "Close this post as a duplicate. (Admin only)",
      "label": "a duplicate",
      "lockOnClose": true,
      "reference": {
        "option": "post",
        "optionDescription": "Link to the post this one duplicates.",
        "message": "此帖与帖子 {link} 重复。后续请在对应位置集中讨论。",
        "githubMessage": "Duplicate of #{number}"
      }
    }
  },
  "labels": [
    { "github": "bug", "discord": "Bug" },
    { "github": "enhancement", "discord": "功能" }
  ],
  "tagGroups": [
    {
      "name": "in-progress",
      "clearOnClose": true,
      "tags": ["进行中", "待审核"]
    }
  ]
}
```

If a GitHub label is not listed in `labels`, the bot falls back to matching a
Discord forum tag with the same name.

`closedState` is reserved for issue state, not ordinary labels:

- `completed` is applied when GitHub closes an issue as completed.
- `not_planned` is applied when GitHub closes an issue as not planned.
- `duplicate` is applied when a post is closed as a duplicate.
- Adding one of these Discord tags closes the linked GitHub issue.
- Removing one of these Discord tags from a closed post reopens the issue.

GitHub's API only records `completed` or `not_planned` as a close reason. Any
other reason (such as `duplicate`) is closed as `not_planned` on GitHub and
distinguished there by an extra label configured in `closedStateGithubLabels`
(here, the `duplicate` label). The label is applied on close and removed on
reopen; a `not_planned` close that carries this label is mapped back to the
`duplicate` Discord tag.

`closedStateCommands` defines the admin-only slash command for each reason: the
command name, its Discord description, and the phrase used in the bot's
confirmation reply. Two optional settings per reason:

- `lockOnClose: true` locks the forum post after closing it. Discord's lock
  state is mirrored to GitHub, so the linked issue ends up locked as well.
- `reference` adds an optional slash command argument pointing at another post,
  e.g. `/duplicate post:<link>`. Fill it in and the bot's reply names that post;
  leave it out and the command behaves as it did before. `option` /
  `optionDescription` name and describe the argument in Discord, `message` is
  the notice posted in the forum post (`{link}` becomes a link to the referenced
  post), and `githubMessage` is a note left on the GitHub issue (`{number}`
  becomes the referenced post's issue number). The note is skipped when
  `githubMessage` is omitted or either post has no linked issue. The argument
  accepts a Discord post link or a bare post id.

**Adding a closed-state reason is config-only — no code change needed.** Add a
matching key to `closedState` (the Discord tag) and `closedStateCommands` (the
slash command); for any reason other than `completed`/`not_planned`, also add a
`closedStateGithubLabels` entry (the GitHub mirror label). `completed` and
`not_planned` are reserved names that map to GitHub's two native close reasons —
every other reason is recorded on GitHub as `not_planned` plus its mirror label.

`tagGroups` lets you group Discord forum tags. A group flagged
`clearOnClose: true` has all of its tags removed from a post whenever it is
closed (via `/complete`, `/invalid`, `/duplicate`, or a GitHub-side close), and
the matching GitHub labels are removed too. Use this for "in progress"-style
tags that should not linger on a resolved post. List the exact Discord tag
names in `tags` (leave the array empty to disable). State is **not** preserved:
reopening a post does not restore previously cleared tags — re-apply them
manually if needed.

`labels` is for normal GitHub label <-> Discord forum tag mapping. Put entries
there when the names differ. Example: `{ "github": "enhancement", "discord": "功能" }`
means GitHub label `enhancement` maps to Discord tag `功能`. Leave `labels` empty
when your GitHub labels and Discord tags use the same names.

GitHub -> Discord label sync requires the GitHub webhook to send Issues events
for `labeled` and `unlabeled`. Close/reopen/lock/delete syncing also uses Issues
events, so selecting the GitHub webhook "Issues" event category is enough.

#### Locking & Unlocking

- \[x] Discord Post Lock/Unlock -> Corresponding action on GitHub issues for security or access control.
- \[x] GitHub Issue Lock/Unlock -> Syncing locking status with Discord posts.

#### Open/Close Management

Issue open/close state is mirrored through the `closedState` tags above, **not**
through the archived/active state of the Discord post. Closing a GitHub issue
applies the matching closed-state tag to the post (the post is _not_ archived);
reopening removes it. This avoids a pitfall where a forum post auto-unarchives
as soon as anyone posts a message, which used to be synced back as a reopen.

- \[x] Discord Post Tag -> Adding/removing the closed-state tag closes/reopens the linked GitHub issue.
- \[x] GitHub Issue Open/Close -> Applies/removes the closed-state tag on the Discord post.
- \[x] Close commands -> Admin-only `/complete`, `/invalid`, and `/duplicate`
  slash commands close the post (and its issue) with the matching closed-state
  tag. They also clear any `clearOnClose` tag group (see Tags & Labels) from
  both Discord and GitHub.
- \[x] `/duplicate` -> Closes the post as a duplicate and locks it. Pass
  `post:<link>` to point members at the post this one duplicates: the bot's
  reply links that post, and if both posts are linked to issues it also leaves a
  `Duplicate of #N` note on the GitHub issue. Configured under
  `closedStateCommands` (see Tags & Labels).

#### Deletion Actions

- \[x] Discord Post Deletion -> Initiates the removal of the associated GitHub issue.
- \[x] GitHub Issue Deletion -> Sync deletion actions from GitHub to Discord posts.

#### Attachment Support

- \[x] Supported File Types: png, jpeg
- \[ ] Planned Support: gif, text, video

## Installation Steps

#### Creating bot

Create bot https://discord.com/developers/applications?new_application=true

#### Privileged intents

The bot runs on non-privileged intents only (`Guilds`, `GuildMessages`,
`DirectMessages`), so **leave PRESENCE INTENT, SERVER MEMBERS INTENT and
MESSAGE CONTENT INTENT switched off** in the Developer Portal. Discord makes
apps that reach 10,000 unique users pass a review before they may keep a
privileged intent, and this bot never needs one:

- **Create Issue** and **Sync to Issue** are message context menu commands.
  Their interaction payload carries the target message's full text and
  attachments, which is why they work without MESSAGE CONTENT.
- `GuildMessages` is kept for message deletions, which carry only ids.

The trade-off is that the bot cannot read messages it was not pointed at, so
every comment that should reach GitHub has to go through **Sync to Issue**.

Invite url: https://discord.com/api/oauth2/authorize?client_id=APPLICATION_ID&permissions=0&scope=bot

#### env

- DISCORD_TOKEN - Discord developer bot page "Settings->bot->reset token" (https://discord.com/developers/applications/APPLICATION_ID/bot)
- DISCORD_CHANNEL_ID - In the Discord server, create a forum channel and right-click (RMB) to copy the channel ID (developer settings must be turned on for this). Alternatively, you can copy the ID from the link. Example:
  https://discord.com/channels/<GUILD_ID>/<DISCORD_CHANNEL_ID>
- GITHUB_ACCESS_TOKEN
  1. [New Fine-grained Personal Access Token](https://github.com/settings/personal-access-tokens/new) or follow these steps: Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens -> Generate new token.
  2. In the "Repository access" section, select "Only select repositories" and choose the specific repositories you need access to.
  3. In the "Permissions" section, click on "Repository permissions" and set "Issues" to "Read & Write".
  4. Generate and copy the personal access token.
- GITHUB_USERNAME - example: https://github.com/<GITHUB_USERNAME>/<GITHUB_REPOSITORY>
- GITHUB_REPOSITORY

> **_NOTE:_** For detailed information about personal access tokens, visit the [Managing your personal access tokens - GitHub Docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

#### Start bot

```bash
npm run dev
```

or

```bash
npm run build && npm run start
```

Forward for github webhooks:

```bash
ssh -R 80:localhost:5000 serveo.net
```
