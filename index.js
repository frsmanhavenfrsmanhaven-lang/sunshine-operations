
require("dotenv").config();

const express = require("express");

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState
} = require("@discordjs/voice");

// =====================================================
// SUNSHINE ROLEPLAY
// Discord bot + Render-compatible web server
// =====================================================

const config = process.env;
const PREFIX = config.PREFIX || "!";
const BRAND = "Sunshine Roleplay";
const V2 = MessageFlags.IsComponentsV2;
const EPHEMERAL = MessageFlags.Ephemeral;

const app = express();
const PORT = Number(config.PORT) || 3000;

app.disable("x-powered-by");

app.get("/", (req, res) => {
  res.status(200).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Sunshine Roleplay</title>
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #0b1020;
          color: #f4f7ff;
          font-family: Arial, sans-serif;
          padding: 24px;
        }
        main {
          max-width: 620px;
          width: 100%;
          text-align: center;
          background: #141c30;
          border: 1px solid #273552;
          border-radius: 18px;
          padding: 40px 28px;
        }
        h1 { margin: 0 0 12px; font-size: 32px; }
        p { color: #b8c4dc; line-height: 1.7; }
        .status {
          display: inline-block;
          margin-top: 12px;
          padding: 9px 14px;
          border-radius: 8px;
          background: #173d30;
          color: #8af0bc;
        }
        footer { margin-top: 28px; color: #8492ad; font-size: 12px; }
      </style>
    </head>
    <body>
      <main>
        <h1>Sunshine Roleplay</h1>
        <p>Official bot service page.</p>
        <div class="status">Web service is responding</div>
        <p>This page confirms that the Sunshine Roleplay web service is running.
        Discord bot availability is monitored separately.</p>
        <footer>Sunshine Roleplay</footer>
      </main>
    </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.status(200).json({
    service: BRAND,
    web: "online",
    bot: client?.isReady() ? "online" : "starting",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

const webServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`${BRAND} web server listening on port ${PORT}`);
});

webServer.on("error", error => {
  console.error("Web server error:", error);
});

for (const key of ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID"]) {
  if (!config[key]) {
    console.error(`Missing ${key} in environment variables`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.GuildMember
  ]
});

// Temporary storage resets when the bot restarts.
const openTickets = new Map();
const ticketOwners = new Map();
const activePriorities = new Map();
const warningRecords = new Map();

let voiceConnection = null;
let reconnectingVoice = false;

// =====================================================
// COMPONENTS V2
// =====================================================

function makeV2(title, body, rows = []) {
  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${title}`)
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(body)
    );

  for (const row of rows) {
    container.addActionRowComponents(row);
  }

  return { components: [container], flags: V2 };
}

function makeRow(...components) {
  return new ActionRowBuilder().addComponents(...components);
}

async function respond(interaction, title, body, ephemeral = true) {
  const payload = makeV2(title, body);

  if (ephemeral) payload.flags |= EPHEMERAL;

  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(payload);
  }

  return interaction.reply(payload);
}

function clean(value, max = 1500) {
  return String(value ?? "")
    .replace(/@everyone/g, "@\u200beveryone")
    .replace(/@here/g, "@\u200bhere")
    .slice(0, max);
}

function stars(n) {
  return "★".repeat(n) + "☆".repeat(5 - n) + ` (${n}/5)`;
}

function isStaff(member) {
  if (!member) return false;

  return member.permissions.has(PermissionFlagsBits.Administrator) ||
    [config.STAFF_ROLE_ID, config.ADMIN_ROLE_ID]
      .filter(Boolean)
      .some(id => member.roles.cache.has(id));
}

function isAdmin(member) {
  if (!member) return false;

  return member.permissions.has(PermissionFlagsBits.Administrator) ||
    Boolean(
      config.ADMIN_ROLE_ID &&
      member.roles.cache.has(config.ADMIN_ROLE_ID)
    );
}

async function sendToChannel(guild, channelId, title, body) {
  if (!channelId) return;

  try {
    const channel = await guild.channels.fetch(channelId);

    if (channel?.isTextBased()) {
      await channel.send(makeV2(title, body));
    }
  } catch (error) {
    console.error("Message sending failed:", error.message);
  }
}

function log(guild, title, body) {
  return sendToChannel(guild, config.LOG_CHANNEL_ID, title, body);
}

function staffLog(guild, title, body) {
  return sendToChannel(
    guild,
    config.STAFF_LOG_CHANNEL_ID || config.LOG_CHANNEL_ID,
    title,
    body
  );
}

// =====================================================
// SLASH COMMAND DEFINITIONS
// =====================================================

const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show Sunshine Roleplay commands."),

  new SlashCommandBuilder()
    .setName("ticketpanel")
    .setDescription("Post the support ticket dropdown.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("feedback")
    .setDescription("Submit staff feedback.")
    .addUserOption(o =>
      o.setName("staff").setDescription("Staff member").setRequired(true))
    .addIntegerOption(o =>
      o.setName("rating").setDescription("Rating from 0 to 5")
        .setMinValue(0).setMaxValue(5).setRequired(true))
    .addStringOption(o =>
      o.setName("feedback").setDescription("Written feedback")
        .setMaxLength(1000).setRequired(true)),

  new SlashCommandBuilder()
    .setName("appresult")
    .setDescription("Record an application result.")
    .addUserOption(o =>
      o.setName("applicant").setDescription("Applicant").setRequired(true))
    .addIntegerOption(o =>
      o.setName("score").setDescription("Application score")
        .setMinValue(0).setMaxValue(1000).setRequired(true))
    .addStringOption(o =>
      o.setName("notes").setDescription("Review notes")
        .setMaxLength(1500).setRequired(true))
    .addStringOption(o =>
      o.setName("result").setDescription("Pass or Fail").setRequired(true)
        .addChoices(
          { name: "Pass", value: "Pass" },
          { name: "Fail", value: "Fail" }
        )),

  new SlashCommandBuilder()
    .setName("promotion")
    .setDescription("Record a staff promotion.")
    .addUserOption(o =>
      o.setName("staff").setDescription("Staff member").setRequired(true))
    .addStringOption(o =>
      o.setName("oldrank").setDescription("Previous rank")
        .setMaxLength(100).setRequired(true))
    .addStringOption(o =>
      o.setName("newrank").setDescription("New rank")
        .setMaxLength(100).setRequired(true))
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason for promotion")
        .setMaxLength(1000).setRequired(true)),

  new SlashCommandBuilder()
    .setName("infraction")
    .setDescription("Record a staff infraction.")
    .addUserOption(o =>
      o.setName("staff").setDescription("Staff member").setRequired(true))
    .addStringOption(o =>
      o.setName("type").setDescription("Infraction type")
        .setMaxLength(100).setRequired(true))
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason")
        .setMaxLength(1000).setRequired(true)),

  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Send a Components V2 message.")
    .addStringOption(o =>
      o.setName("message").setDescription("Message to send")
        .setMaxLength(3500).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member from the server.")
    .addUserOption(o =>
      o.setName("user").setDescription("Member to kick").setRequired(true))
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason for the kick")
        .setMaxLength(1000).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member from the server.")
    .addUserOption(o =>
      o.setName("user").setDescription("User to ban").setRequired(true))
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason for the ban")
        .setMaxLength(1000).setRequired(true))
    .addIntegerOption(o =>
      o.setName("delete_days")
        .setDescription("Days of recent messages to delete (0-7)")
        .setMinValue(0).setMaxValue(7).setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user using their Discord ID.")
    .addStringOption(o =>
      o.setName("userid").setDescription("Banned user's Discord ID")
        .setRequired(true))
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason for unbanning")
        .setMaxLength(1000).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member.")
    .addUserOption(o =>
      o.setName("user").setDescription("Member to timeout").setRequired(true))
    .addIntegerOption(o =>
      o.setName("minutes").setDescription("Timeout duration in minutes")
        .setMinValue(1).setMaxValue(40320).setRequired(true))
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason for timeout")
        .setMaxLength(1000).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName("untimeout")
    .setDescription("Remove a member's timeout.")
    .addUserOption(o =>
      o.setName("user").setDescription("Member to untimeout").setRequired(true))
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason for removing timeout")
        .setMaxLength(1000).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete recent messages in this channel.")
    .addIntegerOption(o =>
      o.setName("amount").setDescription("Number of messages (1-100)")
        .setMinValue(1).setMaxValue(100).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a server member.")
    .addUserOption(o =>
      o.setName("user").setDescription("Member to warn").setRequired(true))
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason for warning")
        .setMaxLength(1000).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
];

// =====================================================
// COMMAND REGISTRATION
// =====================================================

async function registerCommands() {
  const rest = new REST({ version: "10" })
    .setToken(config.DISCORD_TOKEN);

  console.log("Registering Sunshine Roleplay commands...");

  await rest.put(
    Routes.applicationGuildCommands(config.CLIENT_ID, config.GUILD_ID),
    { body: commands.map(c => c.toJSON()) }
  );

  console.log("Slash commands registered.");
}

// =====================================================
// MODERATION HELPERS
// =====================================================

async function getModerationMember(interaction, user) {
  return interaction.guild.members.fetch(user.id).catch(() => null);
}

function botCanActOnMember(interaction, target, permission) {
  const botMember = interaction.guild.members.me;

  if (!target) {
    return { ok: false, message: "That member is not in this server." };
  }

  if (target.id === interaction.user.id) {
    return { ok: false, message: "You cannot use this command on yourself." };
  }

  if (target.id === client.user.id) {
    return { ok: false, message: "I cannot perform this action on myself." };
  }

  if (target.id === interaction.guild.ownerId) {
    return { ok: false, message: "The server owner cannot be targeted." };
  }

  if (!botMember.permissions.has(permission)) {
    return {
      ok: false,
      message: "I do not have the required server permission."
    };
  }

  if (
    interaction.guild.ownerId !== interaction.user.id &&
    interaction.member.roles.highest.comparePositionTo(target.roles.highest) <= 0
  ) {
    return {
      ok: false,
      message: "Your highest role must be higher than the target's highest role."
    };
  }

  if (botMember.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return {
      ok: false,
      message: "My highest role must be higher than the target's highest role."
    };
  }

  return { ok: true };
}

async function moderationLog(interaction, action, target, reason) {
  await log(
    interaction.guild,
    `Moderation: ${action}`,
    `**Target:** ${target}\n` +
    `**Moderator:** ${interaction.user.tag}\n` +
    `**Reason:** ${clean(reason, 1000)}\n` +
    `**Date:** <t:${Math.floor(Date.now() / 1000)}:F>`
  );
}

// =====================================================
// WELCOME MESSAGES
// =====================================================

client.on("guildMemberAdd", async member => {
  const emoji = config.WELCOME_EMOJI
    ? `${config.WELCOME_EMOJI} `
    : "";

  await sendToChannel(
    member.guild,
    config.WELCOME_CHANNEL_ID,
    "Welcome to Sunshine Roleplay!",
    `Hey! Welcome to ${emoji}Sunshine Roleplay! Hope you enjoy and stay!\n\nWelcome, ${member}!`
  );

  await log(
    member.guild,
    "Member Joined",
    `Member: ${member.user.tag}\nID: ${member.id}`
  );
});

client.on("guildMemberRemove", async member => {
  await log(
    member.guild,
    "Member Left",
    `Member: ${member.user?.tag || "Unknown"}\nID: ${member.id}`
  );
});

// =====================================================
// MESSAGE LOGS
// =====================================================

client.on("messageDelete", async message => {
  if (!message.guild) return;

  await log(
    message.guild,
    "Message Deleted",
    `Channel: <#${message.channelId}>\n` +
    `Author: ${message.author?.tag || "Unknown or uncached"}\n` +
    `Content: ${clean(message.content || "[Unavailable]", 1000)}`
  );
});

