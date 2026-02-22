'use strict';

/**
 * SEED SCRIPT — Inserts dummy leads for testing
 * Run: node src/db/seed.js
 *
 * This bypasses Google Places entirely and inserts fake businesses
 * so you can test: pitch generation → email/WhatsApp send → follow-ups → replies
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DUMMY_LEADS = [
  {
    place_id: 'test_place_001',
    business_name: 'Sri Murugan Mess',
    category: 'restaurant',
    location: 'Chennai, India',
    address: '14, Anna Salai, Triplicane, Chennai, Tamil Nadu 600005',
    phone: '+919810717027',
    email: null,
    gmb_url: 'https://maps.google.com/?cid=123456789',
    rating: 4.2,
    review_count: 312,
    has_photos: true,
    opening_hours: ['Monday: 6:00 AM – 10:00 PM', 'Tuesday: 6:00 AM – 10:00 PM', 'Wednesday: 6:00 AM – 10:00 PM'],
    website_url: null,
    website_status: 'none',
    raw_gmb_data: {
      name: 'Sri Murugan Mess',
      formatted_address: '14, Anna Salai, Triplicane, Chennai, Tamil Nadu 600005',
      formatted_phone_number: '+91 98765 43210',
      rating: 4.2,
      user_ratings_total: 312,
      types: ['restaurant', 'food', 'point_of_interest'],
      opening_hours: {
        weekday_text: ['Monday: 6:00 AM – 10:00 PM', 'Tuesday: 6:00 AM – 10:00 PM']
      }
    }
  },
  {
    place_id: 'test_place_002',
    business_name: 'Glamour Touch Beauty Salon',
    category: 'salon',
    location: 'Chennai, India',
    address: '7B, T Nagar, Chennai, Tamil Nadu 600017',
    phone: '+917217668980',
    email: null,
    gmb_url: 'https://maps.google.com/?cid=987654321',
    rating: 4.5,
    review_count: 89,
    has_photos: false,
    opening_hours: ['Monday: 10:00 AM – 8:00 PM', 'Sunday: 11:00 AM – 6:00 PM'],
    website_url: 'http://glamourtouch.com',
    website_status: 'dead',
    raw_gmb_data: {
      name: 'Glamour Touch Beauty Salon',
      formatted_phone_number: '+91 98456 78901',
      rating: 4.5,
      user_ratings_total: 89,
      types: ['beauty_salon', 'point_of_interest']
    }
  },
  {
    place_id: 'test_place_003',
    business_name: 'FitZone Gym & Fitness',
    category: 'gym',
    location: 'Chennai, India',
    address: '22, Velachery Main Road, Chennai, Tamil Nadu 600042',
    phone: '+919810717027',
    email: 'deepak.win8@gmail.com',
    gmb_url: 'https://maps.google.com/?cid=111222333',
    rating: 3.8,
    review_count: 156,
    has_photos: true,
    opening_hours: ['Monday: 5:00 AM – 11:00 PM', 'Sunday: 6:00 AM – 10:00 PM'],
    website_url: 'http://fitzonegym.in',
    website_status: 'parked',
    raw_gmb_data: {
      name: 'FitZone Gym & Fitness',
      formatted_phone_number: '+91 99234 56789',
      rating: 3.8,
      user_ratings_total: 156,
      types: ['gym', 'health', 'point_of_interest']
    }
  },
  {
    place_id: 'test_place_004',
    business_name: 'Dr. Priya\'s Dental Clinic',
    category: 'clinic',
    location: 'Bangalore, India',
    address: '55, MG Road, Bangalore, Karnataka 560001',
    phone: '+919810717027',
    email: 'whatseotools@gmail.com',
    gmb_url: 'https://maps.google.com/?cid=444555666',
    rating: 4.8,
    review_count: 423,
    has_photos: true,
    opening_hours: ['Monday: 9:00 AM – 7:00 PM', 'Saturday: 9:00 AM – 4:00 PM', 'Sunday: Closed'],
    website_url: null,
    website_status: 'none',
    raw_gmb_data: {
      name: 'Dr. Priya\'s Dental Clinic',
      formatted_phone_number: '+91 88123 45678',
      rating: 4.8,
      user_ratings_total: 423,
      types: ['dentist', 'health', 'point_of_interest']
    }
  },
  {
    place_id: 'test_place_005',
    business_name: 'Ravi General Store',
    category: 'shop',
    location: 'Chennai, India',
    address: '3, Gandhi Street, Adyar, Chennai, Tamil Nadu 600020',
    phone: '+919810717027',
    email: 't20wcnews@gmail.com',
    gmb_url: 'https://maps.google.com/?cid=777888999',
    rating: 4.0,
    review_count: 47,
    has_photos: false,
    opening_hours: ['Monday: 8:00 AM – 9:00 PM', 'Sunday: 9:00 AM – 7:00 PM'],
    website_url: 'http://ravigeneralstore.com',
    website_status: 'dead',
    raw_gmb_data: {
      name: 'Ravi General Store',
      formatted_phone_number: '+91 97345 67890',
      rating: 4.0,
      user_ratings_total: 47,
      types: ['store', 'point_of_interest']
    }
  },
  {
    place_id: 'test_place_006',
    business_name: 'Spice Garden Restaurant',
    category: 'restaurant',
    location: 'Bangalore, India',
    address: '18, Indiranagar 100 Feet Road, Bangalore, Karnataka 560038',
    phone: '+919810717027',
    email: 'deepak.win8@gmail.com',
    gmb_url: 'https://maps.google.com/?cid=112233445',
    rating: 4.3,
    review_count: 678,
    has_photos: true,
    opening_hours: ['Monday: 11:00 AM – 11:00 PM', 'Sunday: 11:00 AM – 11:00 PM'],
    website_url: 'http://spicegardenrestaurant.net',
    website_status: 'parked',
    raw_gmb_data: {
      name: 'Spice Garden Restaurant',
      formatted_phone_number: '+91 77567 89012',
      rating: 4.3,
      user_ratings_total: 678,
      types: ['restaurant', 'food', 'point_of_interest']
    }
  },
  {
    place_id: 'test_place_007',
    business_name: 'Sunshine Nursery & Flowers',
    category: 'shop',
    location: 'Chennai, India',
    address: '9, ECR Road, Thiruvanmiyur, Chennai, Tamil Nadu 600041',
    phone: '+919810717027',
    email: null,
    gmb_url: 'https://maps.google.com/?cid=556677889',
    rating: 4.6,
    review_count: 34,
    has_photos: true,
    opening_hours: ['Monday: 7:00 AM – 8:00 PM'],
    website_url: null,
    website_status: 'none',
    raw_gmb_data: {
      name: 'Sunshine Nursery & Flowers',
      formatted_phone_number: '+91 96123 45678',
      rating: 4.6,
      user_ratings_total: 34,
      types: ['florist', 'store', 'point_of_interest']
    }
  },
  {
    place_id: 'test_place_008',
    business_name: 'Kumar Tailors',
    category: 'shop',
    location: 'Chennai, India',
    address: '77, Usman Road, T Nagar, Chennai, Tamil Nadu 600017',
    phone: '+919810717027',
    email: null,
    gmb_url: 'https://maps.google.com/?cid=998877665',
    rating: null,
    review_count: 0,
    has_photos: false,
    opening_hours: [],
    website_url: null,
    website_status: 'none',
    raw_gmb_data: {
      name: 'Kumar Tailors',
      formatted_phone_number: '+91 95001 23456',
      types: ['clothing_store', 'point_of_interest']
    }
  }
];

async function seed() {
  const client = await pool.connect();
  try {
    console.log('🌱 Starting seed...\n');

    let inserted = 0;
    let skipped = 0;

    for (const lead of DUMMY_LEADS) {
      // Check if already exists
      const existing = await client.query(
        'SELECT id FROM leads WHERE place_id = $1', [lead.place_id]
      );

      if (existing.rows.length > 0) {
        console.log(`⏭  Skipped (already exists): ${lead.business_name}`);
        skipped++;
        continue;
      }

      const res = await client.query(
        `INSERT INTO leads
           (place_id, business_name, category, location, address, phone, email,
            gmb_url, rating, review_count, has_photos, opening_hours,
            website_url, website_status, raw_gmb_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          lead.place_id, lead.business_name, lead.category, lead.location,
          lead.address, lead.phone, lead.email, lead.gmb_url,
          lead.rating, lead.review_count, lead.has_photos,
          JSON.stringify(lead.opening_hours), lead.website_url,
          lead.website_status, JSON.stringify(lead.raw_gmb_data)
        ]
      );

      // Log activity
      await client.query(
        `INSERT INTO activity (lead_id, action, details)
         VALUES ($1, 'lead_found', $2)`,
        [res.rows[0].id, JSON.stringify({ source: 'seed_script', website_status: lead.website_status })]
      );

      const icon = lead.website_status === 'none' ? '🚫' :
                   lead.website_status === 'dead' ? '💀' : '🅿';

      console.log(`✅ ${icon} Inserted: ${lead.business_name} (${lead.website_status}) — ${lead.category} in ${lead.location}`);
      inserted++;
    }

    console.log(`\n✨ Done! Inserted: ${inserted} | Skipped: ${skipped}`);
    console.log('\n📋 What to test next:');
    console.log('   1. Open admin → Dashboard (should show leads)');
    console.log('   2. Go to Leads page → filter by status/website type');
    console.log('   3. Click a lead → click "Pitch Now" (needs OpenRouter key in Settings)');
    console.log('   4. Or go to Settings → add a real OpenRouter key → hit "Pitch Batch"');
    console.log('   5. Check Activity page to see everything logged');
    console.log('\n🔑 Leads with email (can test email sending):');
    DUMMY_LEADS.filter(l => l.email).forEach(l =>
      console.log(`   - ${l.business_name}: ${l.email}`)
    );

  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(() => process.exit(1));