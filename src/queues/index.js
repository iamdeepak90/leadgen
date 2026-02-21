'use strict';

const Bull = require('bull');
const { getSettings } = require('../config');
const { Leads, Messages, Activity } = require('../db');
const logger = require('../utils/logger');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ─── Queue Definitions ────────────────────────────────────────────────────────

const pitchQueue = new Bull('pitch-queue', REDIS_URL, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

const followupQueue = new Bull('followup-queue', REDIS_URL, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

const notifyQueue = new Bull('notify-queue', REDIS_URL, {
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 3000 },
    removeOnComplete: 50,
    removeOnFail: 50,
  },
});

// ─── Pitch Worker ─────────────────────────────────────────────────────────────

pitchQueue.process(async (job) => {
  const { leadId } = job.data;
  const settings = getSettings();

  // Lazy require to avoid circular deps
  const { generatePitch } = require('../pitcher');
  const { sendOutreach } = require('../outreach');

  logger.info('Processing pitch job', { leadId, jobId: job.id });

  const lead = await Leads.findById(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  if (lead.status !== 'new') {
    logger.info('Lead already processed, skipping', { leadId, status: lead.status });
    return { skipped: true };
  }

  // Generate pitch content
  const { emailMsg, smsMsg } = await generatePitch(lead);

  // Send outreach
  const sendResults = await sendOutreach(lead, emailMsg, smsMsg);

  // Schedule follow-ups
  const followup1Days = Number(settings.followup_1_days) || 3;
  const followup2Days = Number(settings.followup_2_days) || 5;
  const followup3Days = Number(settings.followup_3_days) || 7;

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  if (settings.auto_followup_enabled) {
    await followupQueue.add(
      { leadId, followupNumber: 1 },
      { delay: followup1Days * dayMs, jobId: `followup-${leadId}-1` }
    );
    await followupQueue.add(
      { leadId, followupNumber: 2 },
      { delay: followup2Days * dayMs, jobId: `followup-${leadId}-2` }
    );
    await followupQueue.add(
      { leadId, followupNumber: 3 },
      { delay: followup3Days * dayMs, jobId: `followup-${leadId}-3` }
    );
    logger.info('Follow-ups scheduled', { leadId, days: [followup1Days, followup2Days, followup3Days] });
  }

  return { leadId, email: sendResults.email, messaging: sendResults.messaging };
});

// ─── Followup Worker ──────────────────────────────────────────────────────────

followupQueue.process(async (job) => {
  const { leadId, followupNumber } = job.data;
  const settings = getSettings();

  if (!settings.auto_followup_enabled) {
    logger.info('Auto followup disabled, skipping', { leadId });
    return { skipped: true };
  }

  const { generateFollowup } = require('../pitcher');
  const { sendFollowupEmail } = require('../outreach');

  logger.info('Processing followup job', { leadId, followupNumber, jobId: job.id });

  const lead = await Leads.findById(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);

  // Cancel if lead has replied or been archived/converted
  if (['replied', 'archived', 'converted'].includes(lead.status)) {
    logger.info('Lead already handled, cancelling followup', { leadId, status: lead.status });
    return { cancelled: true, reason: lead.status };
  }

  const message = await generateFollowup(lead, followupNumber);
  await sendFollowupEmail(lead, message);

  const newStatus = `followed_up_${followupNumber}`;
  await Leads.updateStatus(leadId, newStatus);

  // After 3rd followup with no reply, archive
  if (followupNumber === 3) {
    // Give 48h grace period for reply before archiving
    await followupQueue.add(
      { leadId, followupNumber: 'archive' },
      { delay: 48 * 60 * 60 * 1000, jobId: `archive-${leadId}` }
    );
  }

  return { leadId, followupNumber, status: newStatus };
});

// Handle archive job
followupQueue.process(async (job) => {
  if (job.data.followupNumber !== 'archive') return;
  const { leadId } = job.data;

  const lead = await Leads.findById(leadId);
  if (!lead) return;

  if (!['replied', 'converted'].includes(lead.status)) {
    await Leads.updateStatus(leadId, 'archived');
    await Activity.log('lead_archived', leadId, { reason: 'no_reply_after_3_followups' });
    logger.info('Lead auto-archived', { leadId });
  }
});

// ─── Notify Worker ────────────────────────────────────────────────────────────

notifyQueue.process(async (job) => {
  const { type, data } = job.data;
  const { notifyReply, notifyMorningBriefing, notifyScanComplete } = require('../notifications');

  switch (type) {
    case 'reply':
      await notifyReply(data);
      break;
    case 'briefing':
      await notifyMorningBriefing(data.stats, data.scanStats);
      break;
    case 'scan_complete':
      await notifyScanComplete(data);
      break;
    default:
      logger.warn('Unknown notify job type', { type });
  }
});

// ─── Error Handlers ───────────────────────────────────────────────────────────

pitchQueue.on('failed', (job, err) => {
  logger.error('Pitch job failed', { jobId: job.id, leadId: job.data.leadId, error: err.message });
});

followupQueue.on('failed', (job, err) => {
  logger.error('Followup job failed', { jobId: job.id, leadId: job.data.leadId, error: err.message });
});

notifyQueue.on('failed', (job, err) => {
  logger.error('Notify job failed', { jobId: job.id, error: err.message });
});

// ─── Queue Helpers ────────────────────────────────────────────────────────────

async function cancelFollowupsForLead(leadId) {
  const keys = [`followup-${leadId}-1`, `followup-${leadId}-2`, `followup-${leadId}-3`];
  for (const key of keys) {
    try {
      const job = await followupQueue.getJob(key);
      if (job) {
        await job.remove();
        logger.info('Cancelled followup job', { jobId: key, leadId });
      }
    } catch (err) {
      logger.warn('Could not cancel followup job', { key, error: err.message });
    }
  }
  // Also cancel in messages table
  await Messages.cancelPendingForLead(leadId);
}

async function enqueuePitch(leadId, delay = 0) {
  return pitchQueue.add({ leadId }, { delay, jobId: `pitch-${leadId}` });
}

async function getQueueStats() {
  const [pitchWaiting, pitchActive, pitchFailed] = await Promise.all([
    pitchQueue.getWaitingCount(),
    pitchQueue.getActiveCount(),
    pitchQueue.getFailedCount(),
  ]);
  const [followupWaiting, followupActive, followupDelayed] = await Promise.all([
    followupQueue.getWaitingCount(),
    followupQueue.getActiveCount(),
    followupQueue.getDelayedCount(),
  ]);

  return {
    pitch: { waiting: pitchWaiting, active: pitchActive, failed: pitchFailed },
    followup: { waiting: followupWaiting, active: followupActive, delayed: followupDelayed },
  };
}

module.exports = {
  pitchQueue,
  followupQueue,
  notifyQueue,
  enqueuePitch,
  cancelFollowupsForLead,
  getQueueStats,
};