client.on("messageUpdate", async (oldMessage, newMessage) => {
  if (!newMessage.guild || oldMessage.partial || newMessage.partial) return;
  if (oldMessage.content === newMessage.content) return;

  await log(
    newMessage.guild,
    "Message Edited",
    `Author: ${newMessage.author?.tag || "Unknown"}\n` +
    `Channel: <#${newMessage.channelId}>\n` +
    `Before: ${clean(oldMessage.content || "[Empty]", 600)}\n` +
    `After: ${clean(newMessage.content || "[Empty]", 600)}`
  );
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const added = newMember.roles.cache.filter(
    r => !oldMember.roles.cache.has(r.id)
  );

  const removed = oldMember.roles.cache.filter(
    r => !newMember.roles.cache.has(r.id)
  );

  if (!added.size && !removed.size) return;

  await log(
    newMember.guild,
    "Member Roles Updated",
    `Member: ${newMember.user.tag}\n` +
    `Added: ${added.map(r => r.name).join(", ") || "None"}\n` +
    `Removed: ${removed.map(r => r.name).join(", ") || "None"}`
  );
});

client.on("guildBanAdd", ban =>
  log(
    ban.guild,
    "Member Banned",
    `User: ${ban.user.tag}\nID: ${ban.user.id}`
  )
);

