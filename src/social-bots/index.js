/**
 * Social Listening Bots Module Export & Express Router
 */

const { getSocialScheduler } = require('./social-scheduler');
const { BotConfigManager, DEFAULT_BOT_CONFIGS } = require('./bot-config');

function createSocialBotsRouter(options = {}) {
  const express = require('express');
  const router = express.Router();
  const socialScheduler = options.socialScheduler || getSocialScheduler(options);

  // List all bots and status
  router.get('/api/social-bots', (req, res) => {
    try {
      res.json({
        ok: true,
        bots: socialScheduler.getStatus()
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Update specific bot configuration
  router.put('/api/social-bots/:platform', (req, res) => {
    try {
      const updated = socialScheduler.configManager.update(req.params.platform, req.body);
      res.json({ ok: true, bot: updated });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Trigger manual listening run
  router.post('/api/social-bots/:platform/trigger', async (req, res) => {
    try {
      const result = await socialScheduler.triggerBot(req.params.platform, req.body.query);
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = {
  getSocialScheduler,
  BotConfigManager,
  DEFAULT_BOT_CONFIGS,
  createSocialBotsRouter
};
