'use strict';

const axios    = require('axios');
const { getSettings } = require('../config');
const { sendEmail } = require('../outreach');
const logger = require('../utils/logger');

async function postSlack(blocks, text = 'LeadGen Notification') {
  const settings = getSettings();
  const webhookUrl = settings.slack_webhook_url;
  if (!webhookUrl) { logger.warn('Slack webhook not configured'); return; }
  try {
    await axios.post(webhookUrl, { text, blocks }, { timeout: 8000 });
  } catch (err) {
    logger.error('Slack notification failed', { error: err.message });
  }
}

// ─── Reply Notification ───────────────────────────────────────────────────────

async function notifyReply({ lead, channel, replySnippet }) {
  const channelEmoji = channel === 'email' ? '📧' : channel === 'whatsapp' ? '💬' : '📱';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${channelEmoji} New Reply — ${lead.business_name}`, emoji: true },
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Business:*\n${lead.business_name}` },
        { type: 'mrkdwn', text: `*Category:*\n${lead.category || 'N/A'}` },
        { type: 'mrkdwn', text: `*Location:*\n${lead.location || 'N/A'}` },
        { type: 'mrkdwn', text: `*Channel:*\n${channelEmoji} ${channel.toUpperCase()}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Their Reply:*\n>${replySnippet?.substring(0, 300) || '(no preview)'}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '👁 Open in Admin', emoji: true },
          url: `https://lead.gadgeek.in/admin`,
          style: 'primary',
        },
      ],
    },
  ];

  await postSlack(blocks, `🔔 ${lead.business_name} replied via ${channel}`);
  logger.info('Reply notification sent to Slack', { lead_id: lead.id });
}

// ─── Morning Briefing ─────────────────────────────────────────────────────────