client.on("guildBanRemove", ban =>
  log(
    ban.guild,
    "Member Unbanned",
    `User: ${ban.user.tag}\nID: ${ban.user.id}`
  )
);

client.on("guildAuditLogEntryCreate", async (entry, guild) => {
  const actions = [
    "MemberKick", "MemberBanAdd", "MemberBanRemove",
    "MemberUpdate", "MemberRoleUpdate",
    "ChannelCreate", "ChannelDelete", "ChannelUpdate",
    "RoleCreate", "RoleDelete", "RoleUpdate", "MessageDelete"
  ];

  if (!actions.includes(entry.action)) return;

  await log(
    guild,
    "Audit Log Event",
    `Action: ${entry.action}\n` +
    `Executor: ${entry.executor?.tag || "Unknown"}\n` +
    `Target: ${entry.target?.tag || entry.target?.name || entry.targetId || "Unknown"}\n` +
    `Reason: ${clean(entry.reason || "Not provided", 500)}`
  );
});

// =====================================================
// PREFIX COMMANDS: !say AND !dm
// =====================================================

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;

  const content = message.content.trim();
  const lower = content.toLowerCase();

  const sayCommand = `${PREFIX}say`;
  const isSay = lower.startsWith(sayCommand.toLowerCase());

  if (
    isSay &&
    (!content[sayCommand.length] || /\s/.test(content[sayCommand.length]))
  ) {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply("You need Manage Messages permission.");
    }

    const text = content.slice(sayCommand.length).trim();

    if (!text) {
      return message.reply(`Usage: ${PREFIX}say Your message`);
    }

    try {
      await message.channel.send(makeV2(BRAND, clean(text, 3500)));
      await message.delete().catch(() => {});
    } catch (error) {
      console.error("Say error:", error.message);
    }

    return;
  }

  const dmCommand = `${PREFIX}dm`;
  const isDM = lower.startsWith(dmCommand.toLowerCase());

  if (
    isDM &&
    (!content[dmCommand.length] || /\s/.test(content[dmCommand.length]))
  ) {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply("You need Manage Messages permission to use this command.");
    }

    const args = content.slice(dmCommand.length).trim();

    if (!args) {
      return message.reply(
        `**Usage:** \`${PREFIX}dm @user Your message here\`\n` +
        "You can also use a Discord user ID."
      );
    }

    let target = message.mentions.users.first();
    let dmText = "";

    if (target) {
      dmText = args.replace(/<@!?\d{17,20}>/, "").trim();
    } else {
      const parts = args.match(/^(\d{17,20})\s+([\s\S]+)$/);

      if (parts) {
        try {
          target = await client.users.fetch(parts[1]);
          dmText = parts[2].trim();
        } catch {
          return message.reply("I couldn't find a Discord user with that ID.");
        }
      } else {
        return message.reply(
          `**Usage:** \`${PREFIX}dm @user Your message here\`\n` +
          "You can also use a Discord user ID."
        );
      }
    }

    if (!target) {
      return message.reply("Please mention a user or provide a valid Discord user ID.");
    }

    if (!dmText) {
      return message.reply(`Please include a message. Example: \`${PREFIX}dm @user Hello!\``);
    }

    if (target.bot) {
      return message.reply("You cannot use this command to DM a bot.");
    }

    if (target.id === message.author.id) {
      return message.reply("You cannot use this command to DM yourself.");
    }

    const privateMessage =
      `**Message from Sunshine Roleplay staff**\n\n` +
      `${clean(dmText, 1800)}\n\n` +
      `*Sent by ${message.author.tag} on behalf of Sunshine Roleplay staff.*`;

    let delivered = false;

    try {
      await target.send({ content: privateMessage });
      delivered = true;

      await log(
        message.guild,
        "Staff Direct Message Sent",
        `**Recipient:** ${target.tag} (${target.id})\n` +
        `**Sent By:** ${message.author.tag} (${message.author.id})\n` +
        `**Channel:** <#${message.channel.id}>\n` +
        "**Status:** Delivered"
      );

      await message.reply(`Successfully sent a direct message to **${target.tag}**.`);
      await message.delete().catch(() => {});
    } catch (error) {
      console.error("DM command error:", error.message);

      await message.reply(
        delivered
          ? "The DM was delivered, but I had a problem completing the logging or confirmation."
          : "I couldn't send that DM. The user's privacy settings may block direct messages."
      ).catch(() => {});
    }
  }
});

