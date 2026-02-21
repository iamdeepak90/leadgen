'use strict';

const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  logger.error('Unexpected DB pool error', { error: err.message });
});

// ─── Settings ────────────────────────────────────────────────────────────────

const Settings = {
  async getAll() {
    const res = await pool.query('SELECT key, value FROM settings ORDER BY key');
    const obj = {};
    for (const row of res.rows) obj[row.key] = row.value;
    return obj;
  },

  async get(key) {
    const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return res.rows[0]?.value ?? null;
  },

  async set(key, value) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
  },

  async setMany(pairs) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [key, value] of Object.entries(pairs)) {
        await client.query(
          `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [key, String(value)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

// ─── Leads ───────────────────────────────────────────────────────────────────

const Leads = {
  async upsert(data) {
    const {
      place_id, business_name, category, location, address,
      phone, email, gmb_url, rating, review_count, has_photos,
      opening_hours, website_url, website_status, raw_gmb_data,
    } = data;
    const res = await pool.query(
      `INSERT INTO leads
         (place_id, business_name, category, location, address, phone, email,
          gmb_url, rating, review_count, has_photos, opening_hours,
          website_url, website_status, raw_gmb_data, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (place_id) DO UPDATE SET
         business_name = EXCLUDED.business_name,
         phone = COALESCE(EXCLUDED.phone, leads.phone),
         email = COALESCE(EXCLUDED.email, leads.email),
         rating = EXCLUDED.rating,
         review_count = EXCLUDED.review_count,
         has_photos = EXCLUDED.has_photos,
         raw_gmb_data = EXCLUDED.raw_gmb_data,
         updated_at = NOW()
       RETURNING *, (xmax = 0) AS inserted`,
      [place_id, business_name, category, location, address,
       phone, email, gmb_url, rating, review_count, has_photos,
       JSON.stringify(opening_hours), website_url, website_status,
       JSON.stringify(raw_gmb_data)]
    );
    return res.rows[0];
  },

  async findById(id) {
    const res = await pool.query('SELECT * FROM leads WHERE id = $1', [id]);
    return res.rows[0] || null;
  },

  async findByPlaceId(place_id) {
    const res = await pool.query('SELECT * FROM leads WHERE place_id = $1', [place_id]);
    return res.rows[0] || null;
  },

  async list({ status, website_status, category, location, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const params = [];
    let i = 1;

    if (status) { conditions.push(`l.status = $${i++}`); params.push(status); }
    if (website_status) { conditions.push(`l.website_status = $${i++}`); params.push(website_status); }
    if (category) { conditions.push(`l.category ILIKE $${i++}`); params.push(`%${category}%`); }
    if (location) { conditions.push(`l.location ILIKE $${i++}`); params.push(`%${location}%`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit, offset);

    const res = await pool.query(
      `SELECT l.*, 
         (SELECT COUNT(*) FROM messages m WHERE m.lead_id = l.id) as message_count,
         (SELECT COUNT(*) FROM replies r WHERE r.lead_id = l.id) as reply_count
       FROM leads l
       ${where}
       ORDER BY l.created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      params
    );

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM leads l ${where}`,
      params.slice(0, -2)
    );

    return { leads: res.rows, total: parseInt(countRes.rows[0].count) };
  },

  async updateStatus(id, status) {
    const extra = status === 'converted' ? ', converted_at = NOW()' :
                  status === 'archived' ? ', archived_at = NOW()' : '';
    const res = await pool.query(
      `UPDATE leads SET status = $1, updated_at = NOW() ${extra} WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return res.rows[0];
  },

  async updateNotes(id, notes) {
    const res = await pool.query(
      'UPDATE leads SET notes = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [notes, id]
    );
    return res.rows[0];
  },

  async setConverted(id, revenue) {
    const res = await pool.query(
      `UPDATE leads SET status = 'converted', revenue = $1, converted_at = NOW(), updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [revenue, id]
    );
    return res.rows[0];
  },

  async getPitchQueue(limit = 50) {
    const res = await pool.query(
      `SELECT * FROM leads WHERE status = 'new' ORDER BY created_at ASC LIMIT $1`,
      [limit]
    );
    return res.rows;
  },

  async stats() {
    const res = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('archived')) AS total,
        COUNT(*) FILTER (WHERE status IN ('pitched','followed_up_1','followed_up_2','followed_up_3')) AS in_pipeline,
        COUNT(*) FILTER (WHERE status = 'replied') AS replied,
        COUNT(*) FILTER (WHERE status = 'converted') AS converted,
        COALESCE(SUM(revenue) FILTER (WHERE status = 'converted'), 0) AS revenue,
        COUNT(*) FILTER (WHERE status = 'new') AS new_leads,
        COUNT(*) FILTER (WHERE website_status = 'none') AS no_website,
        COUNT(*) FILTER (WHERE website_status = 'dead') AS dead_website,
        COUNT(*) FILTER (WHERE website_status = 'parked') AS parked_website,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS found_today
      FROM leads
    `);
    return res.rows[0];
  },
};

