const fs = require('fs');
const path = require('path');
const https = require('https');

// Sécurité : si g3n.js est chargé directement, on charge quand même .env
// avant de lire MISTRAL_API_KEY. index.js le fait déjà dans le lancement normal.
(function loadEnvFallback() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '..', '.env')
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
    break;
  }
})();


const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder
} = require('discord.js');

const {
  GUILD_ID, GEN_CHANNEL_ID, TUTORIAL_CHANNEL_ID, ADMIN_PANEL_CHANNEL_ID,
  PHOTO_CHANNEL_ID, LOG_CHANNEL_ID, GENERATOR_ROLE_ID, RESTOCK_USERS,
  TOKEN_GUARD_CHANNEL_ID, TOKEN_GUARD_TIMEOUT_MS, PHOTO_REMINDER_INTERVAL_MS,
  REQUIRED_STATUS, GEN_COOLDOWN_MS, INVITE_REWARDS, INVITE_PANEL_CHANNEL_ID,
  INVITE_CHECK_ADMIN_ONLY, INVITE_CHECK_USERS, PREFIX: prefix, BASE_DIR: baseDir,
  SICARIO_GIF_URL
} = require('./config/g3nConfig');

const stockDir = path.join(baseDir, 'stock');
const dataDir = path.join(baseDir, 'data');
const blockedFile = path.join(dataDir, 'generator-blocks.json');
const pendingDir = path.join(dataDir, 'restock-pending');

fs.mkdirSync(stockDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(pendingDir, { recursive: true });

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch (_) { return fallback; }
}
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function cleanService(value) {
  return String(value || '').trim().toLowerCase();
}
function safeServiceName(value) {
  const name = cleanService(value);
  return /^[a-z0-9_-]{1,50}$/.test(name) ? name : null;
}
function getServices() {
  return fs.readdirSync(stockDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.txt'))
    .map(e => {
      const file = path.join(stockDir, e.name);
      const lines = readLines(file);
      return { name: path.basename(e.name, '.txt'), file, count: lines.length };
    })
    .sort((a,b) => a.name.localeCompare(b.name));
}
function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}
function takeOne(service) {
  const name = safeServiceName(service);
  if (!name) return { ok:false, reason:'missing' };
  const file = path.join(stockDir, `${name}.txt`);
  if (!fs.existsSync(file)) return { ok:false, reason:'missing' };
  const lines = readLines(file);
  if (!lines.length) return { ok:false, reason:'empty' };
  const line = lines.shift();
  fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  return { ok:true, line, remaining:lines.length };
}

function isRequiredStatus(member) {
  const activities = member?.presence?.activities || [];
  return activities.some(a =>
    Number(a.type) === 4 && String(a.state || '').trim() === REQUIRED_STATUS
  );
}
function blocks() { return readJson(blockedFile, {}); }
function getBlock(userId) {
  const b = blocks()[String(userId)];
  if (!b) return null;
  if (b.expiresAt && b.expiresAt !== 'permanent' && Number(b.expiresAt) <= Date.now()) {
    const all = blocks(); delete all[String(userId)]; writeJson(blockedFile, all);
    return null;
  }
  return b;
}
function setBlock(userId, data) {
  const all = blocks();
  all[String(userId)] = data;
  writeJson(blockedFile, all);
}
function removeBlock(userId) {
  const all = blocks();
  const existed = Boolean(all[String(userId)]);
  delete all[String(userId)];
  writeJson(blockedFile, all);
  return existed;
}
function durationMs(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (['perm','permanent','permanent','0'].includes(s)) return null;
  const m = s.match(/^(\d+)\s*(m|min|minute|minutes|h|hour|hours|d|day|days)$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit.startsWith('m') ? 60000 : unit.startsWith('h') ? 3600000 : 86400000;
  return n * mult;
}
function blockDescription(b) {
  const until = b.expiresAt === 'permanent'
    ? '**Permanent**'
    : `<t:${Math.floor(Number(b.expiresAt)/1000)}:R>`;
  return `**Raison :** ${b.reason || 'Non précisée'}\n**Fin :** ${until}\n**Par :** <@${b.by}>`;
}

const COLORS = { primary: 0x5865F2, success: 0x57F287, danger: 0xED4245, neutral: 0x2B2D31 };
function embed(title, description, color = COLORS.primary, imageUrl = null) {
  const builder = new EmbedBuilder()
    .setColor(color).setTitle(title).setDescription(description)
    .setFooter({ text: 'SICARIO • G3N FREE' }).setTimestamp();
  if (imageUrl) builder.setImage(imageUrl);
  return builder;
}
function serviceEmoji(guild, name) {
  const normalized = cleanService(name).replace(/[^a-z0-9_-]/g,'');
  const e = guild?.emojis?.cache?.find(x => x.name && cleanService(x.name).replace(/[^a-z0-9_-]/g,'') === normalized);
  if (!e) return '📦';
  return e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`;
}
function isAdminUser(id) { return RESTOCK_USERS.has(String(id)); }

async function logAction(client, title, description, color = COLORS.primary) {
  const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (!ch?.isTextBased()) return;
  await ch.send({ embeds: [embed(title, description, color)] }).catch(() => {});
}

async function syncMember(member, client) {
  if (!member || member.guild?.id !== GUILD_ID || member.user?.bot) return;
  const shouldHave = isRequiredStatus(member) && !getBlock(member.id);
  const hasRole = member.roles.cache.has(GENERATOR_ROLE_ID);
  if (shouldHave && !hasRole) {
    const added = await member.roles.add(GENERATOR_ROLE_ID, 'Statut G3N free valide').then(() => true).catch(e => { console.error('[ROLE ADD]', e); return false; });
    if (added) await logAction(client, '✅ Accès G3N accordé', `**Utilisateur :** <@${member.id}> (\`${member.id}\`)\n**Motif :** statut requis valide.`, COLORS.success);
  } else if (!shouldHave && hasRole) {
    const removed = await member.roles.remove(GENERATOR_ROLE_ID, 'Statut G3N free retiré ou modifié').then(() => true).catch(e => { console.error('[ROLE REMOVE]', e); return false; });
    if (removed) await logAction(client, '⛔ Accès G3N retiré', `**Utilisateur :** <@${member.id}> (\`${member.id}\`)\n**Motif :** statut absent/modifié ou accès coupé.`, COLORS.danger);
  }
}