// =====================================================
// PRIORITY SYSTEM
// =====================================================

function priorityMenu() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("sunshine_priority_select")
    .setPlaceholder("Select the priority scene type")
    .addOptions(
      {
        label: "Vehicle Pursuit",
        description: "Activate a vehicle pursuit priority",
        value: "Vehicle Pursuit"
      },
      {
        label: "Hostage Scene",
        description: "Activate a hostage scene priority",
        value: "Hostage Scene"
      }
    );

  return makeRow(menu);
}

async function showPriorityLocationModal(interaction, scene) {
  const modal = new ModalBuilder()
    .setCustomId(`sunshine_priority_modal:${scene}`)
    .setTitle("Priority Scene Location");

  const locationInput = new TextInputBuilder()
    .setCustomId("location")
    .setLabel("Location of the scene")
    .setPlaceholder("Example: Route 68, near the gas station")
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(100)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(locationInput)
  );

  await interaction.showModal(modal);
}

async function setVoiceChannelStatus(channelId, status) {
  await client.rest.put(
    `/channels/${channelId}/voice-status`,
    { body: { status } }
  );
}

async function activatePriority(interaction, scene, location) {
  const guild = interaction.guild;
  const voiceId = config.VOICE_CHANNEL_ID;

  if (!voiceId) {
    return respond(
      interaction,
      "Voice Channel Not Configured",
      "Set VOICE_CHANNEL_ID in your environment variables before activating priorities."
    );
  }

  const voiceChannel = await guild.channels.fetch(voiceId).catch(() => null);

  if (!voiceChannel || !voiceChannel.isVoiceBased()) {
    return respond(
      interaction,
      "Invalid Voice Channel",
      "VOICE_CHANNEL_ID must refer to a valid voice channel."
    );
  }

  const status = `🚨Priority Scene (${location})`;

  const announcement =
    `All units Priority Scene activated at ${location}, approach with caution!\n\n` +
    `**Scene Type:** ${scene}\n` +
    `**Location:** ${location}\n` +
    `**Activated By:** ${interaction.user}`;

  try {
    if (
      !voiceConnection ||
      voiceConnection.state.status === VoiceConnectionStatus.Destroyed ||
      voiceConnection.joinConfig.channelId !== voiceChannel.id
    ) {
      voiceConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true
      });

      voiceConnection.on("error", error => {
        console.error("Voice error:", error.message);
      });

      await entersState(voiceConnection, VoiceConnectionStatus.Ready, 30000);
    }

    await setVoiceChannelStatus(voiceChannel.id, status);

    activePriorities.set(guild.id, {
      scene,
      location,
      channelId: voiceChannel.id,
      activatedBy: interaction.user.id,
      startedAt: Date.now()
    });

    await interaction.channel.send(
      makeV2("Priority Scene Activated", announcement)
    );

    await log(
      guild,
      "Priority Activated",
      `**Type:** ${scene}\n` +
      `**Location:** ${location}\n` +
      `**Activated By:** ${interaction.user.tag}\n` +
      `**Voice Status:** ${status}`
    );

    return respond(
      interaction,
      "Priority Activated",
      `**Type:** ${scene}\n**Location:** ${location}\n\nVoice-channel status set to:\n${status}`
    );
  } catch (error) {
    console.error("Priority activation error:", error);

    return respond(
      interaction,
      "Priority Partially Failed",
      "The priority could not be fully activated. Check the logs and voice-channel permissions."
    );
  }
}

// =====================================================
// TICKET PANEL
// =====================================================

async function postTicketPanel(channel) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("sunshine_ticket_select")
    .setPlaceholder("Choose a support department")
    .addOptions(
      {
        label: "General Support",
        description: "Questions and general assistance",
        value: "general"
      },
      {
        label: "Internal Affairs Support",
        description: "Internal affairs matters",
        value: "ia"
      },
      {
        label: "Management Support",
        description: "Management-related matters",
        value: "management"
      }
    );

  await channel.send(
    makeV2(
      "Sunshine Roleplay Support",
      "Select a department to open a private support ticket.\n\n" +
      "**General Support**\nGeneral questions and help.\n\n" +
      "**Internal Affairs Support**\nInternal affairs concerns.\n\n" +
      "**Management Support**\nManagement matters.",
      [makeRow(menu)]
    )
  );
}

