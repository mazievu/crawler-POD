import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { deriveEverbeeHostToken } = require('../src/marketplaces/everbee-host-client');
const { assertMarketplaceUrl, assertSupportedMarketplace } = require('../src/marketplaces/validation');
const { normalizeBrowserStorageState } = require('../src/marketplaces/storage-state');
const { enumerateEtsyVariants, extractEtsyPriceText, normalizeMaxVariants, normalizeVariantMode, parseVisibleEtsyPrice } = require('../src/marketplaces/variant-pricing');
const { changedEtsyVariationSelections, etsyVariantInteractionOptions, marketplaceVariationSelector } = require('../src/marketplaces/etsy-variants');

const PORT = Number(process.env.EVERBEE_HOST_EXECUTOR_PORT || 9333);
const HOST = process.env.EVERBEE_HOST_EXECUTOR_BIND || '127.0.0.1';
const PROFILE_ROOT = process.env.EVERBEE_HOST_PROFILE_ROOT || 'D:\\sharre\\everbee\\.collector-marketplace-profiles';
const CLOAK_MODULE = process.env.EVERBEE_CLOAK_MODULE || 'D:\\sharre\\everbee\\node_modules\\cloakbrowser\\dist\\index.js';
const HEADLESS = process.env.EVERBEE_HOST_HEADLESS !== 'false';
const activeProfiles = new Set();

async function loadCloakBrowser() {
  if (fs.existsSync(CLOAK_MODULE)) return import(pathToFileURL(CLOAK_MODULE).href);
  return import('cloakbrowser');
}

function accountProfileDir(platform, accountId) {
  const name = Number.isSafeInteger(Number(accountId)) && Number(accountId) > 0 ? `account-${Number(accountId)}` : 'public';
  return path.join(PROFILE_ROOT, platform, name);
}

function isAuthorized(value) {
  const expected = Buffer.from(deriveEverbeeHostToken());
  const received = Buffer.from(String(value || ''));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) reject(new Error('Request body is too large'));
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Request body must be valid JSON')); }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function discoverEtsyVariationGroups(page) {
  const groups = await page.evaluate(() => [...document.querySelectorAll('select')]
    .filter((element) => /^variation-selector-\d+$/.test(element.id || ''))
    .map((element, index) => {
    const label = element.labels?.[0]?.innerText
      || element.closest('fieldset')?.querySelector('legend')?.innerText
      || element.getAttribute('aria-label')
      || element.name
      || `Option ${index + 1}`;
    return {
      label: label.trim(),
      id: element.id,
      options: [...element.options].map((option) => ({
        value: option.value,
        text: option.textContent?.trim() || option.value,
        disabled: option.disabled || !option.value || /^(select|choose) an? option/i.test(option.textContent?.trim() || ''),
      })),
    };
  }));
  return groups.map(({ id, ...group }) => ({ ...group, selector: marketplaceVariationSelector(id) }));
}

async function readEtsyVisiblePrice(page) {
  const text = await page.evaluate(() => {
    const visible = (element) => Boolean(element?.getClientRects().length);
    const hasPrice = (text) => /(?:\b[A-Z]{3}\s*|[$€£]\s*)[0-9][0-9,.\s]*/.test(text || '');
    const selectors = [
      '[data-selector="price-only"]',
      '[data-selector="price"]',
      '#listing-page-cart',
      '[data-buy-box-region]',
      'main',
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const text = element?.innerText?.replace(/\s+/g, ' ').trim();
      if (visible(element) && hasPrice(text)) return text;
    }
    return [...document.querySelectorAll('body *')]
      .filter((element) => visible(element) && hasPrice(element.innerText))
      .map((element) => element.innerText.replace(/\s+/g, ' ').trim())
      .sort((left, right) => left.length - right.length)[0] || '';
  });
  return extractEtsyPriceText(text);
}

async function captureEtsyVariants(page, maxVariants) {
  const plan = enumerateEtsyVariants(await discoverEtsyVariationGroups(page), maxVariants);
  const variants = [];
  const previousSelections = new Map();
  const interaction = etsyVariantInteractionOptions();
  for (const selections of plan.combinations) {
    try {
      for (const selection of changedEtsyVariationSelections(previousSelections, selections)) {
        await page.selectOption(selection.selector, selection.value, { timeout: interaction.timeout });
        previousSelections.set(selection.selector, selection.value);
        await page.waitForTimeout(interaction.settleMs);
      }
      variants.push({
        selections: selections.map(({ label, value, text }) => ({ label, value, text })),
        price: parseVisibleEtsyPrice(await readEtsyVisiblePrice(page)),
        available: true,
      });
    } catch {
      variants.push({
        selections: selections.map(({ label, value, text }) => ({ label, value, text })),
        price: null,
        available: false,
      });
    }
  }
  return {
    variants,
    variantMeta: { ...plan, combinations: undefined, capturedVariantCount: variants.length },
  };
}

async function capture(request) {
  assertSupportedMarketplace(request.platform);
  const url = assertMarketplaceUrl(request.platform, request.url);
  const storageState = request.storageState ? normalizeBrowserStorageState(request.platform, request.storageState) : null;
  const variantMode = normalizeVariantMode(request.variantMode);
  const maxVariants = normalizeMaxVariants(request.maxVariants);
  if (request.proxy != null && (typeof request.proxy !== 'string' || request.proxy.length > 1024)) throw new Error('Proxy configuration is invalid');
  const userDataDir = accountProfileDir(request.platform, request.accountId);
  if (activeProfiles.has(userDataDir)) throw new Error('This account browser is already capturing');

  activeProfiles.add(userDataDir);
  let context;
  let page;
  try {
    const { launchPersistentContext } = await loadCloakBrowser();
    const options = { userDataDir, headless: HEADLESS, locale: 'en-US' };
    if (request.proxy) options.proxy = request.proxy;
    context = await launchPersistentContext(options);
    if (storageState?.cookies?.length) await context.addCookies(storageState.cookies);
    page = context.pages()[0] || await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const variantCapture = request.platform === 'etsy' && variantMode === 'all'
      ? await captureEtsyVariants(page, maxVariants)
      : { variants: [], variantMeta: null };
    return { html: await page.content(), finalUrl: page.url(), ...variantCapture };
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    activeProfiles.delete(userDataDir);
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return sendJson(response, 200, { ok: true });
  if (request.method !== 'POST' || request.url !== '/v1/captures') return sendJson(response, 404, { error: 'Not found' });
  if (!isAuthorized(request.headers['x-everbee-executor-token'])) return sendJson(response, 401, { error: 'Unauthorized' });

  try {
    sendJson(response, 200, await capture(await readJson(request)));
  } catch (error) {
    // Credentials and raw browser errors must never be sent back to the Docker client.
    const status = /already capturing/.test(error.message) ? 409 : 400;
    sendJson(response, status, { error: status === 409 ? error.message : 'Everbee host capture failed' });
  }
});

server.listen(PORT, HOST, () => console.log(`Everbee host executor listening on http://${HOST}:${PORT}`));