function tutorialPayload() {
  return { embeds: [embed(
    '📖 G3N FREE — comment ça marche ? / how does it work?',
    `🇫🇷 **FRANÇAIS**\n` +
    `> Simple et rapide.\n\n` +
    `🔐 **1. Mets le statut exact**\n\`${REQUIRED_STATUS}\`\n\n` +
    `🎁 **2. Va dans le salon G3N**\nFais \.services pour voir les services, puis \.gen <service> pour recevoir une ligne en MP.\n\n` +
    `📦 **3. Pour le stock**\nFais \.stock pour voir les stocks disponibles. Cette commande n'a pas de cooldown.\n\n` +
    `⏱️ **4. Cooldown**\nLes commandes \.gen et \.services ont un cooldown de **30 minutes**.\n\n` +
    `⚠️ **5. Garde le statut**\nSi tu enlèves ou modifies le statut requis, ton accès est retiré automatiquement.\n\n` +
    `🛍️ **G3N FREE**\n.gg/sicariostore\n\n` +
    `🇬🇧 **ENGLISH**\n` +
    `> Simple and fast.\n\n` +
    `🔐 **1. Set the exact status**\n\`${REQUIRED_STATUS}\`\n\n` +
    `🎁 **2. Go to the G3N channel**\nUse \.services to see the services, then \.gen <service> to receive a line by DM.\n\n` +
    `📦 **3. Check the stock**\nUse \.stock to see available stock. This command has no cooldown.\n\n` +
    `⏱️ **4. Cooldown**\nThe \.gen and \.services commands have a **30-minute** cooldown.\n\n` +
    `⚠️ **5. Keep the status**\nIf you remove or change the required status, your access is automatically removed.\n\n` +
    `🛍️ **G3N FREE**\n.gg/sicariostore`,
    COLORS.primary
  )] };
}

