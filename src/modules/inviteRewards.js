const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');

// Configuration centrale du système d'invitation
const INVITE_CONFIG = {
  levels: [
    { invites: 5, cooldownMs: 20 * 60 * 1000, durationMs: 24 * 60 * 60 * 1000 },  // 5 invites → 20min cooldown pour 24h
    { invites: 10, cooldownMs: 15 * 60 * 1000, durationMs: 10 * 60 * 60 * 1000 }, // 10 invites → 15min cooldown pour 10h
    { invites: 15, cooldownMs: 10 * 60 * 1000, durationMs: 5 * 60 * 60 * 1000 }   // 15 invites → 10min cooldown pour 5h
  ],
  panelChannelId: '1555701318675468288',  // Salon pour le panel explicatif
  logChannelId: '1544821826189000824',     // Salon pour les logs
  prefix: '.'
};

// Chemins des fichiers
const baseDir = path.resolve(__dirname, '..', '..');
const dataDir = path.join(baseDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const inviteStatsFile = path.join(dataDir, 'invite-system-stats.json');
const pendingInvitesFile = path.join(dataDir, 'invite-system-pending.json');
const inviteLogsFile = path.join(dataDir, 'invite-system-logs.json');

// Fonctions utilitaires
function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    const tempFile = `${file}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, file);
  } catch (error) {
    console.error(`[INVITE SYSTEM] Error writing ${file}:`, error);
  }
}

// Gestion des statistiques
function getInviteStats() {
  return readJson(inviteStatsFile, {});
}

function saveInviteStats(stats) {
  writeJson(inviteStatsFile, stats);
}

function getUserStats(userId) {
  const stats = getInviteStats();
  return stats[userId] || { totalInvites: 0, validInvites: 0, rewards: {}, lastInviteDate: null };
}

function updateUserStats(userId, updates) {
  const stats = getInviteStats();
  stats[userId] = { ...getUserStats(userId), ...updates };
  saveInviteStats(stats);
}

// Gestion des invites en attente
function getPendingInvites() {
  return readJson(pendingInvitesFile, {});
}

function savePendingInvites(pending) {
  writeJson(pendingInvitesFile, pending);
}

function addPendingInvite(inviterId, invitedUserId) {
  const pending = getPendingInvites();
  if (!pending[inviterId]) pending[inviterId] = [];
  pending[inviterId].push({ userId: invitedUserId, timestamp: Date.now(), validated: false });
  savePendingInvites(pending);
}

function validatePendingInvite(inviterId, invitedUserId) {
  const pending = getPendingInvites();
  if (pending[inviterId]) {
    const index = pending[inviterId].findIndex(p => p.userId === invitedUserId && !p.validated);
    if (index !== -1) {
      pending[inviterId][index].validated = true;
      savePendingInvites(pending);
      return true;
    }
  }
  return false;
}

function cleanupPendingInvites() {
  const pending = getPendingInvites();
  const now = Date.now();
  const twoHoursAgo = now - (2 * 60 * 60 * 1000);
  
  for (const inviterId in pending) {
    pending[inviterId] = pending[inviterId].filter(p => p.validated || p.timestamp > twoHoursAgo);
    if (pending[inviterId].length === 0) delete pending[inviterId];
  }
  savePendingInvites(pending);
}

// Vérification des comptes créés aujourd'hui
function isAccountCreatedToday(user) {
  if (!user) return true;
  const createdAt = user.createdAt || user.createdTimestamp;
  if (!createdAt) return true;
  
  const createdDate = new Date(createdAt);
  const today = new Date();
  
  return createdDate.getDate() === today.getDate() &&
         createdDate.getMonth() === today.getMonth() &&
         createdDate.getFullYear() === today.getFullYear();
}

// Gestion des récompenses
function getUserCooldown(userId) {
  const userStats = getUserStats(userId);
  const now = Date.now();
  
  // Trouver la meilleure récompense active
  for (const level of INVITE_CONFIG.levels.sort((a, b) => b.invites - a.invites)) {
    if (userStats.validInvites >= level.invites) {
      const rewardExpiry = userStats.rewards[level.invites];
      if (rewardExpiry && rewardExpiry > now) {
        return level.cooldownMs;
      }
    }
  }
  return INVITE_CONFIG.levels[0].cooldownMs;
}

function getActiveReward(userId) {
  const userStats = getUserStats(userId);
  const now = Date.now();
  
  for (const level of INVITE_CONFIG.levels.sort((a, b) => b.invites - a.invites)) {
    if (userStats.validInvites >= level.invites) {
      const rewardExpiry = userStats.rewards[level.invites];
      if (rewardExpiry && rewardExpiry > now) {
        return { ...level, expiresAt: rewardExpiry };
      }
    }
  }
  return null;
}

// Gestion des logs
function addInviteLog(logEntry) {
  const logs = readJson(inviteLogsFile, []);
  logs.push({ ...logEntry, timestamp: Date.now() });
  if (logs.length > 1000) logs.shift();
  writeJson(inviteLogsFile, logs);
}

// Payloads
function createInvitePanelPayload() {
  const levels = INVITE_CONFIG.levels.sort((a, b) => a.invites - b.invites);
  
  const levelDescriptions = levels.map(level => {
    const cooldownMinutes = level.cooldownMs / (60 * 1000);
    const durationHours = level.durationMs / (60 * 60 * 1000);
    return `🎁 **${level.invites} invitations** → cooldown de **${cooldownMinutes} min** pendant **${durationHours}h**`;
  }).join('\n');
  
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎉 Système d\'Invitations - Récompenses')
        .setDescription(
          `Invite des membres sur le serveur et débloque temporairement un meilleur cooldown pour le générateur !\n\n` +
          `${levelDescriptions}\n\n` +
          `📌 **Règles importantes :**\n` +
          `• Les invitations ne sont comptées que si le membre **reste** sur le serveur\n` +
          `• Les comptes créés **aujourd'hui** ne comptent pas\n` +
          `• Utilise \`.invite @user\` pour vérifier tes statistiques\n` +
          `• Les récompenses sont temporaires et expirent automatiquement\n\n` +
          `🛡️ **Protection anti-abus :**\n` +
          `• Si un invité quitte rapidement, son invitation ne sera pas comptée\n` +
          `• Les tentatives de tricherie seront détectées et sanctionnées`
        )
        .setFooter({ text: 'SICARIO • G3N FREE • Système d\'Invitations' })
        .setTimestamp()
    ]
  };
}

