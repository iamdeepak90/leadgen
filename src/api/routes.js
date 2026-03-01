'use strict';

const express = require('express');
const router = express.Router();
const { getSettings, reloadSettings } = require('../config');
const { Settings, Leads, Messages, Replies, Activity, ScanRuns } = require('../db');
const { enqueuePitch, cancelFollowupsForLead, getQueueStats } = require('../queues');
const { runDailyScan, runPitchBatch } = require('../jobs');
const logger = require('../utils/logger');

// ─── Settings ─────────────────────────────────────────────────────────────────

const MASKED_KEYS = ['google_places_key', 'openrouter_key', 'hostinger_smtp_pass', 'twilio_sid', 'twilio_token'];

function maskValue(key, value) {
  if (MASKED_KEYS.includes(key) && value && value.length > 6) {
    return value.substring(0, 4) + '***' + value.substring(value.length - 4);
  }
  return value;
}

router.get('/settings', async (req, res) => {
  try {
    const raw = await Settings.getAll();
    const masked = {};
    for (const [k, v] of Object.entries(raw)) {
      masked[k] = req.query.unmasked ? v : maskValue(k, v);
    }
    res.json({ ok: true, settings: masked });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/settings', async (req, res) => {
  try {
    const body = req.body;
    // Don't allow empty keys to overwrite existing masked values
    const toSave = {};
    for (const [k, v] of Object.entries(body)) {
      if (MASKED_KEYS.includes(k) && (v === '' || v?.includes('***'))) continue;
      toSave[k] = v === null || v === undefined ? '' : String(v);
    }
    await Settings.setMany(toSave);
    await reloadSettings();
    res.json({ ok: true, message: 'Settings saved and reloaded' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/settings/test/:service', async (req, res) => {
  const { service } = req.params;
  try {
    const {
      testHostingerSMTP, testTwilio,
      testGooglePlaces, testOpenRouter, testSlack,
    } = require('../outreach');

    let result;
    switch (service) {
      case 'hostinger_smtp': result = await testHostingerSMTP(); break;
      case 'twilio': result = await testTwilio(); break;
      case 'google_places': result = await testGooglePlaces(); break;
      case 'openrouter': result = await testOpenRouter(); break;
      case 'slack': result = await testSlack(); break;
      default: return res.status(400).json({ ok: false, error: 'Unknown service' });
    }
    res.json({ ok: result.ok, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

router.get('/dashboard', async (req, res) => {
  try {
    const [stats, activity, queueStats] = await Promise.all([
      Leads.stats(),
      Activity.recent(20),
      getQueueStats(),
    ]);
    res.json({ ok: true, stats, activity, queues: queueStats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Leads ────────────────────────────────────────────────────────────────────

router.get('/leads', async (req, res) => {
  try {
    const { status, website_status, category, location, limit = 50, offset = 0 } = req.query;
    const result = await Leads.list({ status, website_status, category, location,
      limit: parseInt(limit), offset: parseInt(offset) });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/leads/:id', async (req, res) => {
  try {
    const lead = await Leads.findById(req.params.id);
    if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });

    const [messages, replies, activityLog] = await Promise.all([
      Messages.forLead(lead.id),
      Replies.forLead(lead.id),
      Activity.forLead(lead.id),
    ]);

    res.json({ ok: true, lead, messages, replies, activity: activityLog });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/leads/:id/pitch', async (req, res) => {
  try {
    const lead = await Leads.findById(req.params.id);
    if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });

    const job = await enqueuePitch(lead.id, 0);
    await Activity.log('manual_pitch_triggered', lead.id, { job_id: job.id });

    res.json({ ok: true, message: 'Pitch queued', jobId: job.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/leads/:id/convert', async (req, res) => {
  try {
    const { revenue } = req.body;
    const lead = await Leads.setConverted(req.params.id, revenue || 0);
    if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });

    await cancelFollowupsForLead(lead.id);
    await Activity.log('lead_converted', lead.id, { revenue });
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/leads/:id/archive', async (req, res) => {
  try {
    const lead = await Leads.updateStatus(req.params.id, 'archived');
    if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });

    await cancelFollowupsForLead(lead.id);
    await Activity.log('lead_archived', lead.id, { reason: 'manual' });
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/leads/:id/notes', async (req, res) => {
  try {
    const { notes } = req.body;
    const lead = await Leads.updateNotes(req.params.id, notes);
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Manual Actions ───────────────────────────────────────────────────────────

router.post('/actions/scan', async (req, res) => {
  try {
    // Run scan in background
    res.json({ ok: true, message: 'Scan started in background' });
    const settings = getSettings();
    runDailyScan().catch((err) =>
      logger.error('Manual scan failed', { error: err.message })
    );
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/actions/pitch-batch', async (req, res) => {
  try {
    res.json({ ok: true, message: 'Pitch batch started' });
    runPitchBatch().catch((err) =>
      logger.error('Manual pitch batch failed', { error: err.message })
    );
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Activity ─────────────────────────────────────────────────────────────────

router.get('/activity', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const activity = await Activity.recent(parseInt(limit));
    res.json({ ok: true, activity });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Scan History ─────────────────────────────────────────────────────────────

router.get('/scans', async (req, res) => {
  try {
    const scans = await ScanRuns.list(30);
    res.json({ ok: true, scans });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Webhooks ─────────────────────────────────────────────────────────────────

// SendGrid Inbound Parse webhook
router.post('/webhooks/sendgrid', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    res.sendStatus(200); // Acknowledge immediately

    const { from, to, text, subject } = req.body;
    logger.info('SendGrid inbound email received', { from, to });

    // Try to match lead by from email
    const { pool } = require('../db');
    const leadRes = await pool.query('SELECT * FROM leads WHERE email = $1 LIMIT 1', [from]);
    const lead = leadRes.rows[0];

    if (!lead) {
      logger.warn('Could not match inbound email to a lead', { from });
      return;
    }

    await Replies.create({
      lead_id: lead.id,
      channel: 'email',
      from_address: from,
      body: text,
      raw_payload: req.body,
    });

    await Leads.updateStatus(lead.id, 'replied');
    await cancelFollowupsForLead(lead.id);
    await Activity.log('reply_received', lead.id, { channel: 'email', from });

    const { notifyQueue: nq } = require('../queues');
    await nq.add({
      type: 'reply',
      data: { lead, channel: 'email', replySnippet: text?.substring(0, 200) },
    });
  } catch (err) {
    logger.error('SendGrid webhook error', { error: err.message });
  }
});

// Twilio SMS webhook
router.post('/webhooks/twilio', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    res.set('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    const { From, Body } = req.body;
    logger.info('Twilio SMS reply received', { from: From });

    const { pool } = require('../db');
    const normalizedPhone = From.replace(/\s/g, '');
    const leadRes = await pool.query(
      `SELECT * FROM leads WHERE REPLACE(REPLACE(phone, ' ', ''), '-', '') = $1 LIMIT 1`,
      [normalizedPhone.replace(/[+\s-]/g, '')]
    );
    const lead = leadRes.rows[0];

    if (!lead) {
      logger.warn('Could not match SMS reply to a lead', { from: From });
      return;
    }

    await Replies.create({
      lead_id: lead.id,
      channel: 'sms',
      from_address: From,
      body: Body,
      raw_payload: req.body,
    });

    await Leads.updateStatus(lead.id, 'replied');
    await cancelFollowupsForLead(lead.id);
    await Activity.log('reply_received', lead.id, { channel: 'sms', from: From });

    const { notifyQueue: nq } = require('../queues');
    await nq.add({
      type: 'reply',
      data: { lead, channel: 'sms', replySnippet: Body?.substring(0, 200) },
    });
  } catch (err) {
    logger.error('Twilio webhook error', { error: err.message });
  }
});

module.exports = router;