async function ensureTutorial(client) {
  const channel = await client.channels.fetch(TUTORIAL_CHANNEL_ID).catch(error => {
    console.error('[TUTORIAL FETCH]', error);
    return null;
  });
  if (!channel?.isTextBased()) {
    console.error(`[TUTORIAL] Salon ${TUTORIAL_CHANNEL_ID} introuvable ou non textuel.`);
    return;
  }

  const messages = await channel.messages.fetch({ limit: 100 }).catch(error => {
    console.error('[TUTORIAL MESSAGES FETCH]', error);
    return null;
  });
  if (!messages) return;

  // Met à jour le message tutoriel existant (même ancien titre) au lieu
  // d'en créer un doublon. S'il n'existe pas, le bot en crée un nouveau.
  const tutorialMessage = messages.find(m =>
    m.author?.id === client.user?.id &&
    m.embeds?.some(e =>
      e.title === '📖 G3N — comment ça marche ?' ||
      e.title === '📖 G3N FREE — comment ça marche ? / how does it work?'
    )
  );

  try {
    if (tutorialMessage) {
      await tutorialMessage.edit(tutorialPayload());
      console.log(`[TUTORIAL] Message bilingue mis à jour dans ${TUTORIAL_CHANNEL_ID} (${tutorialMessage.id}).`);
    } else {
      const sent = await channel.send(tutorialPayload());
      console.log(`[TUTORIAL] Message bilingue envoyé dans ${TUTORIAL_CHANNEL_ID} (${sent.id}).`);
    }
  } catch (error) {
    console.error(`[TUTORIAL SEND/EDIT] Impossible d'envoyer ou modifier le message dans ${TUTORIAL_CHANNEL_ID}:`, error);
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// Traduction Mistral + rappels du salon photos
// ─────────────────────────────────────────────────────────────────────────────
function getMistralApiKey() { return String(process.env.MISTRAL_API_KEY || '').trim(); }
const MISTRAL_MODEL = 'mistral-small-latest';

const DEFAULT_TRANSLATION_LANGUAGES = {
  fr: 'Français',
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  it: 'Italiano',
  pt: 'Português',
  ar: 'العربية',
  tr: 'Türkçe',
  nl: 'Nederlands',
  pl: 'Polski'
};
const translationLanguagesFile = path.join(dataDir, 'translation-languages.json');

function getTranslationLanguages() {
  const saved = readJson(translationLanguagesFile, DEFAULT_TRANSLATION_LANGUAGES);
  const languages = {};
  for (const [code, name] of Object.entries(saved)) {
    if (/^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/i.test(code) && String(name).trim()) {
      languages[code.toLowerCase()] = String(name).trim().slice(0, 100);
    }
  }
  if (!languages.fr) languages.fr = DEFAULT_TRANSLATION_LANGUAGES.fr;
  if (!languages.en) languages.en = DEFAULT_TRANSLATION_LANGUAGES.en;
  return languages;
}

function saveTranslationLanguages(languages) {
  writeJson(translationLanguagesFile, languages);
}

function addTranslationLanguage(code, name) {
  code = String(code || '').trim().toLowerCase();
  name = String(name || '').trim();
  if (!/^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/i.test(code)) {
    throw new Error('Code langue invalide. Exemple : `ja`, `ko`, `sv` ou `zh-CN`.');
  }
  if (!name || name.length > 100) throw new Error('Nom de langue invalide.');
  const languages = getTranslationLanguages();
  if (languages[code]) throw new Error(`La langue \`${code}\` existe déjà.`);
  if (Object.keys(languages).length >= 25) throw new Error('Discord limite le menu à 25 langues. Supprime une langue avant d’en ajouter une autre.');
  languages[code] = name;
  saveTranslationLanguages(languages);
  return languages;
}

function translationButton(customId = 'translate:open') {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel('Traduire')
    .setEmoji('🌐')
    .setStyle(ButtonStyle.Secondary);
}

function translationMenu(messageId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`translate:lang:${messageId}`)
    .setPlaceholder('Choisis la langue')
    .addOptions(Object.entries(getTranslationLanguages()).slice(0, 25).map(([value, label]) => ({
      label,
      value
    })));
  return new ActionRowBuilder().addComponents(menu);
}

function componentPayloadWithTranslate() {
  return {
    components: [
      new ActionRowBuilder().addComponents(translationButton())
    ]
  };
}

function extractTranslatableEmbed(message) {
  const source = message?.embeds?.[0];
  if (!source) return null;
  return {
    title: String(source.title || ''),
    description: String(source.description || ''),
    footer: String(source.footer?.text || ''),
    fields: Array.isArray(source.fields) ? source.fields.map(field => ({
      name: String(field.name || ''),
      value: String(field.value || '')
    })) : []
  };
}

function translationText(content) {
  if (Array.isArray(content)) {
    return content.map(x => x?.text || '').join('');
  }
  return String(content || '');
}

function callMistralTranslation(payload, languageName) {
  return new Promise((resolve, reject) => {
    const mistralApiKey = getMistralApiKey();
    if (!mistralApiKey || mistralApiKey === 'COLLE_TA_CLE_MISTRAL_ICI') {
      return reject(new Error('MISTRAL_API_KEY manquante : vérifie le .env à la racine du projet et redémarre le bot.'));
    }

    const requestBody = JSON.stringify({
      model: MISTRAL_MODEL,
      temperature: 0.15,
      max_tokens: 1200,
      messages: [
        {
          role: 'system',
          content:
            `Tu es le traducteur d'un bot Discord. Traduis naturellement vers ${languageName}. ` +
            `Garde exactement le sens, le ton simple et humain. Ne rajoute aucune information. ` +
            `Conserve les emojis, mentions Discord (<@...>, <#...>), URLs, Markdown, retours à la ligne ` +
            `et blocs de code. Ne traduis pas les identifiants, commandes ou URLs. ` +
            `Retourne uniquement un objet JSON valide avec les clés title, description, footer et fields. ` +
            `fields doit être un tableau avec name et value.`
        },
        {
          role: 'user',
          content: JSON.stringify(payload)
        }
      ]
    });

    const req = https.request({
      hostname: 'api.mistral.ai',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${mistralApiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody)
      },
      timeout: 30000
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Mistral HTTP ${res.statusCode}`));
        }
        try {
          const parsed = JSON.parse(body);
          const content = translationText(parsed?.choices?.[0]?.message?.content);
          if (!content) throw new Error('Réponse Mistral vide.');
          const cleaned = content
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
          const result = JSON.parse(cleaned);
          resolve(result);
        } catch (error) {
          reject(new Error(`Réponse Mistral invalide : ${error.message}`));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('Mistral timeout')));
    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
}

function translatedEmbed(result, languageName) {
  const e = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(String(result.title || 'Traduction'))
    .setDescription(String(result.description || ''))
    .setFooter({ text: `🌐 ${languageName} • SICARIO • G3N FREE` })
    .setTimestamp();

  if (Array.isArray(result.fields)) {
    for (const field of result.fields.slice(0, 25)) {
      const name = String(field?.name || '').slice(0, 256);
      const value = String(field?.value || '').slice(0, 1024);
      if (name && value) e.addFields({ name, value, inline: Boolean(field?.inline) });
    }
  }
  return e;
}

const photoReminderFile = path.join(dataDir, 'photo-reminder.json');

function getPhotoReminderState() {
  return readJson(photoReminderFile, {
    lastReminderAt: 0,
    lastReminderMessageId: null,
    lastEligibleMessageId: null
  });
}

function savePhotoReminderState(state) {
  writeJson(photoReminderFile, state);
}

function snowflakeAfter(a, b) {
  if (!a) return Boolean(b);
  if (!b) return false;
  try { return BigInt(b) > BigInt(a); } catch { return false; }
}

function photoReminderPayload() {
  return {
    embeds: [embed(
      '📸 G3N FREE — partage tes photos',
      `Ici, tu peux envoyer **une photo** ou **du texte avec une photo**. 📷\n\n` +
      `⏱️ Un petit rappel peut apparaître toutes les **3 heures**, uniquement s’il y a eu un nouveau message photo depuis le dernier rappel.\n\n` +
      `💡 Une légende avec ta photo est totalement autorisée.`,
      COLORS.primary
    )],
    ...componentPayloadWithTranslate()
  };
}

async function markEligiblePhotoMessage(message) {
  if (!message || message.author?.bot || message.channel?.id !== PHOTO_CHANNEL_ID) return;
  if (!photoOnly(message)) return;
  const state = getPhotoReminderState();
  state.lastEligibleMessageId = message.id;
  savePhotoReminderState(state);
}

async function ensurePhotoReminder(client, initializeOnly = false) {
  const channel = await client.channels.fetch(PHOTO_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) return;

  const state = getPhotoReminderState();
  const now = Date.now();

  // Au premier démarrage, ou si le message de rappel n'existe plus,
  // on crée l'embed dans le salon photos immédiatement.
  if (!state.lastReminderMessageId) {
    const sent = await channel.send(photoReminderPayload()).catch(error => {
      console.error('[PHOTO REMINDER SEND]', error);
      return null;
    });
    if (sent) {
      state.lastReminderAt = now;
      state.lastReminderMessageId = sent.id;
      savePhotoReminderState(state);
    }
    return;
  }

  if (initializeOnly || now - Number(state.lastReminderAt) < PHOTO_REMINDER_INTERVAL_MS) return;
  if (!snowflakeAfter(state.lastReminderMessageId, state.lastEligibleMessageId)) return;

  const sent = await channel.send(photoReminderPayload()).catch(error => {
    console.error('[PHOTO REMINDER]', error);
    return null;
  });
  if (!sent) return;

  state.lastReminderAt = now;
  state.lastReminderMessageId = sent.id;
  savePhotoReminderState(state);
}

async function openTranslation(client, interaction, messageId) {
  if (interaction.channelId !== PHOTO_CHANNEL_ID && interaction.channelId !== TOKEN_GUARD_CHANNEL_ID) {
    return interaction.reply({ content: '❌ La traduction n’est pas disponible dans ce salon.', ephemeral: true });
  }
  const channel = await client.channels.fetch(interaction.channelId).catch(() => null);
  const target = await channel?.messages.fetch(messageId).catch(() => null);
  if (!target?.embeds?.length) {
    return interaction.reply({ content: '❌ Le message à traduire est introuvable.', ephemeral: true });
  }
  return interaction.reply({
    content: '🌐 **Choisis la langue de traduction :**',
    components: [translationMenu(messageId)],
    ephemeral: true
  });
}

async function handleTranslationSelection(client, interaction, messageId, languageCode) {
  if (interaction.channelId !== PHOTO_CHANNEL_ID && interaction.channelId !== TOKEN_GUARD_CHANNEL_ID) {
    return interaction.reply({ content: '❌ La traduction n’est pas disponible ici.', ephemeral: true });
  }

  const languageName = getTranslationLanguages()[languageCode];
  if (!languageName) return interaction.reply({ content: '❌ Langue invalide.', ephemeral: true });

  const channel = await client.channels.fetch(interaction.channelId).catch(() => null);
  const target = await channel?.messages.fetch(messageId).catch(() => null);
  const source = extractTranslatableEmbed(target);
  if (!source) return interaction.reply({ content: '❌ Impossible de lire cet embed.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  try {
    const translated = await callMistralTranslation(source, languageName);
    const output = translatedEmbed(translated, languageName);
    return interaction.editReply({
      embeds: [output],
      content: `🌐 **Traduction en ${languageName}**`,
      components: []
    });
  } catch (error) {
    console.error('[MISTRAL TRANSLATION]', error);
    return interaction.editReply({
      content: `❌ Impossible de traduire pour le moment.\n> ${error.message}`,
      embeds: [],
      components: []
    });
  }
}

const tokenGuardCountFile = path.join(dataDir, 'token-guard-sanctions.json');

function getTokenGuardCount() {
  const data = readJson(tokenGuardCountFile, { count: 0 });
  return Math.max(0, Number(data.count) || 0);
}

function incrementTokenGuardCount() {
  const count = getTokenGuardCount() + 1;
  writeJson(tokenGuardCountFile, { count });
  return count;
}

const tokenGuardPanelFile = path.join(dataDir, 'token-guard-panel.json');

async function ensureTokenGuardPanel(client) {
  const channel = await client.channels.fetch(TOKEN_GUARD_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) return null;

  const state = readJson(tokenGuardPanelFile, { messageId: null });
  let existing = null;

  if (state.messageId) {
    existing = await channel.messages.fetch(state.messageId).catch(() => null);
    if (existing?.author?.id !== client.user?.id) existing = null;
  }

  if (!existing) {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    existing = messages?.find(m =>
      m.author?.id === client.user?.id &&
      m.embeds?.some(e => e.title === 'Protection Token Grab')
    ) || null;
  }

  const count = getTokenGuardCount();
  const payload = {
    embeds: [embed(
      '🛡️ Protection Token Grab',
      `Ce salon est **protégé automatiquement**. 🔒\n\n` +
      `N’envoyez pas de tokens, captures de tokens ou contenu destiné à récupérer des tokens.\n\n` +
      `🗑️ Les messages sont supprimés après **30 secondes** et l’auteur reçoit un **timeout de 1 heure**.\n\n` +
      `📊 **Sanctions appliquées :** \`${count}\``,
      COLORS.danger
    )],
    ...componentPayloadWithTranslate()
  };

  if (existing) {
    await existing.edit(payload).catch(error => console.error('[TOKEN PANEL EDIT]', error));
  } else {
    existing = await channel.send(payload).catch(error => {
      console.error('[TOKEN PANEL SEND]', error);
      return null;
    });
  }

  if (existing) {
    state.messageId = existing.id;
    writeJson(tokenGuardPanelFile, state);
  }
  return existing;
}

async function punishTokenGuardMessage(message, client) {
  const recent = new Set([message.id]);
  const channel = message.channel;

  // On laisse 30 secondes avant de supprimer les messages récents de l'utilisateur.
  await new Promise(resolve => setTimeout(resolve, 30_000));

  const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (fetched) {
    for (const m of fetched.values()) {
      if (m.author?.id === message.author.id && Date.now() - m.createdTimestamp <= 60_000) {
        recent.add(m.id);
      }
    }
  }

  for (const id of recent) {
    const m = fetched?.get(id) || message;
    if (m?.author?.id === message.author.id) {
      await m.delete().catch(() => {});
    }
  }

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (member?.moderatable) {
    await member.timeout(TOKEN_GUARD_TIMEOUT_MS, 'Protection anti-token grab').catch(() => {});
  }

  const count = incrementTokenGuardCount();
  await ensureTokenGuardPanel(client);

  await logAction(
    client,
    'Protection anti-token grab',
    `**Utilisateur :** <@${message.author.id}> (\`${message.author.id}\`)\n` +
    `**Salon :** <#${TOKEN_GUARD_CHANNEL_ID}>\n` +
    `**Sanction :** timeout 1 heure\n` +
    `**Messages supprimés :** messages récents détectés\n` +
    `**Total des sanctions :** \`${count}\``,
    COLORS.danger
  );
}

module.exports = function attachG3N(client) {

const cooldownFile = path.join(dataDir, 'generator-cooldowns.json');
const cooldowns = readJson(cooldownFile, {});

const inviteRewardsFile = path.join(dataDir, 'invite-rewards.json');
const inviteRewards = readJson(inviteRewardsFile, {});
const inviteCache = new Map();

function getInviteStats(userId) {
  const value = inviteRewards[String(userId)] || { invites: 0, rewards: {} };
  return { invites: Number(value.invites || 0), rewards: value.rewards || {} };
}
function saveInviteStats(userId, value) {
  inviteRewards[String(userId)] = value;
  writeJson(inviteRewardsFile, inviteRewards);
}
function getActiveInviteReward(userId) {
  const stats = getInviteStats(userId);
  const now = Date.now();
  let best = null;
  for (const reward of (INVITE_REWARDS || [])) {
    const expiresAt = Number(stats.rewards[String(reward.invites)] || 0);
    if (expiresAt > now && (!best || reward.cooldownMs < best.cooldownMs)) best = { ...reward, expiresAt };
  }
  return best;
}
function getEffectiveCooldownMs(userId) {
  return getActiveInviteReward(userId)?.cooldownMs || GEN_COOLDOWN_MS;
}
function invitePanelPayload() {
  const rewards = (INVITE_REWARDS || []).sort((a,b)=>a.invites-b.invites).map(r =>
    `🎁 **${r.invites} invitations** → cooldown de **${Math.round(r.cooldownMs/60000)} min** pendant **${Math.round(r.durationMs/3600000)}h**`
  );
  return { embeds:[embed('🎉 Récompenses d’invitations',
    `Invite des membres et débloque temporairement un meilleur cooldown.\n\n${rewards.join('\n')}\n\n📌 Les invitations sont comptées automatiquement quand un nouveau membre rejoint le serveur.`, COLORS.primary)] };
}
function inviteCooldownMessage(remaining, cooldownMs) {
  const mins = Math.ceil(remaining / 60000);
  return `Tu dois patienter encore **${mins} min**.\n\n⏱️ Ton cooldown actuel : **${Math.round(cooldownMs / 60000)} minutes**.`;
}
function isInviteCheckAdmin(userId, member) {
  if (INVITE_CHECK_USERS?.has(String(userId))) return true;
  return !!member?.permissions?.has('Administrator');
}

function getCooldown(userId) {
  const value = Number(cooldowns[String(userId)] || 0);
  return Number.isFinite(value) ? value : 0;
}

function setCooldown(userId, timestamp) {
  cooldowns[String(userId)] = timestamp;
  writeJson(cooldownFile, cooldowns);
}

function cooldownMessage(remaining, cooldownMs = GEN_COOLDOWN_MS) {
  return inviteCooldownMessage(remaining, cooldownMs);
}

client.once('ready', async () => {
  console.log(`[G3N] ${client.user.tag} connecté.`);
  const readyGuild = await client.guilds.fetch(GUILD_ID).catch(()=>null);
  if (readyGuild) {
    const invites = await readyGuild.invites.fetch().catch(()=>null);
    if (invites) inviteCache.set(readyGuild.id, new Map(invites.map(i => [i.code, i.uses || 0])));
  }
  // Ancien panel d'invitation désactivé - remplacé par inviteSystem.js
  // if (INVITE_PANEL_CHANNEL_ID) {
  //   const panelChannel = await client.channels.fetch(INVITE_PANEL_CHANNEL_ID).catch(()=>null);
  //   if (panelChannel?.isTextBased()) await panelChannel.send(invitePanelPayload()).catch(()=>{});
  // }
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (guild) {
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const role = guild.roles.cache.get(GENERATOR_ROLE_ID);
    if (me && role) {
      const canManage = me.permissions.has('ManageRoles');
      const above = me.roles.highest.position > role.position;
      if (!canManage || !above) {
        console.error(`[PERMISSIONS] Impossible d'ajouter le rôle ${GENERATOR_ROLE_ID}. Le bot doit avoir la permission Gérer les rôles et son rôle doit être placé AU-DESSUS du rôle générateur.`);
      }
    }
    const members = await guild.members.fetch().catch(() => null);
    if (members) for (const member of members.values()) await syncMember(member, client);
    await ensureTutorial(client);
    await ensureTokenGuardPanel(client);
    await ensurePhotoReminder(client, true);
  }
});

setInterval(() => {
  ensurePhotoReminder(client).catch(error => console.error('[PHOTO REMINDER]', error));
}, 60 * 1000);

setInterval(async () => {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return;
  for (const member of members.values()) {
    if (member.user.bot) continue;
    await syncMember(member, client);
  }
}, 60 * 1000);

client.on('presenceUpdate', async (_oldPresence, newPresence) => {
  if (newPresence?.guild?.id !== GUILD_ID) return;
  const member = newPresence.member || await newPresence.guild.members.fetch(newPresence.userId).catch(() => null);
  if (member) await syncMember(member, client);
});

client.on('guildMemberAdd', member => {
  if (member.guild.id === GUILD_ID) syncMember(member, client);
});

function photoOnly(message) {
  if (message.attachments.size === 0) return false;
  // Une légende/du texte accompagnant une image est autorisé.
  return [...message.attachments.values()].every(a => {
    const type = String(a.contentType || '').toLowerCase();
    const name = String(a.name || '').toLowerCase();
    return type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name);
  });
}

function pendingPath(userId) { return path.join(pendingDir, `${userId}.txt`); }
function hasPending(userId) { return fs.existsSync(pendingPath(userId)); }
function pendingContent(userId) {
  const f = pendingPath(userId);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}
function clearPending(userId) {
  const f = pendingPath(userId);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
function download(url, destination) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(download(res.headers.location, destination));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const out = fs.createWriteStream(destination);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}
function addPendingToService(userId, service, createIfMissing) {
  const name = safeServiceName(service);
  if (!name) throw new Error('Nom invalide : lettres, chiffres, `_` et `-` uniquement.');
  const content = pendingContent(userId);
  if (content === null) throw new Error('Aucun fichier en attente.');
  const incoming = content.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if (!incoming.length) throw new Error('Le fichier `.txt` est vide.');
  const file = path.join(stockDir, `${name}.txt`);
  if (fs.existsSync(file) && createIfMissing) throw new Error(`Le stock **${name}** existe déjà.`);
  if (!fs.existsSync(file) && !createIfMissing) throw new Error(`Le stock **${name}** n’existe pas.`);
  const existing = fs.existsSync(file) ? readLines(file) : [];
  fs.writeFileSync(file, `${[...existing, ...incoming].join('\n')}\n`, 'utf8');
  clearPending(userId);
  return { name, added: incoming.length, total: existing.length + incoming.length };
}



function adminPanelPayload() {
  const e = embed(
    '🛠️ G3N — Admin Panel',
    `> Gestion rapide du générateur free.\n\n` +
    `🌐 **Langues** — ajoute une langue au système de traduction depuis ce panel.\n` +
    `🔒 **Couper le G3N** — bloque un utilisateur même si son statut est correct.\n` +
    `♻️ **Déban** — retire le blocage.\n` +
    `📥 **Add Restock** — reçoit un fichier \`.txt\` en MP puis permet de l'ajouter à un stock ou de créer un nouveau service.\n\n` +
    `Les actions sont journalisées dans <#${LOG_CHANNEL_ID}>.`,
    COLORS.neutral
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin:block').setLabel('Couper le G3N').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('admin:unblock').setLabel('Déban').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin:restock').setLabel('Add Restock').setEmoji('📥').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('admin:language').setLabel('Ajouter une langue').setEmoji('🌐').setStyle(ButtonStyle.Primary)
  );
  return { embeds:[e], components:[row] };
}