async function notifyMorningBriefing(stats, scanStats) {
  const settings  = getSettings();
  const now       = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const revenue   = `₹${Number(stats.revenue || 0).toLocaleString('en-IN')}`;

  // Conversion rate
  const convRate = stats.replied > 0 ? Math.round((stats.converted / stats.replied) * 100) : 0;

  // Pipeline health bar (emoji progress)
  const total = stats.total || 1;
  const pitchedPct   = Math.round(((stats.in_pipeline || 0) / total) * 10);
  const repliedPct   = Math.round(((stats.replied || 0) / total) * 10);
  const convertedPct = Math.round(((stats.converted || 0) / total) * 10);
  const bar = (n, emoji) => emoji.repeat(Math.max(0, n)) + '▪️'.repeat(Math.max(0, 10 - n));

  const blocks = [
    // ── Header ──
    {
      type: 'header',
      text: { type: 'plain_text', text: '🌅 LeadGen Morning Briefing', emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📅 ${now} IST` }],
    },
    { type: 'divider' },

    // ── KPIs Row 1 ──
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*📊 Pipeline Snapshot*' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*🗂 Total Leads*\n\`${stats.total || 0}\`` },
        { type: 'mrkdwn', text: `*🆕 New Today*\n\`+${stats.found_today || 0}\`` },
        { type: 'mrkdwn', text: `*📤 In Pipeline*\n\`${stats.in_pipeline || 0}\`` },
        { type: 'mrkdwn', text: `*⏳ Awaiting Pitch*\n\`${stats.new_leads || 0}\`` },
      ],
    },

    // ── KPIs Row 2 ──
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*💬 Replied*\n\`${stats.replied || 0}\`` },
        { type: 'mrkdwn', text: `*🎉 Converted*\n\`${stats.converted || 0}\`` },
        { type: 'mrkdwn', text: `*📈 Conv. Rate*\n\`${convRate}%\`` },
        { type: 'mrkdwn', text: `*💰 Revenue*\n\`${revenue}\`` },
      ],
    },

    { type: 'divider' },

    // ── Website Status ──
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*🌐 Website Status Breakdown*' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*🚫 No Website*\n\`${stats.no_website || 0}\` leads` },
        { type: 'mrkdwn', text: `*💀 Dead Website*\n\`${stats.dead_website || 0}\` leads` },
        { type: 'mrkdwn', text: `*🅿 Parked Website*\n\`${stats.parked_website || 0}\` leads` },
        { type: 'mrkdwn', text: `*📦 Archived*\n\`${stats.archived || 0}\` leads` },
      ],
    },

    { type: 'divider' },

    // ── Follow-up Queue ──
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*📅 Follow-up Queue*' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Day 3 (FU#1):*\n\`${stats.followed_up_1 || 0}\` pending` },
        { type: 'mrkdwn', text: `*Day 5 (FU#2):*\n\`${stats.followed_up_2 || 0}\` pending` },
        { type: 'mrkdwn', text: `*Day 7 (FU#3):*\n\`${stats.followed_up_3 || 0}\` pending` },
      ],
    },
  ];

  // ── Last Scan ──
  if (scanStats) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*🔍 Last Night\'s Scan*' },
    });
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Found:*\n\`${scanStats.leads_found || 0}\`` },
        { type: 'mrkdwn', text: `*New Added:*\n\`${scanStats.leads_new || 0}\`` },
        { type: 'mrkdwn', text: `*Skipped (dup):*\n\`${scanStats.leads_skipped || 0}\`` },
      ],
    });
  }

  // ── CTA ──
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '🚀 Open Admin Panel', emoji: true },
        url: 'https://lead.gadgeek.in/admin',
        style: 'primary',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '⚡ View Leads', emoji: true },
        url: 'https://lead.gadgeek.in/admin',
      },
    ],
  });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '⚙️ LeadGen by Gadgeek · Auto-generated briefing · <https://lead.gadgeek.in/admin|Manage Settings>' }],
  });

  await postSlack(blocks, '🌅 LeadGen Morning Briefing');

  // ── Email Briefing ──
  const briefingEmail = settings.briefing_email;
  if (briefingEmail) {
    const emailBody = `
LeadGen Morning Briefing
========================
${now} IST

PIPELINE OVERVIEW
-----------------
Total Leads     : ${stats.total || 0}
New Today       : +${stats.found_today || 0}
In Pipeline     : ${stats.in_pipeline || 0}
Awaiting Pitch  : ${stats.new_leads || 0}
Replied         : ${stats.replied || 0}
Converted       : ${stats.converted || 0}
Conv. Rate      : ${convRate}%
Revenue         : ${revenue}

WEBSITE STATUS
--------------
No Website      : ${stats.no_website || 0}
Dead Website    : ${stats.dead_website || 0}
Parked Website  : ${stats.parked_website || 0}
Archived        : ${stats.archived || 0}

FOLLOW-UP QUEUE
---------------
Day 3 (FU #1)  : ${stats.followed_up_1 || 0} pending
Day 5 (FU #2)  : ${stats.followed_up_2 || 0} pending
Day 7 (FU #3)  : ${stats.followed_up_3 || 0} pending

${scanStats ? `LAST NIGHT'S SCAN\n-----------------\nFound: ${scanStats.leads_found} | New: ${scanStats.leads_new} | Skipped: ${scanStats.leads_skipped}` : ''}

View details: https://lead.gadgeek.in/admin
    `.trim();

    await sendEmail({
      to: briefingEmail,
      subject: `☀️ LeadGen Briefing — ${new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}`,
      body: emailBody,
      leadId: null,
      messageId: null,
    });
  }
}

// ─── Scan Complete Notification ───────────────────────────────────────────────

async function notifyScanComplete({ found, new_leads, skipped, areas, categories }) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `✅ *Scan Complete*\n*Found:* \`${found}\`  |  *New Leads:* \`${new_leads}\`  |  *Skipped:* \`${skipped}\`\n*Areas:* ${areas.join(', ')}\n*Categories:* ${categories.join(', ')}`,
      },
    },
  ];
  await postSlack(blocks, `✅ Scan complete — ${new_leads} new leads`);
}

module.exports = { notifyReply, notifyMorningBriefing, notifyScanComplete, postSlack };