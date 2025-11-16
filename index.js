require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, Collection, REST, Routes } = require('discord.js');
const { registerCommands } = require('./src/registry');
const { initDB } = require('./src/db');

const PREFIX = process.env.PREFIX || 'k!';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.commands = new Collection();

// Load commands (both slash and prefix command modules)
const commandFiles = fs.readdirSync('./src/commands').filter(f => f.endsWith('.js'));
for (const file of commandFiles) {
  const cmd = require(`./src/commands/${file}`);
  if (cmd.data) client.commands.set(cmd.data.name, cmd);
  if (cmd.name && !client.commands.has(cmd.name)) client.commands.set(cmd.name, cmd);
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Ensure data directory
  if (!fs.existsSync('./data')) fs.mkdirSync('./data');
  initDB();
  // Register slash commands
  try {
    await registerCommands(Array.from(client.commands.values()).filter(c => c.data).map(c => c.data));
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

// Slash interaction handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;
  try {
    await cmd.execute(interaction, { client, prefix: PREFIX });
  } catch (err) {
    console.error(err);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: 'There was an error while executing this command.', ephemeral: true });
    } else {
      await interaction.reply({ content: 'There was an error while executing this command.', ephemeral: true });
    }
  }
});

// Prefix message commands
client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;
  if (!msg.content.startsWith(PREFIX)) return;
  const args = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  // simple router for k!backup ...
  if (command === 'backup') {
    const sub = args.shift();
    const cmd = client.commands.get('backup');
    if (!cmd) return;
    try {
      await cmd.executeMessage(msg, { sub, args, client, prefix: PREFIX });
    } catch (err) {
      console.error(err);
      msg.reply('Error executing backup command.');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

// -----------------------------
// FILE: src/registry.js
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
require('dotenv').config();

async function registerCommands(commandBuilders) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const cmds = commandBuilders.map(c => c.toJSON());
  if (!process.env.CLIENT_ID) throw new Error('CLIENT_ID missing in .env');
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: cmds });
}

module.exports = { registerCommands };

// -----------------------------
// FILE: src/db.js
const Database = require('better-sqlite3');
let db;

function initDB() {
  db = new Database('./data/backups.sqlite');
  db.prepare(`CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`).run();
}

function saveBackup(guildId, name, payloadObj) {
  const stmt = db.prepare('INSERT INTO backups (guild_id,name,created_at,payload) VALUES (?,?,?,?)');
  const info = stmt.run(guildId, name, Date.now(), JSON.stringify(payloadObj));
  return info.lastInsertRowid;
}

function listBackups(guildId) {
  const stmt = db.prepare('SELECT id,name,created_at FROM backups WHERE guild_id = ? ORDER BY created_at DESC');
  return stmt.all(guildId);
}

function getBackup(id) {
  const stmt = db.prepare('SELECT * FROM backups WHERE id = ?');
  const row = stmt.get(id);
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload) };
}

function deleteBackup(id) {
  const stmt = db.prepare('DELETE FROM backups WHERE id = ?');
  const info = stmt.run(id);
  return info.changes > 0;
}

module.exports = { initDB, saveBackup, listBackups, getBackup, deleteBackup };

// -----------------------------
// FILE: src/backupManager.js
// Responsible for building backup payloads and restoring them

const { PermissionFlagsBits } = require('discord.js');
const { saveBackup, listBackups, getBackup, deleteBackup } = require('./db');

async function buildGuildBackup(guild) {
  await guild.roles.fetch();
  await guild.channels.fetch();

  const roles = guild.roles.cache
    .filter(r => r.id !== guild.id) // exclude @everyone (we'll store base perms)
    .sort((a, b) => a.position - b.position)
    .map(r => ({
      name: r.name,
      color: r.hexColor,
      hoist: r.hoist,
      position: r.position,
      permissions: r.permissions.bitfield,
      mentionable: r.mentionable
    }));

  const channels = [];
  // store categories, channels with type and permissionOverwrites
  for (const ch of guild.channels.cache.values()) {
    channels.push({
      id: ch.id,
      name: ch.name,
      type: ch.type, // numeric
      parentId: ch.parentId,
      position: ch.position,
      nsfw: ch.nsfw ?? false,
      bitrate: ch.bitrate ?? null,
      userLimit: ch.userLimit ?? null,
      topic: ch.topic ?? null,
      permissionOverwrites: ch.permissionOverwrites.cache.map(po => ({
        id: po.id,
        type: po.type,
        allow: po.allow.bitfield,
        deny: po.deny.bitfield
      }))
    });
  }

  return { roles, channels, meta: { guildName: guild.name, guildId: guild.id } };
}

async function createBackup(guild, name) {
  const payload = await buildGuildBackup(guild);
  const id = saveBackup(guild.id, name, payload);
  return id;
}

