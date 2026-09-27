'use strict';
// Where Playwright and Chromium live. Nothing is installed by this folder: the
// machine's global Playwright is used. Override with PLAYWRIGHT_PATH /
// CHROMIUM_PATH when they live somewhere else.
const fs = require('fs');

const PLAYWRIGHT_PATH = process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// { chromium } or null (with the reason in .error) when Playwright or the
// browser binary is missing.
function loadPlaywright() {
  let pw = null;
  let error = '';
  try { pw = require(PLAYWRIGHT_PATH); } catch (e) {
    try { pw = require('playwright'); } catch (e2) { error = 'Playwright not found at ' + PLAYWRIGHT_PATH + ' (set PLAYWRIGHT_PATH)'; }
  }
  if (pw && !fs.existsSync(CHROMIUM_PATH)) { pw = null; error = 'Chromium not found at ' + CHROMIUM_PATH + ' (set CHROMIUM_PATH)'; }
  return { chromium: pw ? pw.chromium : null, error };
}

module.exports = { PLAYWRIGHT_PATH, CHROMIUM_PATH, loadPlaywright };
