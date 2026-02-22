'use strict';

const axios = require('axios');
const { getSettings } = require('../config');
const { Messages, Activity } = require('../db');
const logger = require('../utils/logger');

// ─── SendGrid Email ───────────────────────────────────────────────────────────

async function sendEmail({ to, subject, body, leadId, messageId }) {
  const settings = getSettings();
  const apiKey = settings.sendgrid_key;
  const fromEmail = settings.from_email;
  const fromName = settings.from_name || 'LeadGen';

  if (!apiKey) throw new Error('SendGrid API key not configured');
  if (!fromEmail) throw new Error('From email not configured');
  if (!to) throw new Error('No recipient email');

  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await axios.post(
        'https://api.sendgrid.com/v3/mail/send',
        {
          personalizations: [{ to: [{ email: to }] }],
          from: { email: fromEmail, name: fromName },
          subject,
          content: [{ type: 'text/plain', value: body }],
          reply_to: { email: fromEmail },
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      if (messageId) await Messages.updateStatus(messageId, 'sent');
      await Activity.log('email_sent', leadId, { to, subject, attempt });
      logger.info('Email sent', { to, leadId, attempt });
      return { success: true };
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      logger.warn('Email send failed', { to, attempt, status, error: err.message });

      if (messageId) await Messages.incrementRetry(messageId);

      // Don't retry on permanent failures
      if (status === 400 || status === 401 || status === 403) break;

      if (attempt < MAX_RETRIES) {
        await sleep(attempt * 2000);
      }
    }
  }

  if (messageId) {
    await Messages.updateStatus(messageId, 'failed', lastError?.message);
  }
  await Activity.log('email_failed', leadId, { to, error: lastError?.message });
  logger.error('Email failed after retries', { to, leadId, error: lastError?.message });
  return { success: false, error: lastError?.message };
}

// ─── WaSenderAPI WhatsApp ─────────────────────────────────────────────────────