function createLogEmbed(action, description, color = 0x5865F2) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`📊 ${action.toUpperCase()} - Système d'Invitations`)
    .setDescription(description)
    .setFooter({ text: 'SICARIO • G3N FREE' })
    .setTimestamp();
}

function formatDate(timestamp) {
  return `<t:${Math.floor(timestamp / 1000)}:F>`;
}

// Fonction principale pour envoyer les logs
async function sendInviteLog(client, action, description, color = 0x5865F2) {
  try {
    const logChannel = await client.channels.fetch(INVITE_CONFIG.logChannelId).catch(() => null);
    if (logChannel && logChannel.isTextBased()) {
      await logChannel.send({ embeds: [createLogEmbed(action, description, color)] }).catch(() => {});
    }
  } catch (error) {
    console.error('[INVITE SYSTEM] Error sending log:', error);
  }
}

// Module principal
module.exports = {
  INVITE_CONFIG,
  
  // Initialisation
  init: async function(client) {
    console.log('[INVITE SYSTEM] Initialisation...');
    cleanupPendingInvites();
    
    // Envoyer le panel
    try {
      const panelChannel = await client.channels.fetch(INVITE_CONFIG.panelChannelId).catch(() => null);
      if (panelChannel && panelChannel.isTextBased()) {
        const messages = await panelChannel.messages.fetch({ limit: 100 }).catch(() => null);
        if (messages) {
          const existingMessage = messages.find(m => 
            m.author?.id === client.user?.id && 
            m.embeds?.some(e => e.title?.includes('Système d\'Invitations'))
          );
          
          if (existingMessage) {
            await existingMessage.edit(createInvitePanelPayload()).catch(() => {});
          } else {
            await panelChannel.send(createInvitePanelPayload()).catch(() => {});
          }
        }
      }
    } catch (error) {
      console.error('[INVITE SYSTEM] Erreur initialisation panel:', error);
    }
    
    console.log('[INVITE SYSTEM] Système d\'invitations initialisé');
  },
  
  // Gestion des nouveaux membres
  handleGuildMemberAdd: async function(member, client) {
    if (member.user.bot) return;
    
    // Vérifier que c'est le bon serveur
    const GUILD_ID = process.env.GUILD_ID || '1544810093051121694';
    if (member.guild.id !== GUILD_ID) return;
    
    // Vérifier si compte créé aujourd'hui
    if (isAccountCreatedToday(member.user)) {
      addInviteLog({ action: 'block', userId: member.user.id, username: member.user.username, reason: 'Compte créé aujourd\'hui' });
      await sendInviteLog(client, 'block', 
        `**Compte bloqué :** <@${member.user.id}> (\`${member.user.id}\`)\n` +
        `**Raison :** Créé aujourd'hui - non comptabilisé`,
        0xED4245
      );
      return;
    }
    
    try {
      // Essayer de déterminer qui a invité
      // Méthode 1 : Vérifier les invites du serveur
      const invites = await member.guild.invites.fetch().catch(() => null);
      if (invites) {
        // Cette méthode est complexe sans cache, on va utiliser une approche différente
        // On va vérifier si un utilisateur a des invites récentes
        
        // Pour l'instant, on va utiliser la méthode des events guildMemberAdd qui suit
        // les invites créées, mais c'est limité
      }
      
      // Ajouter comme en attente pour validation
      // On ne peut pas déterminer l'inviter ici facilement, donc on va utiliser
      // l'événement inviteCreate + cache dans le système principal
      
    } catch (error) {
      console.error('[INVITE SYSTEM] Erreur handleGuildMemberAdd:', error);
    }
  },
  
  // Méthode alternative avec cache d'invites
  setupInviteTracking: function(client) {
    const GUILD_ID = process.env.GUILD_ID || '1544810093051121694';
    const inviteCache = new Map();
    
    // Mettre à jour le cache des invites
    client.on('inviteCreate', invite => {
      if (!invite.guild || invite.guild.id !== GUILD_ID) return;
      const cache = inviteCache.get(invite.guild.id) || new Map();
      cache.set(invite.code, { uses: invite.uses || 0, inviterId: invite.inviterId });
      inviteCache.set(invite.guild.id, cache);
    });
    
    client.on('inviteDelete', invite => {
      const cache = inviteCache.get(invite.guild?.id);
      if (cache) cache.delete(invite.code);
    });
    
    // Gestion des nouveaux membres avec suivi d'invites
    client.on('guildMemberAdd', async member => {
      if (member.user.bot || member.guild.id !== GUILD_ID) return;
      
      // Vérifier si compte créé aujourd'hui
      if (isAccountCreatedToday(member.user)) {
        addInviteLog({ action: 'block', userId: member.user.id, username: member.user.username, reason: 'Compte créé aujourd\'hui' });
        await sendInviteLog(client, 'block',
          `**Compte bloqué :** <@${member.user.id}> (\`${member.user.id}\`)\n` +
          `**Raison :** Créé aujourd'hui - non comptabilisé`,
          0xED4245
        );
        return;
      }
      
      try {
        const before = inviteCache.get(member.guild.id) || new Map();
        const invites = await member.guild.invites.fetch().catch(() => null);
        if (!invites) return;
        
        const after = new Map(invites.map(i => [i.code, { uses: i.uses || 0, inviterId: i.inviterId }]));
        inviteCache.set(member.guild.id, after);
        
        // Trouver l'invite utilisée (celle dont le nombre a augmenté)
        let usedInvite = null;
        for (const [code, afterData] of after) {
          const beforeData = before.get(code);
          if (beforeData && afterData.uses > beforeData.uses && afterData.inviterId) {
            usedInvite = { code, inviterId: afterData.inviterId, uses: afterData.uses };
            break;
          }
        }
        
        if (!usedInvite?.inviterId) {
          // Essayer de trouver une invite avec des uses > 0
          const anyInvite = invites.find(inv => inv.uses > 0 && inv.inviterId);
          if (anyInvite) {
            usedInvite = { code: anyInvite.code, inviterId: anyInvite.inviterId, uses: anyInvite.uses };
          }
        }
        
        if (!usedInvite?.inviterId) return; // Pas d'inviter trouvé
        
        const inviterId = usedInvite.inviterId;
        
        // Ajouter l'invite en attente
        addPendingInvite(inviterId, member.user.id);
        
        addInviteLog({
          action: 'join',
          inviterId: inviterId,
          invitedUserId: member.user.id,
          invitedUsername: member.user.username
        });
        
        await sendInviteLog(client, 'join',
          `**Nouveau membre :** <@${member.user.id}> (\`${member.user.id}\`)\n` +
          `**Invité par :** <@${inviterId}> (\`${inviterId}\`)\n` +
          `**Statut :** En attente de validation (2h)`
        );
        
      } catch (error) {
        console.error('[INVITE SYSTEM] Erreur suivi invites:', error);
      }
    });
    
    // Gestion des membres qui quittent
    client.on('guildMemberRemove', async member => {
      if (member.user.bot || member.guild.id !== GUILD_ID) return;
      
      try {
        const pending = getPendingInvites();
        
        // Vérifier si ce membre était en attente de validation
        for (const inviterId in pending) {
          const index = pending[inviterId].findIndex(p => p.userId === member.user.id && !p.validated);
          if (index !== -1) {
            // Supprimer l'invite non validée
            pending[inviterId].splice(index, 1);
            savePendingInvites(pending);
            
            addInviteLog({
              action: 'leave',
              inviterId: inviterId,
              invitedUserId: member.user.id,
              reason: 'A quitté avant validation'
            });
            
            await sendInviteLog(client, 'leave',
              `**Membre parti :** <@${member.user.id}> (\`${member.user.id}\`)\n` +
              `**Invité par :** <@${inviterId}> (\`${inviterId}\`)\n` +
              `**Statut :** Invite **non comptée** (quitté trop tôt)`,
              0xED4245
            );
            return;
          }
        }
      } catch (error) {
        console.error('[INVITE SYSTEM] Erreur guildMemberRemove:', error);
      }
    });
    
    // Validation périodique des invites (toutes les 5 minutes)
    setInterval(async () => {
      try {
        const pending = getPendingInvites();
        const now = Date.now();
        const twoHoursAgo = now - (2 * 60 * 60 * 1000);
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return;
        
        for (const inviterId in pending) {
          for (let i = pending[inviterId].length - 1; i >= 0; i--) {
            const pendingInvite = pending[inviterId][i];
            
            if (pendingInvite.validated) continue;
            if (pendingInvite.timestamp > twoHoursAgo) continue;
            
            try {
              const invitedMember = await guild.members.fetch(pendingInvite.userId).catch(() => null);
              
              if (invitedMember && !invitedMember.user.bot) {
                // Valider l'invite
                validatePendingInvite(inviterId, pendingInvite.userId);
                
                // Mettre à jour les stats
                const userStats = getUserStats(inviterId);
                userStats.validInvites += 1;
                userStats.totalInvites += 1;
                userStats.lastInviteDate = now;
                
                // Attribuer les récompenses
                for (const level of INVITE_CONFIG.levels.sort((a, b) => a.invites - b.invites)) {
                  if (userStats.validInvites >= level.invites) {
                    const existingExpiry = userStats.rewards[level.invites];
                    if (!existingExpiry || existingExpiry <= now) {
                      userStats.rewards[level.invites] = now + level.durationMs;
                    }
                  }
                }
                
                updateUserStats(inviterId, userStats);
                
                addInviteLog({
                  action: 'validate',
                  inviterId: inviterId,
                  invitedUserId: pendingInvite.userId,
                  newInviteCount: userStats.validInvites
                });
                
                await sendInviteLog(client, 'validate',
                  `**Invite validée !**\n\n` +
                  `**Invité :** <@${pendingInvite.userId}> (\`${pendingInvite.userId}\`)\n` +
                  `**Par :** <@${inviterId}> (\`${inviterId}\`)\n` +
                  `**Nouveau total :** ${userStats.validInvites} invites validées\n` +
                  `**Nouveau cooldown :** ${getUserCooldown(inviterId) / (60 * 1000)} min`
                );
                
                // Vérifier les récompenses
                const activeReward = getActiveReward(inviterId);
                if (activeReward) {
                  await sendInviteLog(client, 'reward',
                    `**Récompense activée !**\n\n` +
                    `**Utilisateur :** <@${inviterId}> (\`${inviterId}\`)\n` +
                    `**Niveau :** ${activeReward.invites} invites\n` +
                    `**Cooldown :** ${activeReward.cooldownMs / (60 * 1000)} min\n` +
                    `**Expire :** ${formatDate(activeReward.expiresAt)}`
                  );
                }
              } else {
                // Supprimer l'invite si l'utilisateur a quitté
                pending[inviterId].splice(i, 1);
                addInviteLog({
                  action: 'leave',
                  inviterId: inviterId,
                  invitedUserId: pendingInvite.userId,
                  reason: 'A quitté avant validation (2h)'
                });
              }
            } catch (error) {
              console.error('[INVITE SYSTEM] Erreur validation:', error);
            }
          }
        }
        
        cleanupPendingInvites();
        
      } catch (error) {
        console.error('[INVITE SYSTEM] Erreur validation périodique:', error);
      }
    }, 5 * 60 * 1000); // Toutes les 5 minutes
    
    return inviteCache;
  },
  
  // Gestion de la commande .invite @user
  handleInviteCommand: async function(message) {
    if (!message.content.startsWith(INVITE_CONFIG.prefix + 'invite')) return false;
    
    try {
      const args = message.content.slice(INVITE_CONFIG.prefix.length).trim().split(/\s+/);
      const command = args.shift().toLowerCase();
      
      if (command !== 'invite') return false;
      
      const mentionedUser = message.mentions.users.first();
      if (!mentionedUser) {
        await message.reply({
          embeds: [new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('❌ Erreur')
            .setDescription('Utilisation : `.invite @user`')
            .setTimestamp()
          ]
        });
        return true;
      }
      
      // Vérifier permissions
      const isAdmin = message.member.permissions.has('Administrator');
      const allowedUsers = process.env.INVITE_CHECK_USERS?.split(',').filter(Boolean) || [];
      
      if (!isAdmin && !allowedUsers.includes(message.author.id)) {
        await message.reply({
          embeds: [new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('❌ Accès refusé')
            .setDescription('Cette commande est réservée aux administrateurs.')
            .setTimestamp()
          ]
        });
        return true;
      }
      
      const userId = mentionedUser.id;
      const userStats = getUserStats(userId);
      const activeReward = getActiveReward(userId);
      const currentCooldown = getUserCooldown(userId);
      
      const descriptionParts = [
        `**👤 Utilisateur :** <@${userId}> (\`${userId}\`)`,
        `**📊 Invitations totales :** ${userStats.totalInvites || 0}`,
        `**✅ Invitations valides :** ${userStats.validInvites || 0}`,
        `**⏱️ Cooldown actuel :** ${currentCooldown / (60 * 1000)} minutes`
      ];
      
      if (activeReward) {
        const durationLeft = activeReward.expiresAt - Date.now();
        const hoursLeft = Math.ceil(durationLeft / (60 * 60 * 1000));
        descriptionParts.push(
          `**🎁 Récompense active :** ${activeReward.invites} invites → ${activeReward.cooldownMs / (60 * 1000)} min cooldown`,
          `**⏰ Restant :** ${hoursLeft}h`
        );
      } else {
        descriptionParts.push('**🎁 Aucune récompense active**');
      }
      
      if (userStats.lastInviteDate) {
        descriptionParts.push(`**📅 Dernière invite :** ${formatDate(userStats.lastInviteDate)}`);
      }
      
      // Niveaux disponibles
      const availableRewards = INVITE_CONFIG.levels.sort((a, b) => a.invites - b.invites).map(level => {
        if (userStats.validInvites >= level.invites) {
          const hasActiveReward = userStats.rewards[level.invites] && userStats.rewards[level.invites] > Date.now();
          return hasActiveReward
            ? `✅ **${level.invites} invites** - ${level.cooldownMs / (60 * 1000)} min cooldown (actif)`
            : `⏳ **${level.invites} invites** - ${level.cooldownMs / (60 * 1000)} min cooldown (disponible)`;
        }
        return `❌ **${level.invites} invites** - ${level.cooldownMs / (60 * 1000)} min cooldown`;
      });
      
      descriptionParts.push('', '**Niveaux disponibles :**', ...availableRewards);
      
      await message.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('📊 Statistiques d\'Invitations')
          .setDescription(descriptionParts.join('\n'))
          .setFooter({ text: 'SICARIO • G3N FREE • Système d\'Invitations' })
          .setTimestamp()
        ]
      });
      
      // Logger l'utilisation
      await sendInviteLog(message.client, 'check',
        `**Vérification des invites**\n` +
        `**Par :** <@${message.author.id}> (\`${message.author.id}\`)\n` +
        `**Cible :** <@${userId}> (\`${userId}\`)\n` +
        `**Invites valides :** ${userStats.validInvites || 0}`
      );
      
      return true;
      
    } catch (error) {
      console.error('[INVITE SYSTEM] Erreur handleInviteCommand:', error);
      await message.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle('❌ Erreur')
          .setDescription('Une erreur est survenue.')
          .setTimestamp()
        ]
      });
      return true;
    }
  },
  
  // Obtenir le cooldown pour un utilisateur (pour intégration)
  getUserCooldownMs: function(userId) {
    return getUserCooldown(userId);
  },
  
  // Obtenir les stats d'un utilisateur
  getUserInviteStats: function(userId) {
    return getUserStats(userId);
  },
  
  // Définir le GUILD_ID
  setGuildId: function(guildId) {
    INVITE_CONFIG.guildId = guildId;
  }
};