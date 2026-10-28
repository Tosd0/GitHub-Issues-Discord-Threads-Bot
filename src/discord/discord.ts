import {
  Client,
  Events,
  GatewayIntentBits,
  SimpleShardingStrategy,
} from "discord.js";
import { config } from "../config";
import { logger } from "../logger";
import { createSerialQueue } from "../utils/serialQueue";
import { areTagSetsEqual } from "../utils/tagSets";
import { CompletedThreadArchiver } from "./completedThreads";
import {
  handleChannelUpdate,
  handleClientReady,
  handleInteractionCreate,
  handleMessageDelete,
  handleThreadCreate,
  handleThreadDelete,
  handleThreadUpdate,
} from "./discordHandlers";

// No privileged intents. Message text reaches the bot only through the
// "Create Issue" / "Sync to Issue" message context menu commands, whose
// interaction payload carries the full message regardless of MessageContent.
// GuildMessages stays for MessageDelete, which only needs message ids.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ],
  ws: {
    buildStrategy: (manager) => {
      return new (class CompressionSimpleShardingStrategy extends SimpleShardingStrategy {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        constructor(manager: any) {
          manager.options.compression = null;
          super(manager);
        }
      })(manager);
    },
  },
});

export const completionArchiver = new CompletedThreadArchiver(
  client,
  config.COMPLETED_THREADS_STATE_FILE,
  (message) => logger.error(message),
);

let _bootstrapped = false;
export const isDiscordBootstrapped = () => _bootstrapped;

const enqueueThreadUpdate = createSerialQueue<string>();

export function initDiscord() {
  client.once(Events.ClientReady, async (c) => {
    try {
      await handleClientReady(c);
      _bootstrapped = true;
      await completionArchiver.start();
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      logger.error(`Discord bootstrap failed: ${msg}`);
    }
  });
  client.on(Events.ThreadCreate, handleThreadCreate);
  client.on(Events.ThreadUpdate, (oldThread, newThread) => {
    if (
      !newThread.parentId ||
      !config.DISCORD_CHANNEL_IDS.includes(newThread.parentId)
    )
      return;
    // Capture each tag transition immediately; queued GitHub work may outlive
    // another update to this same mutable discord.js channel object.
    const tagsChanged = !areTagSetsEqual(
      oldThread.appliedTags,
      newThread.appliedTags,
    );
    // Archiving an old closed post must not send a new notice and reopen it.
    const completionUpdate = completionArchiver.observe(
      newThread,
      tagsChanged || !newThread.archived,
    );
    void enqueueThreadUpdate(newThread.id, () =>
      handleThreadUpdate(newThread, completionUpdate),
    ).catch((err) => {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      logger.error(`Thread update handler failed: ${msg}`);
    });
  });
  client.on(Events.ChannelUpdate, (_oldChannel, newChannel) =>
    handleChannelUpdate(newChannel),
  );
  client.on(Events.ThreadDelete, handleThreadDelete);
  client.on(Events.MessageDelete, handleMessageDelete);
  client.on(Events.InteractionCreate, handleInteractionCreate);

  client.login(config.DISCORD_TOKEN);
}

export default client;
