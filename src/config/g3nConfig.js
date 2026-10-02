const path = require('path');

module.exports = {
  GUILD_ID: '1544810093051121694',
  GEN_CHANNEL_ID: '1544816428819947580',
  TUTORIAL_CHANNEL_ID: '1544815584443899994',
  ADMIN_PANEL_CHANNEL_ID: '1544818920521859112',
  PHOTO_CHANNEL_ID: '1544818377170755614',
  LOG_CHANNEL_ID: '1544821826189000824',
  TOKEN_GUARD_CHANNEL_ID: '1544831724972802078',
  TOKEN_GUARD_TIMEOUT_MS: 60 * 60 * 1000,
  PHOTO_REMINDER_INTERVAL_MS: 3 * 60 * 60 * 1000,
  GENERATOR_ROLE_ID: '1544819292405637232',

  // Utilisateurs autorisés à gérer le panel / les restocks.
  RESTOCK_USERS: new Set([
    '1354927760719741010',
    '432071641426821120'
  ]),

  REQUIRED_STATUS: 'B3ST G3N FN 3K AVIS .gg/sicariostore',
  GEN_COOLDOWN_MS: 30 * 60 * 1000,

  // Système de récompenses d'invitations.
  INVITE_REWARDS: [
    { invites: 5, cooldownMs: 20 * 60 * 1000, durationMs: 24 * 60 * 60 * 1000 },  // 5 invites → 20min cooldown pour 24h
    { invites: 10, cooldownMs: 15 * 60 * 1000, durationMs: 10 * 60 * 60 * 1000 }, // 10 invites → 15min cooldown pour 10h
    { invites: 15, cooldownMs: 10 * 60 * 1000, durationMs: 5 * 60 * 60 * 1000 }   // 15 invites → 10min cooldown pour 5h
  ],
  
  // Nouveaux IDs pour le système d'invitation
  INVITE_PANEL_CHANNEL_ID: '1555701318675468288', // Salon pour le panel explicatif
  INVITE_LOG_CHANNEL_ID: '1544821826189000824',    // Salon pour les logs d'invitation
  INVITE_CHECK_ADMIN_ONLY: true,
  INVITE_CHECK_USERS: new Set((process.env.INVITE_CHECK_USERS || '').split(',').map(v => v.trim()).filter(Boolean)),
  PREFIX: '.',
  BASE_DIR: path.resolve(__dirname, '..', '..'),
  SICARIO_GIF_URL: 'https://cdn.discordapp.com/attachments/1548316654239350844/1555492941836066846/sicario_violet_banner_power.gif?backend=b2&ex=6ac161f0&is=6ac01070&hm=435ba9ac5a6c5a3cada070f270aea74ccba9137e65e5fe81b908c0f01009be04'
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
