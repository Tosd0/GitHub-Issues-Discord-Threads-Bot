import {
  Client,
  Events,
  GatewayIntentBits,
  SimpleShardingStrategy,
} from "discord.js";
import { config } from "../config";
import { logger } from "../logger";
import { createSerialQueue } from "../utils/serialQueue";
import {
  handleChannelUpdate,
  handleClientReady,
  handleInteractionCreate,
  handleMessageCreate,
  handleMessageDelete,
  handleThreadCreate,
  handleThreadDelete,
  handleThreadUpdate,
} from "./discordHandlers";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
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

let _bootstrapped = false;
export const isDiscordBootstrapped = () => _bootstrapped;

const enqueueThreadUpdate = createSerialQueue<string>();

export function initDiscord() {
  client.once(Events.ClientReady, async (c) => {
    try {
      await handleClientReady(c);
      _bootstrapped = true;
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      logger.error(`Discord bootstrap failed: ${msg}`);
    }
  });
  client.on(Events.ThreadCreate, handleThreadCreate);
  client.on(Events.ThreadUpdate, (_oldThread, newThread) => {
    void enqueueThreadUpdate(newThread.id, () =>
      handleThreadUpdate(newThread),
    ).catch((err) => {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      logger.error(`Thread update handler failed: ${msg}`);
    });
  });
  client.on(Events.ChannelUpdate, (_oldChannel, newChannel) =>
    handleChannelUpdate(newChannel),
  );
  client.on(Events.MessageCreate, handleMessageCreate);
  client.on(Events.ThreadDelete, handleThreadDelete);
  client.on(Events.MessageDelete, handleMessageDelete);
  client.on(Events.InteractionCreate, handleInteractionCreate);

  client.login(config.DISCORD_TOKEN);
}

export default client;
