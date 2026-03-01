'use strict';

const axios    = require('axios');
const nodemailer = require('nodemailer');
const { getSettings } = require('../config');
const { Messages, Activity } = require('../db');
const logger = require('../utils/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePhone(phone) {
  if (!phone) return phone;
  let p = phone.replace(/[\s\-()]/g, '');
  if (!p.startsWith('+')) p = '+' + p;
  return p;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Hostinger SMTP Email ─────────────────────────────────────────────────────

async function sendEmail({ to, subject, body, leadId, messageId }) {
  const s = getSettings();

  if (!s.hostinger_smtp_user) throw new Error('Hostinger SMTP user not configured');
  if (!s.hostinger_smtp_pass) throw new Error('Hostinger SMTP password not configured');
  if (!s.from_email)          throw new Error('From email not configured');
  if (!to)                    throw new Error('No recipient email');

  const transporter = nodemailer.createTransport({
    host: s.hostinger_smtp_host || 'smtp.hostinger.com',
    port: parseInt(s.hostinger_smtp_port || '465'),
    secure: true, // SSL
    auth: { user: s.hostinger_smtp_user, pass: s.hostinger_smtp_pass },
  });

  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await transporter.sendMail({
        from: `"${s.from_name || 'LeadGen'}" <${s.from_email}>`,
        to,
        subject,
        text: body,
        replyTo: s.from_email,
      });

      if (messageId) await Messages.updateStatus(messageId, 'sent');
      await Activity.log('email_sent', leadId, { to, subject, attempt });
      logger.info('Email sent via Hostinger SMTP', { to, leadId, attempt });
      return { success: true };
    } catch (err) {
      lastError = err;
      logger.warn('Email send failed', { to, attempt, error: err.message });
      if (messageId) await Messages.incrementRetry(messageId);
      if (attempt < MAX_RETRIES) await sleep(attempt * 2000);
    }
  }

  if (messageId) await Messages.updateStatus(messageId, 'failed', lastError?.message);
  await Activity.log('email_failed', leadId, { to, error: lastError?.message });
  logger.error('Email failed after retries', { to, leadId, error: lastError?.message });
  return { success: false, error: lastError?.message };
}

// ─── Twilio WhatsApp ──────────────────────────────────────────────────────────

async function sendWhatsApp({ to, body, leadId, messageId }) {
  const s = getSettings();
  const sid          = s.twilio_sid;
  const token        = s.twilio_token;
  const fromWhatsApp = s.twilio_whatsapp_from; // e.g. whatsapp:+14155238886

  if (!sid || !token)  return { success: false, error: 'Twilio credentials not configured', channel: 'whatsapp' };
  if (!fromWhatsApp)   return { success: false, error: 'Twilio WhatsApp from number not configured', channel: 'whatsapp' };
  if (!to)             return { success: false, error: 'No recipient phone number', channel: 'whatsapp' };

  const phone = normalizePhone(to);
  const toWhatsApp = `whatsapp:${phone}`;

  try {
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      new URLSearchParams({ From: fromWhatsApp, To: toWhatsApp, Body: body }),
      {
        auth: { username: sid, password: token },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );

    if (messageId) await Messages.updateStatus(messageId, 'sent');
    await Activity.log('whatsapp_sent', leadId, { to: phone });
    logger.info('WhatsApp sent via Twilio', { to: phone, leadId });
    return { success: true, channel: 'whatsapp' };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    logger.warn('Twilio WhatsApp failed, falling back to SMS', { to: phone, error: errMsg });
    if (messageId) await Messages.updateStatus(messageId, 'failed', errMsg);
    return { success: false, error: errMsg, channel: 'whatsapp' };
  }
}

// ─── Twilio SMS ───────────────────────────────────────────────────────────────

async function sendSMS({ to, body, leadId }) {
  const s = getSettings();
  const sid        = s.twilio_sid;
  const token      = s.twilio_token;
  const fromNumber = s.twilio_from_number;

  if (!sid || !token) return { success: false, error: 'Twilio credentials not configured', channel: 'sms' };
  if (!fromNumber)    return { success: false, error: 'Twilio SMS from number not configured', channel: 'sms' };
  if (!to)            return { success: false, error: 'No recipient phone number', channel: 'sms' };

  const phone = normalizePhone(to);

  try {
    const res = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      new URLSearchParams({ From: fromNumber, To: phone, Body: body }),
      {
        auth: { username: sid, password: token },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );

    const smsMsg = await Messages.create({
      lead_id: leadId,
      message_type: 'pitch',
      channel: 'sms',
      body,
      scheduled_for: null,
    });
    await Messages.updateStatus(smsMsg.id, 'sent');
    await Activity.log('sms_sent', leadId, { to: phone, sid: res.data?.sid });
    logger.info('SMS sent via Twilio', { to: phone, leadId });
    return { success: true, channel: 'sms' };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    logger.error('SMS failed', { to: phone, error: errMsg });
    await Activity.log('sms_failed', leadId, { to: phone, error: errMsg });
    return { success: false, error: errMsg, channel: 'sms' };
  }
}