async function sendWhatsApp({ to, body, leadId, messageId }) {
  const settings = getSettings();
  const apiKey = settings.wasender_api_key;
  const fromNumber = settings.wasender_phone_number;

  if (!apiKey) return { success: false, error: 'WaSender API key not configured', channel: 'whatsapp' };
  if (!to) return { success: false, error: 'No recipient phone number', channel: 'whatsapp' };

  // Normalize phone: remove spaces/dashes, ensure starts with +
  const phone = normalizePhone(to);

  try {
    const res = await axios.post(
      'https://www.wasenderapi.com/api/send-message',
      {
        phone,
        message: body,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const success = res.data?.success === true || res.status === 200;
    if (!success) throw new Error(res.data?.message || 'WaSender returned failure');

    if (messageId) await Messages.updateStatus(messageId, 'sent');
    await Activity.log('whatsapp_sent', leadId, { to: phone });
    logger.info('WhatsApp sent', { to: phone, leadId });
    return { success: true, channel: 'whatsapp' };
  } catch (err) {
    logger.warn('WhatsApp failed, falling back to SMS', { to: phone, error: err.message });
    if (messageId) await Messages.updateStatus(messageId, 'failed', err.message);
    return { success: false, error: err.message, channel: 'whatsapp' };
  }
}

// ─── Twilio SMS Fallback ──────────────────────────────────────────────────────

async function sendSMS({ to, body, leadId }) {
  const settings = getSettings();
  const sid = settings.twilio_sid;
  const token = settings.twilio_token;
  const fromNumber = settings.twilio_from_number;

  if (!sid || !token) throw new Error('Twilio credentials not configured');
  if (!fromNumber) throw new Error('Twilio from number not configured');
  if (!to) throw new Error('No recipient phone number');

  const phone = normalizePhone(to);

  try {
    const res = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      new URLSearchParams({
        From: fromNumber,
        To: phone,
        Body: body,
      }),
      {
        auth: { username: sid, password: token },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );

    // Create a new SMS message record
    const smsMsg = await Messages.create({
      lead_id: leadId,
      message_type: 'pitch',
      channel: 'sms',
      body,
      scheduled_for: null,
    });
    await Messages.updateStatus(smsMsg.id, 'sent');
    await Activity.log('sms_sent', leadId, { to: phone, sid: res.data?.sid });
    logger.info('SMS sent (fallback)', { to: phone, leadId });
    return { success: true, channel: 'sms' };
  } catch (err) {
    logger.error('SMS fallback also failed', { to: phone, error: err.message });
    await Activity.log('sms_failed', leadId, { to: phone, error: err.message });
    return { success: false, error: err.message, channel: 'sms' };
  }
}

// ─── Orchestrated Send ────────────────────────────────────────────────────────

async function sendOutreach(lead, emailMsg, smsMsg) {
  const results = { email: null, messaging: null };

  // Send email (independent of messaging)
  if (lead.email && emailMsg) {
    results.email = await sendEmail({
      to: lead.email,
      subject: emailMsg.subject,
      body: emailMsg.body,
      leadId: lead.id,
      messageId: emailMsg.id,
    });
  } else {
    logger.info('Skipping email — no email address for lead', { lead_id: lead.id });
  }

  // Send WhatsApp first, fall back to SMS
  if (lead.phone && smsMsg) {
    const waResult = await sendWhatsApp({
      to: lead.phone,
      body: smsMsg.body,
      leadId: lead.id,
      messageId: smsMsg.id,
    });

    if (waResult.success) {
      results.messaging = waResult;
    } else {
      // Fall back to SMS
      results.messaging = await sendSMS({
        to: lead.phone,
        body: smsMsg.body,
        leadId: lead.id,
      });
    }
  } else {
    logger.info('Skipping messaging — no phone number for lead', { lead_id: lead.id });
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

async function testSendGrid() {
  const settings = getSettings();
  if (!settings.sendgrid_key) return { ok: false, error: 'API key not set' };
  try {
    const res = await axios.get('https://api.sendgrid.com/v3/user/profile', {
      headers: { Authorization: `Bearer ${settings.sendgrid_key}` },
      timeout: 8000,
    });
    return { ok: true, username: res.data?.username };
  } catch (err) {
    return { ok: false, error: err.response?.data?.errors?.[0]?.message || err.message };
  }
}

async function testTwilio() {
  const settings = getSettings();
  if (!settings.twilio_sid || !settings.twilio_token) return { ok: false, error: 'Credentials not set' };
  try {
    const res = await axios.get(
      `https://api.twilio.com/2010-04-01/Accounts/${settings.twilio_sid}.json`,
      { auth: { username: settings.twilio_sid, password: settings.twilio_token }, timeout: 8000 }
    );
    return { ok: true, account: res.data?.friendly_name };
  } catch (err) {
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

async function testWaSender() {
  const settings = getSettings();
  if (!settings.wasender_api_key) return { ok: false, error: 'API key not set' };
  try {
    const res = await axios.get('https://www.wasenderapi.com/api/check-connection', {
      headers: { Authorization: `Bearer ${settings.wasender_api_key}` },
      timeout: 8000,
    });
    return { ok: true, status: res.data?.status };
  } catch (err) {
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

async function testGooglePlaces() {
  const settings = getSettings();
  if (!settings.google_places_key) return { ok: false, error: 'API key not set' };
  try {
    const res = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: { query: 'restaurant in Chennai', key: settings.google_places_key },
      timeout: 8000,
    });
    if (res.data.status === 'REQUEST_DENIED') {
      return { ok: false, error: 'API key invalid or Places API not enabled' };
    }
    return { ok: true, status: res.data.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function testOpenRouter() {
  const settings = getSettings();
  if (!settings.openrouter_key) return { ok: false, error: 'API key not set' };
  try {
    const res = await axios.get('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${settings.openrouter_key}` },
      timeout: 8000,
    });
    return { ok: true, models: res.data?.data?.length };
  } catch (err) {
    return { ok: false, error: err.response?.data?.error?.message || err.message };
  }
}

async function testSlack() {
  const settings = getSettings();
  if (!settings.slack_webhook_url) return { ok: false, error: 'Webhook URL not set' };
  try {
    await axios.post(settings.slack_webhook_url, { text: '✅ LeadGen Slack test — connection works!' }, { timeout: 8000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePhone(phone) {
  if (!phone) return phone;
  let p = phone.replace(/[\s\-()]/g, '');
  if (!p.startsWith('+')) p = '+' + p;
  return p;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  sendEmail,
  sendWhatsApp,
  sendSMS,
  sendOutreach,
  sendFollowupEmail,
  testSendGrid,
  testTwilio,
  testWaSender,
  testGooglePlaces,
  testOpenRouter,
  testSlack,
};