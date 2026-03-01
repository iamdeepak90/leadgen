'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Settings table - stores ALL configuration
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Insert defaults (won't overwrite existing)
    const defaults = [
      ['google_places_key', ''],
      ['hostinger_smtp_host', 'smtp.hostinger.com'],
      ['hostinger_smtp_port', '465'],
      ['hostinger_smtp_user', ''],
      ['hostinger_smtp_pass', ''],
      ['twilio_enabled', 'true'],
      ['twilio_whatsapp_from', ''],
      ['openrouter_key', ''],
      ['twilio_sid', ''],
      ['twilio_token', ''],
      ['twilio_from_number', ''],
      ['slack_webhook_url', ''],
      ['from_email', ''],
      ['from_name', 'LeadGen System'],
      ['briefing_email', ''],
      ['scan_areas', JSON.stringify(['Chennai, India'])],
      ['scan_categories', JSON.stringify(['restaurant', 'salon', 'gym', 'clinic', 'shop'])],
      ['scan_max_results', '20'],
      ['scan_only_new', 'true'],
      ['scan_time', '02:00'],
      ['pitch_time', '09:00'],
      ['pitch_batch_size', '50'],
      ['followup_1_days', '3'],
      ['followup_2_days', '5'],
      ['followup_3_days', '7'],
      ['openrouter_model', 'anthropic/claude-sonnet-4-5'],
      ['max_tokens', '1000'],
      ['scan_delay_ms', '500'],
      ['pitch_delay_ms', '2000'],
      ['auto_scan_enabled', 'true'],
      ['auto_pitch_enabled', 'true'],
      ['auto_followup_enabled', 'true'],
      ['briefing_enabled', 'true'],
      ['email_system_prompt', `You are an expert sales copywriter specializing in helping local businesses establish their online presence. You write compelling, personalized outreach emails that feel handwritten, not templated. Your emails are warm, professional, and reference specific details about the business to show genuine research.`],
      ['email_user_instructions', `Write a 150-200 word email pitch for the business below. Reference their specific GMB data (rating, review count, whether they have photos). Point out that they are missing a website and losing potential customers. Offer a professional website solution. Be specific, warm, and end with a clear soft call-to-action. Do NOT use generic phrases like "I hope this email finds you well".`],
      ['whatsapp_system_prompt', `You are a concise, friendly sales professional reaching out to local business owners via WhatsApp/SMS. Your messages are brief, personal, and conversational - never salesy or spammy.`],
      ['whatsapp_user_instructions', `Write a max 75-word WhatsApp/SMS message for the business below. Reference one specific detail (their rating or reviews). Mention they are missing a website. Keep it conversational and end with a simple question to invite a reply. No formal greetings, no emojis overload.`],
      ['followup1_system_prompt', `You are a friendly sales professional sending a gentle follow-up. You are not pushy. You simply want to check if your message was received.`],
      ['followup1_user_instructions', `Write a 60-80 word friendly follow-up email (this is follow-up #1, Day 3). Reference the initial pitch briefly. Zero pressure. Ask if they had a chance to see your previous message. Keep it light and human.`],
      ['followup2_system_prompt', `You are a sales professional using social proof to re-engage a prospect. You have a new angle - competitors in their area who now have websites and are getting more customers.`],
      ['followup2_user_instructions', `Write a 80-100 word follow-up email (this is follow-up #2, Day 5). Use a different angle than the first email - focus on competitor social proof. Mention that other businesses in their category and city are gaining customers online. Create gentle urgency without being pushy.`],
      ['followup3_system_prompt', `You are a sales professional sending a final, graceful follow-up. You respect the prospect's time and are offering a special bonus before closing out.`],
      ['followup3_user_instructions', `Write a 60-80 word final follow-up email (this is follow-up #3, Day 7). Keep it very short. Mention this is your last message. Offer a small bonus (e.g., free logo or free SEO setup). Give a graceful exit. Leave the door open but don't beg.`],
    ];

    for (const [key, value] of defaults) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }

    // Leads table
    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        place_id TEXT UNIQUE NOT NULL,
        business_name TEXT NOT NULL,
        category TEXT,
        location TEXT,
        address TEXT,
        phone TEXT,
        email TEXT,
        gmb_url TEXT,
        rating NUMERIC(2,1),
        review_count INTEGER DEFAULT 0,
        has_photos BOOLEAN DEFAULT FALSE,
        opening_hours JSONB,
        website_url TEXT,
        website_status TEXT CHECK (website_status IN ('none', 'dead', 'parked')),
        raw_gmb_data JSONB,
        status TEXT DEFAULT 'new' CHECK (status IN ('new', 'pitched', 'followed_up_1', 'followed_up_2', 'followed_up_3', 'replied', 'archived', 'converted')),
        notes TEXT,
        revenue NUMERIC(10,2),
        converted_at TIMESTAMPTZ,
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        message_type TEXT CHECK (message_type IN ('pitch', 'followup_1', 'followup_2', 'followup_3')),
        channel TEXT CHECK (channel IN ('email', 'whatsapp', 'sms')),
        subject TEXT,
        body TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
        sent_at TIMESTAMPTZ,
        error_text TEXT,
        retry_count INTEGER DEFAULT 0,
        scheduled_for TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Replies table
    await client.query(`
      CREATE TABLE IF NOT EXISTS replies (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        channel TEXT CHECK (channel IN ('email', 'whatsapp', 'sms')),
        from_address TEXT,
        body TEXT,
        raw_payload JSONB,
        received_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Activity table - audit log
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        details JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Scan runs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS scan_runs (
        id SERIAL PRIMARY KEY,
        status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
        areas_scanned JSONB,
        categories_scanned JSONB,
        leads_found INTEGER DEFAULT 0,
        leads_new INTEGER DEFAULT 0,
        leads_skipped INTEGER DEFAULT 0,
        error_text TEXT,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);

    // Indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_place_id ON leads(place_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_activity_lead_id ON activity(lead_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at DESC)`);

    await client.query('COMMIT');
    console.log('✅ Migration completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(() => process.exit(1));