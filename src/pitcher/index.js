'use strict';

const axios = require('axios');
const { getSettings } = require('../config');
const { Messages, Leads, Activity } = require('../db');
const logger = require('../utils/logger');

function buildLeadContext(lead) {
  const gmb = lead.raw_gmb_data || {};
  const hoursText = Array.isArray(lead.opening_hours)
    ? lead.opening_hours.join(', ')
    : (gmb.opening_hours?.weekday_text || []).join(', ') || 'Not listed';

  return `
Business Name: ${lead.business_name}
Category: ${lead.category}
Location: ${lead.location}
Address: ${lead.address || 'Not listed'}
Phone: ${lead.phone || 'Not listed'}
Google Rating: ${lead.rating ? `${lead.rating}/5` : 'No rating'}
Total Reviews: ${lead.review_count || 0}
Has Photos on GMB: ${lead.has_photos ? 'Yes' : 'No'}
Opening Hours: ${hoursText || 'Not listed'}
Website Status: ${lead.website_status === 'none' ? 'No website at all' : lead.website_status === 'dead' ? 'Website is broken/unreachable' : 'Website is parked (placeholder)'}
GMB Profile URL: ${lead.gmb_url || 'Not available'}
`.trim();
}

function buildFollowupContext(lead, followupNumber) {
  const base = buildLeadContext(lead);
  return `${base}\nFollow-up Number: ${followupNumber} of 3`;
}

async function callOpenRouter(systemPrompt, userPrompt) {
  const settings = getSettings();
  const apiKey = settings.openrouter_key;
  const model = settings.openrouter_model || 'anthropic/claude-sonnet-4-5';
  const maxTokens = settings.max_tokens || 1000;

  if (!apiKey) throw new Error('OpenRouter API key not configured');

  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model,
      max_tokens: Number(maxTokens),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://lead.gadgeek.in',
        'X-Title': 'LeadGen System',
      },
      timeout: 30000,
    }
  );

  const content = res.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from OpenRouter');
  return content.trim();
}

async function generateEmailSubject(lead) {
  const name = lead.business_name;
  const status = lead.website_status === 'none'
    ? "you don't have a website yet"
    : lead.website_status === 'dead'
    ? "your website seems to be down"
    : "your website needs attention";
  
  // Generate a compelling subject line
  const subjects = [
    `${name} — ${status}`,
    `Quick question about ${name}'s online presence`,
    `Helping ${name} get more customers online`,
  ];
  return subjects[Math.floor(Math.random() * subjects.length)];
}

async function generatePitch(lead) {
  const settings = getSettings();
  const leadContext = buildLeadContext(lead);

  logger.info('Generating pitch', { lead_id: lead.id, name: lead.business_name });

  // Generate email pitch
  const emailBody = await callOpenRouter(
    settings.email_system_prompt,
    `${settings.email_user_instructions}\n\n---\nBUSINESS DETAILS:\n${leadContext}`
  );

  // Generate WhatsApp/SMS pitch
  const smsBody = await callOpenRouter(
    settings.whatsapp_system_prompt,
    `${settings.whatsapp_user_instructions}\n\n---\nBUSINESS DETAILS:\n${leadContext}`
  );

  const subject = await generateEmailSubject(lead);

  // Store email message
  const emailMsg = await Messages.create({
    lead_id: lead.id,
    message_type: 'pitch',
    channel: 'email',
    subject,
    body: emailBody,
    scheduled_for: null,
  });

  // Store SMS/WhatsApp message
  const smsMsg = await Messages.create({
    lead_id: lead.id,
    message_type: 'pitch',
    channel: 'whatsapp', // will try whatsapp first, fall back to sms
    subject: null,
    body: smsBody,
    scheduled_for: null,
  });

  await Leads.updateStatus(lead.id, 'pitched');
  await Activity.log('pitch_generated', lead.id, { email_msg_id: emailMsg.id, sms_msg_id: smsMsg.id });

  return { emailMsg, smsMsg, subject, emailBody, smsBody };
}

async function generateFollowup(lead, followupNumber) {
  const settings = getSettings();
  const followupContext = buildFollowupContext(lead, followupNumber);

  const systemKey = `followup${followupNumber}_system_prompt`;
  const userKey = `followup${followupNumber}_user_instructions`;

  const systemPrompt = settings[systemKey] || settings.email_system_prompt;
  const userInstructions = settings[userKey] || settings.email_user_instructions;

  logger.info('Generating followup', { lead_id: lead.id, followup: followupNumber });

  const body = await callOpenRouter(
    systemPrompt,
    `${userInstructions}\n\n---\nBUSINESS DETAILS:\n${followupContext}`
  );

  const subjects = {
    1: `Re: ${lead.business_name} — just checking in`,
    2: `${lead.business_name} — what competitors are doing online`,
    3: `${lead.business_name} — my last message + a bonus offer`,
  };

  const msgType = `followup_${followupNumber}`;

  const msg = await Messages.create({
    lead_id: lead.id,
    message_type: msgType,
    channel: 'email',
    subject: subjects[followupNumber],
    body,
    scheduled_for: null,
  });

  await Activity.log(`followup_${followupNumber}_generated`, lead.id, { msg_id: msg.id });

  return msg;
}

module.exports = { generatePitch, generateFollowup, callOpenRouter };