async function createTicket(interaction, type) {
  const guild = interaction.guild;
  const ownerKey = `${guild.id}:${interaction.user.id}`;
  const oldId = openTickets.get(ownerKey);

  if (oldId) {
    const existing = await guild.channels.fetch(oldId).catch(() => null);

    if (existing) {
      return respond(
        interaction,
        "Ticket Already Open",
        `You already have an open ticket: <#${existing.id}>`
      );
    }

    openTickets.delete(ownerKey);
  }

  const departments = {
    general: {
      name: "general-support",
      label: "General Support",
      roleId: config.TICKET_SUPPORT_ROLE_ID
    },
    ia: {
      name: "ia-support",
      label: "Internal Affairs Support",
      roleId: config.INTERNAL_AFFAIRS_ROLE_ID
    },
    management: {
      name: "management-support",
      label: "Management Support",
      roleId: config.MANAGEMENT_ROLE_ID
    }
  };

  const department = departments[type];

  if (!department) {
    return respond(interaction, "Error", "Unknown department.");
  }

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles
      ]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels
      ]
    }
  ];

  if (department.roleId && guild.roles.cache.has(department.roleId)) {
    overwrites.push({
      id: department.roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    });
  }

  try {
    const channel = await guild.channels.create({
      name: `${department.name}-${interaction.user.username}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 90),
      type: ChannelType.GuildText,
      parent: config.TICKET_CATEGORY_ID || undefined,
      permissionOverwrites: overwrites,
      reason: `Ticket opened by ${interaction.user.tag}`
    });

    openTickets.set(ownerKey, channel.id);
    ticketOwners.set(channel.id, interaction.user.id);

    const closeButton = new ButtonBuilder()
      .setCustomId("sunshine_ticket_close")
      .setLabel("Close Ticket")
      .setStyle(ButtonStyle.Danger);

    await channel.send(
      makeV2(
        department.label,
        `Hello ${interaction.user}!\n\nYour private support ticket is open. Please describe your issue and wait for the appropriate team.`,
        [makeRow(closeButton)]
      )
    );

    await log(
      guild,
      "Ticket Opened",
      `Channel: <#${channel.id}>\nOwner: ${interaction.user.tag}\nDepartment: ${department.label}`
    );

    return respond(
      interaction,
      "Ticket Created",
      `Your ticket is ready: <#${channel.id}>`
    );
  } catch (error) {
    console.error("Ticket error:", error);

    return respond(
      interaction,
      "Ticket Error",
      "Could not create the ticket. Check Manage Channels and category permissions."
    );
  }
}

async function closeTicket(interaction) {
  const channel = interaction.channel;
  const ownerId = ticketOwners.get(channel.id);

  if (ownerId !== interaction.user.id && !isStaff(interaction.member)) {
    return respond(
      interaction,
      "Access Denied",
      "Only the ticket owner or configured staff can close this ticket."
    );
  }

  await respond(
    interaction,
    "Ticket Closing",
    "This channel will be deleted shortly."
  );

  if (ownerId) {
    openTickets.delete(`${interaction.guild.id}:${ownerId}`);
  }

  ticketOwners.delete(channel.id);

  await log(
    interaction.guild,
    "Ticket Closed",
    `Channel: #${channel.name}\nClosed by: ${interaction.user.tag}`
  );

  setTimeout(() => {
    channel.delete("Ticket closed").catch(console.error);
  }, 4000);
}

