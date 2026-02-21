'use strict';

const cron = require('node-cron');
const { getSettings } = require('../config');
const { Leads, ScanRuns, Activity } = require('../db');
const { runScan } = require('../scanner');
const { enqueuePitch, notifyQueue } = require('../queues');
const logger = require('../utils/logger');

let scanJob = null;
let pitchJob = null;
let briefingJob = null;

function parseCronTime(timeStr) {
  // timeStr like "02:00" → cron expression
  const [hour, minute] = (timeStr || '02:00').split(':');
  return `${minute} ${hour} * * *`;
}

async function runDailyScan() {
  const settings = getSettings();
  if (!settings.auto_scan_enabled) {
    logger.info('Auto scan disabled, skipping');
    return;
  }

  logger.info('Starting scheduled daily scan');

  try {
    const result = await runScan({
      areas: settings.scan_areas,
      categories: settings.scan_categories,
      maxResults: settings.scan_max_results,
      scanOnlyNew: settings.scan_only_new,
    });

    await notifyQueue.add({
      type: 'scan_complete',
      data: {
        found: result.found,
        new_leads: result.new_leads,
        skipped: result.skipped,
        areas: settings.scan_areas,
        categories: settings.scan_categories,
      },
    });

    logger.info('Scheduled scan complete', result);
  } catch (err) {
    logger.error('Scheduled scan failed', { error: err.message });
  }
}

async function runPitchBatch() {
  const settings = getSettings();
  if (!settings.auto_pitch_enabled) {
    logger.info('Auto pitch disabled, skipping');
    return;
  }

  const batchSize = Number(settings.pitch_batch_size) || 50;
  const pitchDelay = Number(settings.pitch_delay_ms) || 2000;

  logger.info('Starting pitch batch', { batchSize });

  const leads = await Leads.getPitchQueue(batchSize);
  if (!leads.length) {
    logger.info('No new leads to pitch');
    return;
  }

  logger.info(`Queuing ${leads.length} leads for pitching`);

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    // Stagger by pitch delay to avoid rate limits
    await enqueuePitch(lead.id, i * pitchDelay);
  }

  await Activity.log('pitch_batch_queued', null, { count: leads.length });
}

async function runMorningBriefing() {
  const settings = getSettings();
  if (!settings.briefing_enabled) return;

  logger.info('Running morning briefing');

  const { Leads: LeadsDB, ScanRuns: ScanRunsDB } = require('../db');
  const stats = await LeadsDB.stats();
  const lastScan = await ScanRunsDB.latest();

  await notifyQueue.add({
    type: 'briefing',
    data: { stats, scanStats: lastScan },
  });
}

function startJobs() {
  const settings = getSettings();

  // ── Daily Scan ──
  const scanTime = parseCronTime(settings.scan_time || '02:00');
  if (scanJob) scanJob.destroy();
  scanJob = cron.schedule(scanTime, runDailyScan, {
    timezone: 'Asia/Kolkata',
  });
  logger.info('Scan cron scheduled', { cron: scanTime });

  // ── Pitch Batch ──
  const pitchTime = parseCronTime(settings.pitch_time || '09:00');
  if (pitchJob) pitchJob.destroy();
  pitchJob = cron.schedule(pitchTime, runPitchBatch, {
    timezone: 'Asia/Kolkata',
  });
  logger.info('Pitch cron scheduled', { cron: pitchTime });

  // ── Morning Briefing at 8 AM ──
  if (briefingJob) briefingJob.destroy();
  briefingJob = cron.schedule('0 8 * * *', runMorningBriefing, {
    timezone: 'Asia/Kolkata',
  });
  logger.info('Briefing cron scheduled at 08:00 IST');
}

function stopJobs() {
  if (scanJob) { scanJob.destroy(); scanJob = null; }
  if (pitchJob) { pitchJob.destroy(); pitchJob = null; }
  if (briefingJob) { briefingJob.destroy(); briefingJob = null; }
  logger.info('All cron jobs stopped');
}

module.exports = { startJobs, stopJobs, runDailyScan, runPitchBatch, runMorningBriefing };
