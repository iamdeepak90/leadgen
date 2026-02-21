'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const basicAuth = require('express-basic-auth');

const { loadSettings } = require('./config');
const { pool } = require('./db');
const apiRoutes = require('./api/routes');
const { startJobs } = require('./jobs');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Auth for Admin Panel ─────────────────────────────────────────────────────

const adminAuth = basicAuth({
  users: { 'lead@gadgeek.in': 'HelloGG@$44' },
  challenge: true,
  realm: 'LeadGen Admin',
});

// ─── Static Admin Panel (auth protected) ─────────────────────────────────────

app.use('/admin', adminAuth, express.static(path.join(__dirname, 'admin')));

// Serve index.html for any /admin/* route (SPA fallback)
app.get('/admin/*', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// ─── API Routes (webhooks are public, rest is auth protected) ─────────────────

// Webhooks must be unauthenticated (called by external services)
app.use('/api/webhooks', apiRoutes);

// All other API routes require admin auth
app.use('/api', adminAuth, apiRoutes);

// ─── Health Check (public) ────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString(), service: 'leadgen' });
});

// Root redirect to admin
app.get('/', (req, res) => res.redirect('/admin'));

// ─── 404 Handler ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// ─── Error Handler ────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  try {
    // Test DB connection
    await pool.query('SELECT 1');
    logger.info('Database connected');

    // Load settings from DB before anything else
    await loadSettings();
    logger.info('Settings loaded');

    // Start cron jobs
    startJobs();
    logger.info('Cron jobs started');

    app.listen(PORT, () => {
      logger.info(`LeadGen server running on port ${PORT}`);
      logger.info(`Admin panel: https://lead.gadgeek.in/admin`);
    });
  } catch (err) {
    logger.error('Startup failed', { error: err.message });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  const { stopJobs } = require('./jobs');
  stopJobs();
  await pool.end();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

start();