client.on('inviteCreate', invite => {
  if (!invite.guild) return;
  const cache = inviteCache.get(invite.guild.id) || new Map();
  cache.set(invite.code, invite.uses || 0);
  inviteCache.set(invite.guild.id, cache);
});
client.on('inviteDelete', invite => {
  const cache = inviteCache.get(invite.guild?.id);
  cache?.delete(invite.code);
});
// Ancien système d'invitation désactivé - remplacé par inviteSystem.js
// client.on('guildMemberAdd', async member => {
//   if (member.guild.id !== GUILD_ID || member.user.bot) return;
//   const before = inviteCache.get(member.guild.id) || new Map();
//   const invites = await member.guild.invites.fetch().catch(()=>null);
//   if (!invites) return;
//   const used = invites.find(inv => (inv.uses || 0) > (before.get(inv.code) || 0));
//   inviteCache.set(member.guild.id, new Map(invites.map(i => [i.code, i.uses || 0])));
//   if (!used?.inviterId) return;
//   const inviterId = used.inviterId;
//   const stats = getInviteStats(inviterId);
//   stats.invites += 1;
//   const now = Date.now();
//   for (const reward of (INVITE_REWARDS || [])) {
//     if (stats.invites >= reward.invites) {
//       const key = String(reward.invites);
//       const oldExpiry = Number(stats.rewards[key] || 0);
//       if (oldExpiry <= now) stats.rewards[key] = now + reward.durationMs;
//     }
//   }
//   saveInviteStats(inviterId, stats);
// });

