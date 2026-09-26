import { discordCommands } from "../src/discord/commands";

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_DEV_GUILD_ID;
if (applicationId === undefined || botToken === undefined) {
  throw new Error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required");
}
const base = `https://discord.com/api/v10/applications/${applicationId}`;
const url = guildId === undefined ? `${base}/commands` : `${base}/guilds/${guildId}/commands`;
const response = await fetch(url, {
  method: "PUT",
  headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
  body: JSON.stringify(discordCommands),
});
if (!response.ok) throw new Error(`Discord command registration failed with HTTP ${response.status}`);
console.log(`Registered ${discordCommands.length} ${guildId === undefined ? "global" : "guild"} commands.`);