// ─── Messages ─────────────────────────────────────────────────────────────────

const Messages = {
  async create(data) {
    const { lead_id, message_type, channel, subject, body, scheduled_for } = data;
    const res = await pool.query(
      `INSERT INTO messages (lead_id, message_type, channel, subject, body, scheduled_for)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [lead_id, message_type, channel, subject, body, scheduled_for]
    );
    return res.rows[0];
  },

  async updateStatus(id, status, error_text = null) {
    const res = await pool.query(
      `UPDATE messages SET status = $1, sent_at = CASE WHEN $1 = 'sent' THEN NOW() ELSE sent_at END,
       error_text = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [status, error_text, id]
    );
    return res.rows[0];
  },

  async incrementRetry(id) {
    await pool.query(
      'UPDATE messages SET retry_count = retry_count + 1 WHERE id = $1',
      [id]
    );
  },

  async cancelPendingForLead(lead_id) {
    const res = await pool.query(
      `UPDATE messages SET status = 'cancelled' 
       WHERE lead_id = $1 AND status = 'pending' RETURNING id`,
      [lead_id]
    );
    return res.rows.length;
  },

  async forLead(lead_id) {
    const res = await pool.query(
      'SELECT * FROM messages WHERE lead_id = $1 ORDER BY created_at ASC',
      [lead_id]
    );
    return res.rows;
  },
};

// ─── Replies ──────────────────────────────────────────────────────────────────

const Replies = {
  async create(data) {
    const { lead_id, channel, from_address, body, raw_payload } = data;
    const res = await pool.query(
      `INSERT INTO replies (lead_id, channel, from_address, body, raw_payload)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [lead_id, channel, from_address, body, JSON.stringify(raw_payload)]
    );
    return res.rows[0];
  },

  async forLead(lead_id) {
    const res = await pool.query(
      'SELECT * FROM replies WHERE lead_id = $1 ORDER BY received_at ASC',
      [lead_id]
    );
    return res.rows;
  },
};

// ─── Activity ─────────────────────────────────────────────────────────────────

const Activity = {
  async log(action, lead_id = null, details = {}) {
    const res = await pool.query(
      'INSERT INTO activity (lead_id, action, details) VALUES ($1,$2,$3) RETURNING *',
      [lead_id, action, JSON.stringify(details)]
    );
    return res.rows[0];
  },

  async recent(limit = 50) {
    const res = await pool.query(
      `SELECT a.*, l.business_name 
       FROM activity a
       LEFT JOIN leads l ON l.id = a.lead_id
       ORDER BY a.created_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows;
  },

  async forLead(lead_id) {
    const res = await pool.query(
      'SELECT * FROM activity WHERE lead_id = $1 ORDER BY created_at DESC',
      [lead_id]
    );
    return res.rows;
  },
};

// ─── Scan Runs ────────────────────────────────────────────────────────────────

const ScanRuns = {
  async create(areas, categories) {
    const res = await pool.query(
      `INSERT INTO scan_runs (areas_scanned, categories_scanned)
       VALUES ($1, $2) RETURNING *`,
      [JSON.stringify(areas), JSON.stringify(categories)]
    );
    return res.rows[0];
  },

  async complete(id, stats) {
    const res = await pool.query(
      `UPDATE scan_runs SET status = 'completed', completed_at = NOW(),
       leads_found = $2, leads_new = $3, leads_skipped = $4
       WHERE id = $1 RETURNING *`,
      [id, stats.found, stats.new_leads, stats.skipped]
    );
    return res.rows[0];
  },

  async fail(id, error_text) {
    const res = await pool.query(
      `UPDATE scan_runs SET status = 'failed', completed_at = NOW(), error_text = $2
       WHERE id = $1 RETURNING *`,
      [id, error_text]
    );
    return res.rows[0];
  },

  async list(limit = 20) {
    const res = await pool.query(
      'SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT $1',
      [limit]
    );
    return res.rows;
  },

  async latest() {
    const res = await pool.query(
      'SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 1'
    );
    return res.rows[0] || null;
  },
};

module.exports = { pool, Settings, Leads, Messages, Replies, Activity, ScanRuns };