client.on('messageCreate', async message => {
  try {
    if (!message.guild) {
      if (!isAdminUser(message.author.id) || message.author.bot) return;
      const attachment = [...message.attachments.values()].find(a => {
        const name = String(a.name || '').toLowerCase();
        return name.endsWith('.txt');
      });
      if (!attachment) return;
      if (Number(attachment.size || 0) > 10 * 1024 * 1024) {
        return message.reply({ embeds:[embed('❌ Fichier refusé', 'Le fichier dépasse la limite de **10 Mo**.')] });
      }
      const destination = pendingPath(message.author.id);
      try {
        await download(attachment.url, destination);
        const channel = await client.channels.fetch(ADMIN_PANEL_CHANNEL_ID).catch(()=>null);
        if (channel?.isTextBased()) {
          await channel.send({
            embeds:[embed('📥 Restock reçu',
              `Le fichier de <@${message.author.id}> est prêt.\n\n` +
              `Utilise le bouton ci-dessous pour choisir **le stock à alimenter** ou créer un **nouveau service**.`)],
            components:[new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`restock:open:${message.author.id}`).setLabel('Gérer le restock').setEmoji('📦').setStyle(ButtonStyle.Primary)
            )]
          });
        }
        return message.reply({ embeds:[embed('✅ Fichier reçu', `Ton \`.txt\` a bien été reçu.\n\nRetourne dans <#${ADMIN_PANEL_CHANNEL_ID}> pour choisir le stock.`)] });
      } catch (e) {
        console.error('[RESTOCK DM]', e);
        return message.reply({ embeds:[embed('❌ Restock impossible', 'Je n’ai pas réussi à récupérer ton fichier `.txt`.')] });
      }
    }

    if (message.author.bot) return;
    if (message.guild.id !== GUILD_ID) return;

    // Salon de protection anti-token grab.
    if (message.channel.id === TOKEN_GUARD_CHANNEL_ID) {
      // Le message de protection du bot n'est jamais sanctionné.
      if (!message.author.bot) {
        punishTokenGuardMessage(message, client).catch(error => console.error('[TOKEN GUARD]', error));
      }
      return;
    }

    // Salon photos : une image est obligatoire. Le texte/légende avec l'image est autorisé.
    if (message.channel.id === PHOTO_CHANNEL_ID) {
      if (photoOnly(message)) {
        await markEligiblePhotoMessage(message);
        return;
      }
      const reply = await message.reply({
        embeds:[embed('📸 Photos uniquement', `Ce salon est réservé aux **photos**.\n\nTu peux envoyer une image **avec ou sans texte/légende**. 📸`)]
      }).catch(()=>null);
      setTimeout(() => message.delete().catch(()=>{}), 5000);
      if (reply) setTimeout(() => reply.delete().catch(()=>{}), 5000);
      await logAction(client, '📸 Message supprimé',
        `**Salon :** <#${PHOTO_CHANNEL_ID}>\n**Utilisateur :** <@${message.author.id}> (\`${message.author.id}\`)\n**Motif :** contenu non autorisé dans le salon photos.`,
        COLORS.neutral);
      return;
    }

    const commandText = message.content.trim();

    // Ancienne commande .checkinvite désactivée - remplacée par .invite dans inviteSystem.js
    // if (commandText.toLowerCase().startsWith('.checkinvite')) {
    //   if (!isInviteCheckAdmin(message.author.id, message.member) && INVITE_CHECK_ADMIN_ONLY) {
    //     return message.reply({ embeds:[embed('⛔ Accès refusé', 'Cette commande est réservée aux administrateurs.', COLORS.danger)] });
    //   }
    //   const target = message.mentions.users.first();
    //   if (!target) return message.reply({ embeds:[embed('🎁 Invitations', 'Utilisation : `.checkinvite @user`', COLORS.neutral)] });
    //   const stats = getInviteStats(target.id);
    //   const active = getActiveInviteReward(target.id);
    //   return message.reply({ embeds:[embed('🎁 Invitations',
    //     `👤 ${target}\n📨 Invitations comptabilisées : **${stats.invites}**\n` +
    //     (active ? `⏱️ Bonus actif : **${Math.round(active.cooldownMs/60000)} min** jusqu'à <t:${Math.floor(active.expiresAt/1000)}:R>` : '⏱️ Aucun bonus actif.'),
    //     COLORS.primary)] });
    // }


    if (message.channel.id === TUTORIAL_CHANNEL_ID && commandText.toLowerCase() === '.tuto') {
      return message.channel.send(tutorialPayload());
    }

    if (message.channel.id === ADMIN_PANEL_CHANNEL_ID && commandText.toLowerCase() === '.adminpanel') {
      if (!isAdminUser(message.author.id)) {
        return message.reply({ embeds:[embed('⛔ Accès refusé', 'Tu n’as pas accès au panneau administrateur.', COLORS.danger)] });
      }
      return message.channel.send(adminPanelPayload());
    }

    if (message.channel.id !== GEN_CHANNEL_ID) return;
    if (!commandText.startsWith(prefix)) return;

    const parts = commandText.split(/\s+/);
    const command = parts.shift().toLowerCase();

    // Accès uniquement avec le statut exact + absence de blocage.
    const member = message.member;
    if (!member) return;

    const block = getBlock(message.author.id);
    const statusOk = isRequiredStatus(member);
    const accessOk = statusOk && !block;

    if (command === '.stock' || command === '.gen') {
      if (!accessOk) {
        return message.reply({ embeds:[embed('🔒 Accès refusé',
          block
            ? `Ton accès G3N est actuellement **coupé**.\n\n${blockDescription(block)}`
            : `Pour utiliser le G3N, ton **statut Discord doit être exactement** :\n\n\`${REQUIRED_STATUS}\`\n\n` +
              `Si tu modifies ou retires ce statut, ton rôle G3N est retiré automatiquement.`,
          COLORS.danger)] });
      }
    }

    if (command === '.help' || command === '.aide') {
      return message.reply({ embeds:[embed('🤖 G3N free',
        `> Démo du fonctionnement du **G3N free payant**.

` +
        `🔐 **Statut obligatoire**
\`${REQUIRED_STATUS}\`

` +
        `⏱️ **Cooldown**
Une génération toutes les **30 minutes** par utilisateur.

` +
        `📦 **Commandes**
\`.stock\` — voir les stocks\n\`.services\` — voir les services\n\`.gen <service>\` — recevoir une ligne en MP

` +
        `🛒 **G3N free payant**
Pour découvrir l'offre :\nhttps://sicariostore.mykomerza.com/category?slug=25481986-1469-418f-8510-1b40a461928a`,
        COLORS.primary)] });
    }

    if (command === '.services') {
      const now = Date.now();
      const last = getCooldown(message.author.id);
      const remaining = GEN_COOLDOWN_MS - (now - last);
      if (remaining > 0) {
        return message.reply({ embeds:[embed('⏳ Cooldown', cooldownMessage(remaining, effectiveCooldown), COLORS.neutral)] });
      }
      const services = getServices();
      const lines = services.map(s => `${serviceEmoji(message.guild,s.name)} **${s.name}** · \`${s.count}\``);
      setCooldown(message.author.id, now);
      return message.reply({ embeds:[embed('📦 Services disponibles',
        lines.length ? lines.join('\n') : 'Aucun service n’est disponible actuellement.',
        COLORS.primary,
        SICARIO_GIF_URL
      )] });
    }

    if (command === '.stock') {
      const services = getServices();
      const available = services.filter(s=>s.count>0);
      const empty = services.filter(s=>s.count===0);
      const total = services.reduce((n,s)=>n+s.count,0);
      const list = [
        `> 📦 **${total}** ligne(s) disponibles au total`,
        '',
        '### 🟢 Disponibles',
        available.length ? available.map(s=>`${serviceEmoji(message.guild,s.name)} **${s.name}** · \`${s.count}\``).join('\n') : '*Aucun service disponible.*',
        '',
        '### 🔴 Épuisés',
        empty.length ? empty.map(s=>`${serviceEmoji(message.guild,s.name)} **${s.name}** · \`0\``).join('\n') : '*Aucun service épuisé.*'
      ];
      return message.reply({ embeds:[embed('📦 STOCK SICARIO', list.join('\n'), available.length ? COLORS.primary : COLORS.danger)] });
    }

    if (command === '.gen') {
      const now = Date.now();
      const last = getCooldown(message.author.id);
      const effectiveCooldown = getEffectiveCooldownMs(message.author.id);
      const remaining = effectiveCooldown - (now-last);
      if (remaining > 0) {
        return message.reply({ embeds:[embed('⏳ Cooldown',
          cooldownMessage(remaining, effectiveCooldown), COLORS.neutral)] });
      }
      const service = cleanService(parts[0]);
      if (!service) return message.reply({ embeds:[embed('🎁 G3N',
        `Utilisation : \`.gen <service>\`\n\nExemple : \`.gen netflix\`\n\nUtilise \`.stock\` pour voir les disponibilités.`)] });
      const result = takeOne(service);
      if (!result.ok) {
        return message.reply({ embeds:[embed(result.reason === 'missing' ? '📦 Service introuvable' : '📭 Stock épuisé',
          result.reason === 'missing'
            ? `Le service **${service}** n’existe pas.`
            : `Le stock **${service}** est vide.`, COLORS.danger)] });
      }
      try {
        await message.author.send({ embeds:[embed(
          `🎁 G3N — ${service}`,
          `> Ta génération est prête.\n\n🔐 **Ligne**\n\`${String(result.line).replace(/`/g,'\\`')}\`\n\n📦 **Stock restant :** \`${result.remaining}\`\n\n*Ne partage pas cette ligne publiquement.*`,
          COLORS.success,
          SICARIO_GIF_URL
        )]});
      } catch (_) {
        const file = path.join(stockDir, `${service}.txt`);
        const current = fs.existsSync(file) ? fs.readFileSync(file,'utf8') : '';
        fs.writeFileSync(file, `${result.line}\n${current}`, 'utf8');
        return message.reply({ embeds:[embed('📨 MP fermé',
          'Je ne peux pas t’envoyer la génération en MP.\n\nActive tes messages privés puis réessaie. La ligne a été remise en stock.', COLORS.danger)] });
      }
      setCooldown(message.author.id, now);
      return message.reply({ embeds:[embed('✅ Génération envoyée',
        `**Service :** \`${service}\`\n**Stock restant :** \`${result.remaining}\`\n\n📨 La ligne vient de t’être envoyée en MP.\n⏱️ **Prochaine génération : dans 30 minutes.**`, 
        COLORS.success,
        SICARIO_GIF_URL
      )] });
    }
  } catch (error) {
    console.error('[MESSAGE]', error);
  }
});

