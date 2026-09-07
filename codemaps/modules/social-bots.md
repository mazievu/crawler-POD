# Social Listening Bots Module

## Responsibility
Manage scheduled background listening bots across Facebook, TikTok, Reddit, Instagram, and Twitter (X).

## Public API
- `BotConfigManager.getAll() / get(key) / update(key, config)`: Manages bot settings and intervals.
- `SocialListeningScheduler.tick()`: Checks due bots and submits runs with anti-duplicate protection.
- `SocialListeningScheduler.triggerBot(botKey, query)`: Dispatches immediate listening run.
- `createSocialBotsRouter(options)`: Express router for social bot management endpoints.