// =====================================================
// INTERACTIONS
// =====================================================

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "sunshine_ticket_select") {
        return createTicket(interaction, interaction.values[0]);
      }

      if (interaction.customId === "sunshine_priority_select") {
        if (!isStaff(interaction.member)) {
          return respond(interaction, "Access Denied", "Staff only.");
        }

        return showPriorityLocationModal(interaction, interaction.values[0]);
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("sunshine_priority_modal:")) {
        if (!isStaff(interaction.member)) {
          return respond(interaction, "Access Denied", "Staff only.");
        }

        const scene = interaction.customId.split(":")[1];
        const location = clean(
          interaction.fields.getTextInputValue("location").trim(),
          100
        );

        if (!location) {
          return respond(interaction, "Missing Location", "Enter a valid location.");
        }

        return activatePriority(interaction, scene, location);
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === "sunshine_ticket_close") {
        return closeTicket(interaction);
      }
    }

    if (!interaction.isChatInputCommand()) return;

    const name = interaction.commandName;

    if (name === "help") {
      return respond(
        interaction,
        "Sunshine Roleplay Commands",
        "**General**\n" +
        "`/help` — Help menu\n" +
        "`/say` — Send a message\n" +
        "`!say message` — Send a message\n" +
        "`!dm @user message` — Send a private message\n\n" +
        "**Tickets**\n" +
        "`/ticketpanel` — Post ticket panel\n\n" +
        "**Staff**\n" +
        "`/feedback` — Submit staff feedback\n" +
        "`/appresult` — Record application result\n" +
        "`/promotion` — Announce promotion in current channel\n" +
        "`/infraction` — Record staff infraction\n\n" +
        "**Moderation**\n" +
        "`/kick` — Kick a member\n" +
        "`/ban` — Ban a user\n" +
        "`/unban` — Unban using user ID\n" +
        "`/timeout` — Timeout a member\n" +
        "`/untimeout` — Remove timeout\n" +
        "`/purge` — Delete recent messages\n" +
        "`/warn` — Warn a member\n\n" +
        "**Priorities**\n" +
        "`!priority` — Activate a priority\n" +
        "`!endpriority` — End active priority"
      );
    }

    if (name === "ticketpanel") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        return respond(interaction, "Access Denied", "Manage Server permission required.");
      }

      const channelId = config.TICKET_PANEL_CHANNEL_ID || interaction.channelId;
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);

      if (!channel?.isTextBased()) {
        return respond(interaction, "Error", "Invalid ticket panel channel.");
      }

      await postTicketPanel(channel);
      return respond(interaction, "Panel Posted", `Sent to <#${channel.id}>.`);
    }

    if (name === "feedback") {
      const staff = interaction.options.getUser("staff");
      const rating = interaction.options.getInteger("rating");
      const feedback = clean(interaction.options.getString("feedback"), 1000);
      const channelId = config.FEEDBACK_CHANNEL_ID || config.STAFF_LOG_CHANNEL_ID;

      if (!channelId) {
        return respond(interaction, "Configuration Missing", "Set FEEDBACK_CHANNEL_ID.");
      }

      await sendToChannel(
        interaction.guild,
        channelId,
        "Staff Feedback",
        `**Staff Member:** ${staff}\n` +
        `**Submitted By:** ${interaction.user}\n` +
        `**Rating:** ${stars(rating)}\n\n**Feedback:**\n${feedback}`
      );

      return respond(interaction, "Feedback Submitted", "Thank you for your feedback.");
    }

    if (name === "appresult") {
      if (!isAdmin(interaction.member)) {
        return respond(interaction, "Access Denied", "Admin role required.");
      }

      const applicant = interaction.options.getUser("applicant");
      const score = interaction.options.getInteger("score");
      const notes = clean(interaction.options.getString("notes"), 1500);
      const result = interaction.options.getString("result");
      const channelId = config.APPLICATION_RESULTS_CHANNEL_ID || config.STAFF_LOG_CHANNEL_ID;

      if (!channelId) {
        return respond(interaction, "Configuration Missing", "Set APPLICATION_RESULTS_CHANNEL_ID.");
      }

      await sendToChannel(
        interaction.guild,
        channelId,
        `Application Result: ${result}`,
        `**Applicant:** ${applicant}\n**Score:** ${score}\n` +
        `**Result:** ${result}\n**Reviewed By:** ${interaction.user}\n\n` +
        `**Notes:**\n${notes}`
      );

      return respond(interaction, "Result Recorded", `Application marked ${result}.`);
    }

    if (name === "promotion") {
      if (!isAdmin(interaction.member)) {
        return respond(interaction, "Access Denied", "Admin role required.");
      }

      const staff = interaction.options.getUser("staff");
      const oldRank = clean(interaction.options.getString("oldrank"), 100);
      const newRank = clean(interaction.options.getString("newrank"), 100);
      const reason = clean(interaction.options.getString("reason"), 1000);

      await interaction.channel.send(
        makeV2(
          "Staff Promotion",
          `**Staff Member:** ${staff}\n` +
          `**Previous Rank:** ${oldRank}\n` +
          `**New Rank:** ${newRank}\n` +
          `**Promoted By:** ${interaction.user}\n\n` +
          `**Reason:** ${reason}\n` +
          `**Date:** <t:${Math.floor(Date.now() / 1000)}:F>`
        )
      );

      await staffLog(
        interaction.guild,
        "Staff Promotion",
        `**Staff Member:** ${staff}\n` +
        `**Previous Rank:** ${oldRank}\n` +
        `**New Rank:** ${newRank}\n` +
        `**Promoted By:** ${interaction.user}\n\n` +
        `**Reason:** ${reason}\n` +
        `**Date:** <t:${Math.floor(Date.now() / 1000)}:F>`
      );

      return respond(
        interaction,
        "Promotion Recorded",
        `Promotion for ${staff} announced in <#${interaction.channelId}>.`
      );
    }

    if (name === "infraction") {
      if (!isAdmin(interaction.member)) {
        return respond(interaction, "Access Denied", "Admin role required.");
      }

      const staff = interaction.options.getUser("staff");
      const type = clean(interaction.options.getString("type"), 100);
      const reason = clean(interaction.options.getString("reason"), 1000);

      await staffLog(
        interaction.guild,
        "Staff Infraction",
        `**Staff Member:** ${staff}\n**Infraction Type:** ${type}\n` +
        `**Issued By:** ${interaction.user}\n\n**Reason:** ${reason}\n` +
        `**Date:** <t:${Math.floor(Date.now() / 1000)}:F>`
      );

      return respond(interaction, "Infraction Recorded", `Infraction recorded for ${staff}.`);
    }

    if (name === "say") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
        return respond(interaction, "Access Denied", "Manage Messages permission required.");
      }

      const content = clean(interaction.options.getString("message"), 3500);
      await interaction.channel.send(makeV2(BRAND, content));

      return respond(interaction, "Message Sent", "Your message has been sent.");
    }

    if (name === "kick") {
      const user = interaction.options.getUser("user");
      const reason = clean(interaction.options.getString("reason"), 1000);

      if (!interaction.memberPermissions.has(PermissionFlagsBits.KickMembers)) {
        return respond(interaction, "Access Denied", "You need Kick Members permission.");
      }

      const target = await getModerationMember(interaction, user);
      const check = botCanActOnMember(interaction, target, PermissionFlagsBits.KickMembers);

      if (!check.ok) return respond(interaction, "Kick Failed", check.message);

      try {
        await target.kick(`Moderator: ${interaction.user.tag} | Reason: ${reason}`);
        await moderationLog(interaction, "Member Kicked", `${user.tag} (${user.id})`, reason);

        return respond(
          interaction,
          "Member Kicked",
          `**User:** ${user.tag}\n**Reason:** ${reason}`
        );
      } catch (error) {
        console.error("Kick error:", error);
        return respond(interaction, "Kick Failed", "Discord rejected the kick. Check role hierarchy and bot permissions.");
      }
    }

    if (name === "ban") {
      const user = interaction.options.getUser("user");
      const reason = clean(interaction.options.getString("reason"), 1000);
      const deleteDays = interaction.options.getInteger("delete_days") ?? 0;

      if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return respond(interaction, "Access Denied", "You need Ban Members permission.");
      }

      const target = await getModerationMember(interaction, user);

      if (target) {
        const check = botCanActOnMember(interaction, target, PermissionFlagsBits.BanMembers);
        if (!check.ok) return respond(interaction, "Ban Failed", check.message);
      } else if (user.id === interaction.user.id || user.id === client.user.id) {
        return respond(interaction, "Ban Failed", "You cannot ban yourself or the bot.");
      }

      try {
        await interaction.guild.members.ban(user.id, {
          reason: `Moderator: ${interaction.user.tag} | Reason: ${reason}`,
          deleteMessageSeconds: deleteDays * 86400
        });

        await moderationLog(interaction, "User Banned", `${user.tag} (${user.id})`, reason);

        return respond(
          interaction,
          "User Banned",
          `**User:** ${user.tag}\n**ID:** ${user.id}\n**Reason:** ${reason}\n**Messages Deleted:** ${deleteDays} day(s)`
        );
      } catch (error) {
        console.error("Ban error:", error);
        return respond(interaction, "Ban Failed", "Discord rejected the ban. Check permissions and role hierarchy.");
      }
    }

    if (name === "unban") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return respond(interaction, "Access Denied", "You need Ban Members permission.");
      }

      const userId = interaction.options.getString("userid").trim();
      const reason = clean(interaction.options.getString("reason"), 1000);

      if (!/^\d{17,20}$/.test(userId)) {
        return respond(interaction, "Invalid ID", "Enter a valid Discord user ID.");
      }

      try {
        const ban = await interaction.guild.bans.fetch(userId).catch(() => null);

        if (!ban) {
          return respond(interaction, "Not Banned", "That user is not banned from this server.");
        }

        await interaction.guild.members.unban(
          userId,
          `Moderator: ${interaction.user.tag} | Reason: ${reason}`
        );

        await moderationLog(interaction, "User Unbanned", `${ban.user.tag} (${userId})`, reason);

        return respond(
          interaction,
          "User Unbanned",
          `**User:** ${ban.user.tag}\n**Reason:** ${reason}`
        );
      } catch (error) {
        console.error("Unban error:", error);
        return respond(interaction, "Unban Failed", "Could not unban that user. Check the bot's permissions.");
      }
    }

    if (name === "timeout") {
      const user = interaction.options.getUser("user");
      const minutes = interaction.options.getInteger("minutes");
      const reason = clean(interaction.options.getString("reason"), 1000);

      if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
        return respond(interaction, "Access Denied", "You need Moderate Members permission.");
      }

      const target = await getModerationMember(interaction, user);
      const check = botCanActOnMember(interaction, target, PermissionFlagsBits.ModerateMembers);

      if (!check.ok) return respond(interaction, "Timeout Failed", check.message);

      try {
        await target.timeout(
          minutes * 60 * 1000,
          `Moderator: ${interaction.user.tag} | Reason: ${reason}`
        );

        await moderationLog(interaction, `Timeout (${minutes} minutes)`, `${user.tag} (${user.id})`, reason);

        return respond(
          interaction,
          "Member Timed Out",
          `**User:** ${user.tag}\n**Duration:** ${minutes} minute(s)\n**Reason:** ${reason}`
        );
      } catch (error) {
        console.error("Timeout error:", error);
        return respond(interaction, "Timeout Failed", "Discord rejected the timeout. Check role hierarchy and permissions.");
      }
    }

    if (name === "untimeout") {
      const user = interaction.options.getUser("user");
      const reason = clean(interaction.options.getString("reason"), 1000);

      if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
        return respond(interaction, "Access Denied", "You need Moderate Members permission.");
      }

      const target = await getModerationMember(interaction, user);
      const check = botCanActOnMember(interaction, target, PermissionFlagsBits.ModerateMembers);

      if (!check.ok) return respond(interaction, "Remove Timeout Failed", check.message);

      try {
        await target.timeout(null, `Moderator: ${interaction.user.tag} | Reason: ${reason}`);

        await moderationLog(interaction, "Timeout Removed", `${user.tag} (${user.id})`, reason);

        return respond(
          interaction,
          "Timeout Removed",
          `**User:** ${user.tag}\n**Reason:** ${reason}`
        );
      } catch (error) {
        console.error("Untimeout error:", error);
        return respond(interaction, "Remove Timeout Failed", "Discord rejected the request. Check role hierarchy and permissions.");
      }
    }

    if (name === "purge") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
        return respond(interaction, "Access Denied", "You need Manage Messages permission.");
      }

      if (!interaction.guild.members.me.permissionsIn(interaction.channel)
        .has(PermissionFlagsBits.ManageMessages)) {
        return respond(interaction, "Permission Error", "I need Manage Messages permission in this channel.");
      }

      const amount = interaction.options.getInteger("amount");

      try {
        const deleted = await interaction.channel.bulkDelete(amount, true);

        await log(
          interaction.guild,
          "Messages Purged",
          `**Moderator:** ${interaction.user.tag}\n` +
          `**Channel:** <#${interaction.channelId}>\n` +
          `**Deleted:** ${deleted.size} message(s)\n` +
          `**Requested:** ${amount}`
        );

        return respond(
          interaction,
          "Purge Complete",
          `Deleted ${deleted.size} message(s). Messages older than 14 days are not bulk-deleted by Discord.`
        );
      } catch (error) {
        console.error("Purge error:", error);
        return respond(interaction, "Purge Failed", "Could not delete messages. Check channel permissions.");
      }
    }

    if (name === "warn") {
      const user = interaction.options.getUser("user");
      const reason = clean(interaction.options.getString("reason"), 1000);

      if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
        return respond(interaction, "Access Denied", "You need Moderate Members permission.");
      }

      if (user.bot) {
        return respond(interaction, "Warning Failed", "You cannot warn a bot.");
      }

      if (user.id === interaction.user.id) {
        return respond(interaction, "Warning Failed", "You cannot warn yourself.");
      }

      const key = `${interaction.guild.id}:${user.id}`;
      const records = warningRecords.get(key) || [];

      records.push({
        reason,
        moderator: interaction.user.id,
        timestamp: Date.now()
      });

      warningRecords.set(key, records);

      await user.send(
        `You have received a warning in **${interaction.guild.name}**.\nReason: ${reason}`
      ).catch(() => {});

      await moderationLog(
        interaction,
        `Member Warned (warning #${records.length})`,
        `${user.tag} (${user.id})`,
        reason
      );

      return respond(
        interaction,
        "Warning Issued",
        `**User:** ${user.tag}\n**Reason:** ${reason}\n**Warnings this session:** ${records.length}\n\nWarning records are held in memory and reset when the bot restarts.`
      );
    }
  } catch (error) {
    console.error("Interaction error:", error);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "An error occurred. Check the bot logs.",
        flags: EPHEMERAL
      }).catch(() => {});
    }
  }
});

