const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

// Charge .env sans dépendance externe AVANT de charger g3n.js,
// car g3n.js lit MISTRAL_API_KEY au chargement du module.
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

// g3n.js doit être chargé seulement après le chargement de .env.
const attachG3N = require('./g3n');

const token = process.env.BOT1_TOKEN || process.env.DISCORD_TOKEN;
if (!token || token === 'COLLE_ICI_LE_TOKEN_DE_TON_BOT') {
  console.error('BOT1_TOKEN manquant dans .env.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// Charger le nouveau système d'invitation
const setupInviteSystem = require('./systems/inviteSystem');

attachG3N(client);

// Initialiser le système d'invitation après que le client soit prêt
let inviteSystemInstance;
client.once('ready', () => {
  inviteSystemInstance = setupInviteSystem(client);
});

// Ajouter la gestion des commandes .invite et .acc
client.on('messageCreate', async message => {
  try {
    if (!message.guild || message.author.bot) return;
    if (!inviteSystemInstance) return;
    
    // Gérer la commande .invite
    if (message.content.startsWith('.invite')) {
      await inviteSystemInstance.handleInviteCommand(message);
    }
    // Gérer la commande .acc (accepter une invite manuellement)
    else if (message.content.startsWith('.acc')) {
      await inviteSystemInstance.handleAcceptCommand(message);
    }
  } catch (error) {
    console.error('[INVITE SYSTEM] Erreur dans messageCreate:', error);
  }
});

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

client.login(token);
