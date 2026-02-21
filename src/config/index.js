'use strict';

const { Settings } = require('../db');
const logger = require('../utils/logger');

let _settings = {};
let _pool = null;

function init(pool) {
  _pool = pool;
}

async function loadSettings() {
  try {
    const raw = await Settings.getAll();

    // Parse JSON fields
    const jsonFields = ['scan_areas', 'scan_categories', 'opening_hours'];

    const parsed = {};
    for (const [key, value] of Object.entries(raw)) {
      if (jsonFields.includes(key)) {
        try {
          parsed[key] = JSON.parse(value);
        } catch {
          parsed[key] = value;
        }
      } else if (value === 'true') {
        parsed[key] = true;
      } else if (value === 'false') {
        parsed[key] = false;
      } else if (!isNaN(value) && value !== '' && value !== null) {
        parsed[key] = Number(value);
      } else {
        parsed[key] = value;
      }
    }

    _settings = parsed;
    logger.info('Settings loaded from database', { count: Object.keys(parsed).length });
    return parsed;
  } catch (err) {
    logger.error('Failed to load settings from database', { error: err.message });
    throw err;
  }
}

function getSettings() {
  return _settings;
}

async function reloadSettings() {
  return loadSettings();
}

module.exports = { init, loadSettings, getSettings, reloadSettings };