// =====================================================
// PREFIX PRIORITY COMMANDS
// =====================================================

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;

  const lower = message.content.trim().toLowerCase();

  if (lower === `${PREFIX}priority`) {
    if (!isStaff(message.member)) {
      return message.reply("Only configured staff can activate a priority.");
    }

    return message.channel.send(
      makeV2(
        "Priority Scene",
        "Choose the scene type, then enter the location.",
        [priorityMenu()]
      )
    );
  }

  if (lower === `${PREFIX}endpriority`) {
    if (!isStaff(message.member)) {
      return message.reply("Only configured staff can end a priority.");
    }

    const current = activePriorities.get(message.guild.id);

    if (!current) {
      return message.reply("There is no active priority recorded by the bot.");
    }

    try {
      await setVoiceChannelStatus(current.channelId, "");
      activePriorities.delete(message.guild.id);

      await message.channel.send(
        makeV2(
          "Priority Scene Ended",
          `The priority at **${current.location}** has ended. All units may return to normal operations.`
        )
      );

      await log(
        message.guild,
        "Priority Ended",
        `Scene: ${current.scene}\nLocation: ${current.location}\nEnded by: ${message.author.tag}`
      );

      await message.delete().catch(() => {});
    } catch (error) {
      console.error("End priority error:", error);
      await message.reply("Unable to clear the voice-channel status. Check bot permissions.");
    }
  }
});

