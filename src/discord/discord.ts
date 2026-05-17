import {
  Client,
  Events,
  GatewayIntentBits,
  SimpleShardingStrategy,
} from "discord.js";
import { config } from "../config";
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

export function initDiscord() {
  client.once(Events.ClientReady, handleClientReady);
  client.on(Events.ThreadCreate, handleThreadCreate);
  client.on(Events.ThreadUpdate, handleThreadUpdate);
  client.on(Events.ChannelUpdate, handleChannelUpdate);
  client.on(Events.MessageCreate, handleMessageCreate);
  client.on(Events.ThreadDelete, handleThreadDelete);
  client.on(Events.MessageDelete, handleMessageDelete);
  client.on(Events.InteractionCreate, handleInteractionCreate);

  client.login(config.DISCORD_TOKEN);
}

export default client;
