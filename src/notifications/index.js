'use strict';

const axios = require('axios');
const { getSettings } = require('../config');
const { sendEmail } = require('../outreach');
const logger = require('../utils/logger');

async function postSlack(blocks, text = 'LeadGen Notification') {
  const settings = getSettings();
  const webhookUrl = settings.slack_webhook_url;
  if (!webhookUrl) {
    logger.warn('Slack webhook not configured, skipping notification');
    return;
  }
  try {
    await axios.post(webhookUrl, { text, blocks }, { timeout: 8000 });
  } catch (err) {
    logger.error('Slack notification failed', { error: err.message });
  }
}

async function notifyReply({ lead, channel, replySnippet }) {
  const channelEmoji = channel === 'email' ? '📧' : channel === 'whatsapp' ? '💬' : '📱';
  const adminUrl = `https://lead.gadgeek.in/admin`;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${channelEmoji} New Reply from ${lead.business_name}!`, emoji: true },
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Business:*\n${lead.business_name}` },
        { type: 'mrkdwn', text: `*Category:*\n${lead.category || 'N/A'}` },
        { type: 'mrkdwn', text: `*Location:*\n${lead.location || 'N/A'}` },
        { type: 'mrkdwn', text: `*Channel:*\n${channel.toUpperCase()}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Reply Preview:*\n>${replySnippet?.substring(0, 200) || '(no preview)'}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '👁 View in Admin', emoji: true },
          url: `${adminUrl}#leads/${lead.id}`,
          style: 'primary',
        },
      ],
    },
  ];

  await postSlack(blocks, `🔔 Reply from ${lead.business_name} via ${channel}`);
  logger.info('Reply notification sent to Slack', { lead_id: lead.id });
}

async function notifyMorningBriefing(stats, scanStats) {
  const settings = getSettings();

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🌅 LeadGen Morning Briefing', emoji: true },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*📊 Pipeline Overview*' },
      fields: [
        { type: 'mrkdwn', text: `*Total Leads:*\n${stats.total}` },
        { type: 'mrkdwn', text: `*In Pipeline:*\n${stats.in_pipeline}` },
        { type: 'mrkdwn', text: `*Replied:*\n${stats.replied}` },
        { type: 'mrkdwn', text: `*Converted:*\n${stats.converted}` },
      ],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*New Leads (24h):*\n${stats.found_today}` },
        { type: 'mrkdwn', text: `*Revenue:*\n₹${Number(stats.revenue || 0).toLocaleString('en-IN')}` },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*🔍 Website Status Breakdown*' },
      fields: [
        { type: 'mrkdwn', text: `*No Website:*\n${stats.no_website}` },
        { type: 'mrkdwn', text: `*Dead Website:*\n${stats.dead_website}` },
        { type: 'mrkdwn', text: `*Parked Website:*\n${stats.parked_website}` },
      ],
    },
  ];

  if (scanStats) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🔍 Last Scan Results*\nFound: ${scanStats.leads_found} | New: ${scanStats.leads_new} | Skipped: ${scanStats.leads_skipped}`,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Generated at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST | <https://lead.gadgeek.in/admin|Open Admin>`,
      },
    ],
  });

  await postSlack(blocks, '🌅 LeadGen Morning Briefing');

  // Also send email briefing
  const briefingEmail = settings.briefing_email;
  if (briefingEmail) {
    const emailBody = `
LeadGen Morning Briefing
========================
Generated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST

PIPELINE OVERVIEW
-----------------
Total Leads:    ${stats.total}
In Pipeline:    ${stats.in_pipeline}
Replied:        ${stats.replied}
Converted:      ${stats.converted}
New (24h):      ${stats.found_today}
Revenue:        ₹${Number(stats.revenue || 0).toLocaleString('en-IN')}

WEBSITE STATUS
--------------
No Website:     ${stats.no_website}
Dead Website:   ${stats.dead_website}
Parked Website: ${stats.parked_website}

${scanStats ? `LAST SCAN\n---------\nFound: ${scanStats.leads_found} | New: ${scanStats.leads_new} | Skipped: ${scanStats.leads_skipped}` : ''}

View full details: https://lead.gadgeek.in/admin
    `.trim();

    await sendEmail({
      to: briefingEmail,
      subject: `LeadGen Briefing — ${new Date().toLocaleDateString('en-IN')}`,
      body: emailBody,
      leadId: null,
      messageId: null,
    });
  }
}

async function notifyScanComplete({ found, new_leads, skipped, areas, categories }) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `✅ *Scan Complete*\nFound: *${found}* | New leads: *${new_leads}* | Skipped: *${skipped}*\nAreas: ${areas.join(', ')}\nCategories: ${categories.join(', ')}`,
      },
    },
  ];
  await postSlack(blocks, `✅ Scan complete — ${new_leads} new leads`);
}

module.exports = { notifyReply, notifyMorningBriefing, notifyScanComplete, postSlack };