// =====================================================
// VOICE CHANNEL CONNECTION
// =====================================================

async function connectVoice() {
  if (!config.VOICE_CHANNEL_ID || reconnectingVoice) return;

  reconnectingVoice = true;

  try {
    const channel = await client.channels.fetch(config.VOICE_CHANNEL_ID);

    if (!channel?.isVoiceBased() || !channel.guild) {
      console.error("VOICE_CHANNEL_ID is not a valid voice channel.");
      return;
    }

    if (
      voiceConnection &&
      voiceConnection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      voiceConnection.destroy();
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    voiceConnection = connection;

    connection.on("error", error => {
      console.error("Voice connection error:", error.message);
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      setTimeout(() => {
        if (voiceConnection === connection) {
          connectVoice().catch(console.error);
        }
      }, 5000);
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 30000);

    console.log(`Connected to voice channel: ${channel.name}`);
  } catch (error) {
    console.error("Voice connection failed:", error.message);
  } finally {
    reconnectingVoice = false;
  }
}

// =====================================================
// STARTUP
// =====================================================

client.once("ready", async () => {
  console.log("======================================");
  console.log(`${client.user.tag} is online.`);
  console.log(`${BRAND} is ready.`);
  console.log("Moderation, tickets and priority systems loaded.");
  console.log("======================================");

  await connectVoice().catch(console.error);
});

client.on("error", error => {
  console.error("Discord client error:", error);
});

process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error);
});

async function start() {
  try {
    await registerCommands();
    await client.login(config.DISCORD_TOKEN);
  } catch (error) {
    console.error("Bot startup failed:", error);
    process.exitCode = 1;
  }
}

start();