// Restore will: create roles first, then categories, then channels, then apply overwrites
async function restoreBackup(guild, backupPayload) {
  // role mapping: old role name -> new Role object (id)
  const roleMap = new Map();

  // create roles in order
  for (const r of backupPayload.roles) {
    try {
      const created = await guild.roles.create({
        name: r.name,
        color: r.color === '#000000' ? undefined : r.color,
        hoist: r.hoist,
        mentionable: r.mentionable,
        permissions: BigInt(r.permissions).toString() === '0' ? undefined : r.permissions
      });
      roleMap.set(r.name, created.id);
    } catch (err) {
      // If creation fails due to permissions, skip but try to store mapping by name
      console.warn('Role create failed for', r.name, err.message);
    }
  }

  // create categories first
  const categoryMap = new Map();
  const channelObjects = {};

  // sort channels by position so categories come before children (naive)
  const sorted = backupPayload.channels.slice().sort((a, b) => a.position - b.position);

  for (const ch of sorted) {
    try {
      if (ch.type === 4) { // category
        const created = await guild.channels.create({ name: ch.name, type: 4 });
        categoryMap.set(ch.id, created.id);
        channelObjects[created.id] = created;
      }
    } catch (err) {
      console.warn('Category create failed', ch.name, err.message);
    }
  }

  // now create other channels
  for (const ch of sorted) {
    try {
      if (ch.type === 4) continue; // skip categories
      const parent = ch.parentId ? categoryMap.get(ch.parentId) : null;
      const options = {
        name: ch.name,
        type: ch.type,
        parent: parent || null,
        topic: ch.topic || null,
        nsfw: ch.nsfw || false,
        bitrate: ch.bitrate || undefined,
        userLimit: ch.userLimit || undefined
      };
      const created = await guild.channels.create(options);
      channelObjects[ch.id] = created;

      // apply permission overwrites
      for (const po of ch.permissionOverwrites) {
        let targetId = po.id;
        // if overwrite targets a role that we recreated, translate by name
        const roleByName = backupPayload.roles.find(r => r.id === po.id || r.name === po.roleName);
        if (roleByName && roleMap.has(roleByName.name)) {
          targetId = roleMap.get(roleByName.name);
        }
        try {
          await created.permissionOverwrites.create(targetId, { allow: BigInt(po.allow).toString() === '0' ? 0n : BigInt(po.allow), deny: BigInt(po.deny).toString() === '0' ? 0n : BigInt(po.deny) });
        } catch (err) {
          console.warn('Permission overwrite failed for', created.name, err.message);
        }
      }

    } catch (err) {
      console.warn('Channel create failed for', ch.name, err.message);
    }
  }

  return true;
}

module.exports = { createBackup, buildGuildBackup, restoreBackup, listBackups: listBackups };

// -----------------------------
// FILE: src/commands/backup.js
const { SlashCommandBuilder } = require('@discordjs/builders');
const { createBackup: createBackupManager, restoreBackup } = require('../backupManager');
const { listBackups: dbListBackups, getBackup, deleteBackup } = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Manage server backups')
    .addSubcommand(s => s.setName('create').setDescription('Create a backup').addStringOption(o => o.setName('name').setDescription('Backup name').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('List backups'))
    .addSubcommand(s => s.setName('load').setDescription('Load a backup').addIntegerOption(o => o.setName('id').setDescription('Backup ID').setRequired(true)))
    .addSubcommand(s => s.setName('delete').setDescription('Delete a backup').addIntegerOption(o => o.setName('id').setDescription('Backup ID').setRequired(true))),

  async execute(interaction, { client }) {
    if (!interaction.member.permissions.has('ManageGuild')) {
      // ManageGuild constant string isn't ideal - best-effort check
      if (!interaction.member.permissions.has('ManageRoles')) return interaction.reply({ content: 'You need Manage Roles or Manage Server to use backups.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    if (sub === 'create') {
      const name = interaction.options.getString('name');
      await interaction.deferReply({ ephemeral: true });
      const id = await createBackupManager(interaction.guild, name);
      return interaction.editReply({ content: `Backup created. ID: ${id}` });
    } else if (sub === 'list') {
      const rows = dbListBackups(interaction.guild.id);
      if (!rows.length) return interaction.reply({ content: 'No backups found.', ephemeral: true });
      const lines = rows.map(r => `ID: ${r.id} | ${r.name} | ${new Date(r.created_at).toLocaleString()}`);
      return interaction.reply({ content: lines.join('\n'), ephemeral: true });
    } else if (sub === 'load') {
      const id = interaction.options.getInteger('id');
      const row = getBackup(id);
      if (!row) return interaction.reply({ content: 'Backup not found.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      await restoreBackup(interaction.guild, row.payload);
      return interaction.editReply({ content: `Backup ${id} restored (best-effort).` });
    } else if (sub === 'delete') {
      const id = interaction.options.getInteger('id');
      const ok = deleteBackup(id);
      return interaction.reply({ content: ok ? 'Deleted.' : 'Not found', ephemeral: true });
    }
  },

  // Prefix message handler
  name: 'backup',
  async executeMessage(msg, { sub, args }) {
    // minimal prefix support: k!backup create NAME
    const subcmd = sub;
    if (!msg.member.permissions.has('ManageRoles') && !msg.member.permissions.has('Administrator')) return msg.reply('You need Manage Roles or Administrator to use backups.');
    if (subcmd === 'create') {
      const name = args.join(' ') || `backup-${Date.now()}`;
      const id = await createBackupManager(msg.guild, name);
      return msg.reply(`Backup created. ID: ${id}`);
    } else if (subcmd === 'list') {
      const rows = dbListBackups(msg.guild.id);
      if (!rows.length) return msg.reply('No backups found.');
      const lines = rows.map(r => `ID: ${r.id} | ${r.name} | ${new Date(r.created_at).toLocaleString()}`);
      return msg.reply(lines.join('\n'));
    } else if (subcmd === 'load') {
      const id = parseInt(args[0]);
      if (isNaN(id)) return msg.reply('Provide backup id: k!backup load <id>');
      const row = getBackup(id);
      if (!row) return msg.reply('Backup not found.');
      await restoreBackup(msg.guild, row.payload);
      return msg.reply(`Backup ${id} restored (best-effort).`);
    } else if (subcmd === 'delete') {
      const id = parseInt(args[0]);
      if (isNaN(id)) return msg.reply('Provide backup id: k!backup delete <id>');
      const ok = deleteBackup(id);
      return msg.reply(ok ? 'Deleted.' : 'Not found');
    } else {
      return msg.reply('Usage: k!backup <create|list|load|delete>');
    }
  }
};

