# Phase 15: Dedicated Social Listening Bots

## Goal
Provide platform-tailored listening bots for Facebook, TikTok, Reddit, Instagram, and Twitter (X) operating on independent schedules and routing through the unified resource scheduler.

## Architectural Changes
- Created `src/social-bots/bot-config.js`: Configurable seeds, intervals, filters, and persistence.
- Created `src/social-bots/social-scheduler.js`: Anti-duplicate window hashing and scheduler dispatch.
- Created `src/social-bots/index.js`: Management endpoints (`GET /api/social-bots`, `PUT /api/social-bots/:platform`, `POST /api/social-bots/:platform/trigger`).

## Verification Evidence
- Unit test suite `test/social-bots.test.js` passed.
- Verified idempotent execution window checks and manual triggers.