// ─── Orchestrated Send ────────────────────────────────────────────────────────
// Logic:
//   - Email always attempted (if lead has email)
//   - If twilio_enabled = true AND lead has phone:
//       Try WhatsApp first → fall back to SMS if WhatsApp fails
//   - If twilio_enabled = false: only email

async function sendOutreach(lead, emailMsg, whatsappMsg) {
  const s = getSettings();
  const twilioEnabled = s.twilio_enabled === 'true' || s.twilio_enabled === true;
  const results = { email: null, messaging: null };

  // Email (independent)
  if (lead.email && emailMsg) {
    results.email = await sendEmail({
      to: lead.email,
      subject: emailMsg.subject,
      body: emailMsg.body,
      leadId: lead.id,
      messageId: emailMsg.id,
    });
  } else {
    logger.info('Skipping email — no email address', { lead_id: lead.id });
  }

  // WhatsApp → SMS (only if Twilio enabled and lead has a phone number)
  if (twilioEnabled && lead.phone && whatsappMsg) {
    const waResult = await sendWhatsApp({
      to: lead.phone,
      body: whatsappMsg.body,
      leadId: lead.id,
      messageId: whatsappMsg.id,
    });

    if (waResult.success) {
      results.messaging = waResult;
    } else {
      logger.info('WhatsApp failed — trying SMS fallback', { lead_id: lead.id });
      results.messaging = await sendSMS({
        to: lead.phone,
        body: whatsappMsg.body,
        leadId: lead.id,
      });
    }
  } else if (!twilioEnabled) {
    logger.info('Twilio disabled — skipping WhatsApp/SMS', { lead_id: lead.id });
  } else {
    logger.info('Skipping messaging — no phone number', { lead_id: lead.id });
  }

  return results;
}

async function sendFollowupEmail(lead, message) {
  if (!lead.email) {
    logger.info('Skipping followup email — no email', { lead_id: lead.id });
    return { success: false, reason: 'no_email' };
  }
  return sendEmail({
    to: lead.email,
    subject: message.subject,
    body: message.body,
    leadId: lead.id,
    messageId: message.id,
  });
}

// ─── Connection Tests ─────────────────────────────────────────────────────────

async function testHostingerSMTP() {
  const s = getSettings();
  if (!s.hostinger_smtp_user || !s.hostinger_smtp_pass) return { ok: false, error: 'SMTP credentials not set' };
  try {
    const transporter = nodemailer.createTransport({
      host: s.hostinger_smtp_host || 'smtp.hostinger.com',
      port: parseInt(s.hostinger_smtp_port || '465'),
      secure: true,
      auth: { user: s.hostinger_smtp_user, pass: s.hostinger_smtp_pass },
    });
    await transporter.verify();
    return { ok: true, message: 'SMTP connection verified' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function testTwilio() {
  const s = getSettings();
  if (!s.twilio_sid || !s.twilio_token) return { ok: false, error: 'Credentials not set' };
  try {
    const res = await axios.get(
      `https://api.twilio.com/2010-04-01/Accounts/${s.twilio_sid}.json`,
      { auth: { username: s.twilio_sid, password: s.twilio_token }, timeout: 8000 }
    );
    return { ok: true, account: res.data?.friendly_name };
  } catch (err) {
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

async function testGooglePlaces() {
  const s = getSettings();
  if (!s.google_places_key) return { ok: false, error: 'API key not set' };
  try {
    const res = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: { query: 'restaurant in Chennai', key: s.google_places_key },
      timeout: 8000,
    });
    if (res.data.status === 'REQUEST_DENIED') return { ok: false, error: 'API key invalid or Places API not enabled' };
    return { ok: true, status: res.data.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function testOpenRouter() {
  const s = getSettings();
  if (!s.openrouter_key) return { ok: false, error: 'API key not set' };
  try {
    const res = await axios.get('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${s.openrouter_key}` },
      timeout: 8000,
    });
    return { ok: true, models: res.data?.data?.length };
  } catch (err) {
    return { ok: false, error: err.response?.data?.error?.message || err.message };
  }
}

async function testSlack() {
  const s = getSettings();
  if (!s.slack_webhook_url) return { ok: false, error: 'Webhook URL not set' };
  try {
    await axios.post(s.slack_webhook_url, { text: '✅ LeadGen Slack test — connection works!' }, { timeout: 8000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  sendEmail,
  sendWhatsApp,
  sendSMS,
  sendOutreach,
  sendFollowupEmail,
  testHostingerSMTP,
  testTwilio,
  testGooglePlaces,
  testOpenRouter,
  testSlack,
};