client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isButton() && !interaction.isModalSubmit() && !interaction.isStringSelectMenu()) return;

    const id = interaction.customId;

    // Traduction des embeds dans les deux salons concernés.
    if (id === 'translate:open') {
      return openTranslation(client, interaction, interaction.message?.id);
    }

    if (interaction.isStringSelectMenu() && id.startsWith('translate:lang:')) {
      const messageId = id.split(':')[2];
      const languageCode = interaction.values?.[0];
      return handleTranslationSelection(client, interaction, messageId, languageCode);
    }

    if (id.startsWith('admin:')) {
      if (!isAdminUser(interaction.user.id) || interaction.channelId !== ADMIN_PANEL_CHANNEL_ID) {
        return interaction.reply({ content:'⛔ Action réservée aux administrateurs du G3N.', ephemeral:true });
      }
      if (id === 'admin:block') {
        const modal = new ModalBuilder().setCustomId('modal:block').setTitle('Couper le G3N');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('userId').setLabel('ID utilisateur').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duration').setLabel('Durée (30m, 2h, 7d ou permanent)').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Raison').setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        return interaction.showModal(modal);
      }
      if (id === 'admin:unblock') {
        const modal = new ModalBuilder().setCustomId('modal:unblock').setTitle('Déban G3N');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('userId').setLabel('ID utilisateur').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Raison').setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        return interaction.showModal(modal);
      }
      if (id === 'admin:language') {
        const modal = new ModalBuilder().setCustomId('modal:language').setTitle('Ajouter une langue');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('code').setLabel('Code langue').setPlaceholder('ja, ko, sv, zh-CN...').setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('name').setLabel('Nom de la langue').setPlaceholder('日本語, 한국어, Svenska...').setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      if (id === 'admin:restock') {
        await interaction.reply({ embeds:[embed('📥 Add Restock',
          `Je t’envoie les instructions en **MP**.\n\nEnvoie-moi ensuite ton fichier \`.txt\` ici en message privé. Il sera redirigé vers <#${ADMIN_PANEL_CHANNEL_ID}> pour choisir le service.`
        )], ephemeral:true });
        const dm = await interaction.user.send({ embeds:[embed('📥 Restock — fichier .txt',
          `Envoie maintenant ton fichier **.txt** dans ce MP.\n\n> Après réception, tu pourras choisir **Ajouter à un stock** ou **Créer un service**.`)] }).catch(()=>null);
        if (!dm) return interaction.followUp({ content:'❌ Impossible de t’envoyer un MP. Active tes MP puis réessaie.', ephemeral:true });
        return;
      }
    }

    if (id.startsWith('restock:open:')) {
      const owner = id.split(':')[2];
      if (String(owner) !== String(interaction.user.id) || !isAdminUser(interaction.user.id)) {
        return interaction.reply({ content:'⛔ Ce gestionnaire ne t’est pas destiné.', ephemeral:true });
      }
      if (!hasPending(interaction.user.id)) return interaction.reply({ content:'❌ Aucun fichier en attente.', ephemeral:true });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('restock:add').setLabel('Ajouter à un stock').setEmoji('➕').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('restock:new').setLabel('Créer un service').setEmoji('🆕').setStyle(ButtonStyle.Success)
      );
      return interaction.reply({ embeds:[embed('📦 Gestion du restock',
        `Ton fichier est prêt.\n\nChoisis où l’ajouter :\n\n➕ **Ajouter à un stock existant**\n🆕 **Créer un nouveau service**\n\nLe fichier est identifié comme venant de **${interaction.user.tag}**.`)], components:[row], ephemeral:true });
    }

    if (id === 'restock:add') {
      if (!isAdminUser(interaction.user.id) || !hasPending(interaction.user.id)) return interaction.reply({ content:'❌ Aucun restock en attente.', ephemeral:true });
      const services = getServices().slice(0,25);
      if (!services.length) return interaction.reply({ content:'❌ Aucun service existant. Utilise **Créer un service**.', ephemeral:true });
      const menu = new StringSelectMenuBuilder().setCustomId('restock:choose').setPlaceholder('Choisir le stock')
        .addOptions(services.map(s=>({label:s.name.slice(0,100),value:s.name,description:`Stock actuel : ${s.count}`})));
      return interaction.reply({ embeds:[embed('➕ Ajouter à un stock','Choisis le service à alimenter.')], components:[new ActionRowBuilder().addComponents(menu)], ephemeral:true });
    }

    if (id === 'restock:new') {
      if (!isAdminUser(interaction.user.id) || !hasPending(interaction.user.id)) return interaction.reply({ content:'❌ Aucun restock en attente.', ephemeral:true });
      const modal = new ModalBuilder().setCustomId('modal:restock:new').setTitle('Créer un service');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('name').setLabel('Nom du service').setPlaceholder('netflix').setStyle(TextInputStyle.Short).setRequired(true)
      ));
      return interaction.showModal(modal);
    }

    if (id === 'restock:confirm') {
      if (!isAdminUser(interaction.user.id) || !hasPending(interaction.user.id)) return interaction.reply({ content:'❌ Aucun restock en attente.', ephemeral:true });
      const service = interaction.message?.embeds?.[0]?.data?.footer?.text ? null : null;
      return interaction.reply({ content:'❌ Utilise le menu de sélection pour choisir le stock.', ephemeral:true });
    }

    if (interaction.isStringSelectMenu() && id === 'restock:choose') {
      if (!isAdminUser(interaction.user.id) || !hasPending(interaction.user.id)) return interaction.reply({ content:'❌ Aucun restock en attente.', ephemeral:true });
      const service = interaction.values[0];
      await interaction.deferUpdate();
      try {
        const result = addPendingToService(interaction.user.id, service, false);
        await interaction.editReply({ embeds:[embed('✅ Restock ajouté',
          `**Service :** \`${result.name}\`\n\n➕ **${result.added}** ligne(s) ajoutée(s)\n📦 **Stock total :** \`${result.total}\`\n👤 **Ajouté par :** ${interaction.user.tag}`, COLORS.success)], components:[] });
        await logAction(client, '📥 Restock ajouté',
          `**Service :** \`${result.name}\`\n**Lignes ajoutées :** \`${result.added}\`\n**Nouveau stock :** \`${result.total}\`\n**Par :** <@${interaction.user.id}>`,
          COLORS.success);
      } catch (e) {
        return interaction.editReply({ embeds:[embed('❌ Restock impossible', e.message, COLORS.danger)], components:[] });
      }
      return;
    }

    if (interaction.isModalSubmit() && id === 'modal:block') {
      if (!isAdminUser(interaction.user.id)) return interaction.reply({ content:'⛔ Action refusée.', ephemeral:true });
      const userId = interaction.fields.getTextInputValue('userId').trim();
      const duration = interaction.fields.getTextInputValue('duration').trim();
      const reason = interaction.fields.getTextInputValue('reason').trim();
      if (!/^\d{17,20}$/.test(userId)) return interaction.reply({ content:'❌ ID Discord invalide.', ephemeral:true });
      const ms = durationMs(duration);
      if (ms === undefined || (ms !== null && ms <= 0)) return interaction.reply({ content:'❌ Durée invalide. Exemple : `30m`, `2h`, `7d` ou `permanent`.', ephemeral:true });
      const expiresAt = ms === null ? 'permanent' : Date.now()+ms;
      setBlock(userId, { reason, by:interaction.user.id, createdAt:Date.now(), expiresAt });
      const guild = await client.guilds.fetch(GUILD_ID).catch(()=>null);
      const member = await guild?.members.fetch(userId).catch(()=>null);
      if (member?.roles.cache.has(GENERATOR_ROLE_ID)) await member.roles.remove(GENERATOR_ROLE_ID, `G3N coupé: ${reason}`).catch(()=>{});
      await interaction.reply({ embeds:[embed('🔒 G3N coupé',
        `**Utilisateur :** <@${userId}>\n${blockDescription({reason,by:interaction.user.id,expiresAt})}`, COLORS.danger)], ephemeral:true });
      await logAction(client, '🔒 G3N coupé',
        `**Utilisateur :** <@${userId}> (\`${userId}\`)\n${blockDescription({reason,by:interaction.user.id,expiresAt})}`,
        COLORS.danger);
      return;
    }

    if (interaction.isModalSubmit() && id === 'modal:unblock') {
      if (!isAdminUser(interaction.user.id)) return interaction.reply({ content:'⛔ Action refusée.', ephemeral:true });
      const userId = interaction.fields.getTextInputValue('userId').trim();
      const reason = interaction.fields.getTextInputValue('reason').trim();
      if (!/^\d{17,20}$/.test(userId)) return interaction.reply({ content:'❌ ID Discord invalide.', ephemeral:true });
      const existed = removeBlock(userId);
      if (existed) {
        const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
        const member = await guild?.members.fetch(userId).catch(() => null);
        if (member) await syncMember(member, client);
      }
      await interaction.reply({ embeds:[embed(existed ? '♻️ G3N rétabli' : 'ℹ️ Aucun blocage',
        `**Utilisateur :** <@${userId}>\n**Raison :** ${reason}\n\nLe blocage manuel ${existed ? 'a été retiré.' : 'n’était pas présent.'}`, existed ? COLORS.success : COLORS.neutral)], ephemeral:true });
      await logAction(client, existed ? '♻️ G3N rétabli' : 'ℹ️ Déban demandé',
        `**Utilisateur :** <@${userId}> (\`${userId}\`)\n**Raison :** ${reason}\n**Par :** <@${interaction.user.id}>`,
        existed ? COLORS.success : COLORS.neutral);
      return;
    }

    if (interaction.isModalSubmit() && id === 'modal:language') {
      if (!isAdminUser(interaction.user.id) || interaction.channelId !== ADMIN_PANEL_CHANNEL_ID) {
        return interaction.reply({ content:'⛔ Action réservée aux administrateurs du G3N.', ephemeral:true });
      }
      const code = interaction.fields.getTextInputValue('code').trim();
      const name = interaction.fields.getTextInputValue('name').trim();
      try {
        const languages = addTranslationLanguage(code, name);
        await interaction.reply({
          embeds:[embed('🌐 Langue ajoutée',
            `La langue **${name}** (\`${code}\`) est maintenant disponible dans le menu de traduction.\n\n` +
            `**Langues configurées :** \`${Object.keys(languages).length}/25\``,
            COLORS.success)],
          ephemeral:true
        });
        await logAction(client, '🌐 Langue ajoutée',
          `**Langue :** ${name} (\`${code}\`)\n**Par :** <@${interaction.user.id}>`,
          COLORS.success);
      } catch (e) {
        return interaction.reply({ content:`❌ ${e.message}`, ephemeral:true });
      }
      return;
    }

    if (interaction.isModalSubmit() && id === 'modal:restock:new') {
      if (!isAdminUser(interaction.user.id) || !hasPending(interaction.user.id)) return interaction.reply({ content:'❌ Aucun restock en attente.', ephemeral:true });
      const name = interaction.fields.getTextInputValue('name').trim();
      await interaction.deferReply({ ephemeral:true });
      try {
        const result = addPendingToService(interaction.user.id, name, true);
        await interaction.editReply({ embeds:[embed('🆕 Service créé',
          `**Nom :** \`${result.name}\`\n**Lignes ajoutées :** \`${result.added}\`\n**Stock actuel :** \`${result.total}\`\n**Créé par :** ${interaction.user.tag}`, COLORS.success)] });
        await logAction(client, '🆕 Nouveau service',
          `**Service :** \`${result.name}\`\n**Lignes :** \`${result.added}\`\n**Créé par :** <@${interaction.user.id}>`,
          COLORS.success);
      } catch (e) {
        await interaction.editReply({ embeds:[embed('❌ Création impossible', e.message, COLORS.danger)] });
      }
    }
  } catch (error) {
    console.error('[INTERACTION]', error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content:'❌ Une erreur est survenue.', ephemeral:true }).catch(()=>{});
    }
  }
});
};

// Live stock refresh: stock files are re-read without restarting the bot.

const __stockWatchFiles = new Map();
function __liveStockRefresh() {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const root = path.resolve(process.cwd(), "stock");
    if (!fs.existsSync(root)) return;
    for (const file of fs.readdirSync(root)) {
      const p = path.join(root, file);
      if (!fs.statSync(p).isFile()) continue;
      const m = fs.statSync(p).mtimeMs;
      const old = __stockWatchFiles.get(p);
      if (old !== m) {
        __stockWatchFiles.set(p, m);
      }
    }
  } catch {}
}
setInterval(__liveStockRefresh, 2000);
__liveStockRefresh();
