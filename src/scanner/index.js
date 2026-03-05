'use strict';

const axios = require('axios');
const { getSettings } = require('../config');
const { Leads, ScanRuns, Activity, Blacklist } = require('../db');
const logger = require('../utils/logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const PARKED_PATTERNS = [
  /this domain is for sale/i,
  /domain is parked/i,
  /godaddy\.com/i,
  /namecheap\.com.*parked/i,
  /sedoparking\.com/i,
  /hugedomains\.com/i,
  /dan\.com/i,
  /afternic\.com/i,
  /parking/i,
  /buy this domain/i,
  /domain for sale/i,
  /this page is under construction/i,
  /coming soon/i,
  /website coming soon/i,
  /under construction/i,
];

// Emails to ignore — false positives from web pages
const EMAIL_BLACKLIST = [
  /^.*\.(png|jpg|jpeg|gif|svg|webp|pdf|css|js)$/i, // file extensions
  /example\.com$/i,
  /sentry\.io$/i,
  /wix\.com$/i,
  /wordpress\.com$/i,
  /shopify\.com$/i,
  /squarespace\.com$/i,
  /amazonaws\.com$/i,
  /cloudflare\.com$/i,
  /google\.com$/i,
  /gmail\.com.*noreply/i,
  /noreply@/i,
  /no-reply@/i,
  /donotreply@/i,
  /support@wix/i,
  /privacy@/i,
  /legal@/i,
  /abuse@/i,
  /postmaster@/i,
];

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractEmailsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(EMAIL_REGEX) || [];
  return matches.filter(email => {
    const lower = email.toLowerCase();
    return !EMAIL_BLACKLIST.some(pattern => pattern.test(lower));
  });
}

function pickBestEmail(emails) {
  if (!emails.length) return null;

  // Priority order: info@, contact@, hello@, enquiry@, then anything else
  const priority = ['info@', 'contact@', 'hello@', 'enquiry@', 'enquiries@', 'mail@', 'sales@', 'admin@'];
  for (const prefix of priority) {
    const match = emails.find(e => e.toLowerCase().startsWith(prefix));
    if (match) return match.toLowerCase();
  }
  return emails[0].toLowerCase();
}

// ─── Website Check + Email Extraction ────────────────────────────────────────
// Returns { status: 'none'|'dead'|'parked'|null, email: string|null }
// status null = website is alive and real (skip this lead)

async function checkWebsiteAndExtractEmail(url) {
  if (!url) return { status: 'none', email: null };

  try {
    const cleanUrl = url.startsWith('http') ? url : `https://${url}`;
    const response = await axios.get(cleanUrl, {
      timeout: 10000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      validateStatus: () => true,
    });

    const body = typeof response.data === 'string' ? response.data : '';

    // Dead check
    if (response.status >= 400 || response.status === 0) {
      return { status: 'dead', email: null };
    }

    // Parked check
    for (const pattern of PARKED_PATTERNS) {
      if (pattern.test(body)) return { status: 'parked', email: null };
    }

    const finalUrl = response.request?.res?.responseUrl || '';
    const parkingDomains = ['sedoparking', 'godaddy', 'namecheap', 'dan.com', 'afternic'];
    for (const d of parkingDomains) {
      if (finalUrl.includes(d)) return { status: 'parked', email: null };
    }

    // Website is alive and real — skip this lead
    return { status: null, email: null };

  } catch (err) {
    return { status: 'dead', email: null };
  }
}

// ─── Email Scraper ────────────────────────────────────────────────────────────
// Tries website homepage + /contact + /about-us to find a business email

async function scrapeEmailFromWebsite(url) {
  if (!url) return null;

  const cleanUrl = url.startsWith('http') ? url.replace(/\/$/, '') : `https://${url.replace(/\/$/, '')}`;
  const pagesToTry = [cleanUrl, `${cleanUrl}/contact`, `${cleanUrl}/contact-us`, `${cleanUrl}/about`];

  for (const pageUrl of pagesToTry) {
    try {
      const response = await axios.get(pageUrl, {
        timeout: 8000,
        maxRedirects: 3,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        validateStatus: s => s < 400,
      });

      const body = typeof response.data === 'string' ? response.data : '';
      const emails = extractEmailsFromText(body);
      const best = pickBestEmail(emails);
      if (best) {
        logger.debug('Email found on website', { url: pageUrl, email: best });
        return best;
      }
    } catch (_) {
      // page not found or timeout — try next
    }
  }
  return null;
}

// ─── Google Maps Listing Scraper ──────────────────────────────────────────────
// As a last resort for businesses with no website, try scraping their GMB URL
// Note: Google heavily protects this — success rate is low but worth trying

async function scrapeEmailFromGMB(gmbUrl) {
  if (!gmbUrl) return null;
  try {
    const response = await axios.get(gmbUrl, {
      timeout: 10000,
      maxRedirects: 3,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      validateStatus: s => s < 400,
    });
    const body = typeof response.data === 'string' ? response.data : '';
    const emails = extractEmailsFromText(body);
    return pickBestEmail(emails);
  } catch (_) {
    return null;
  }
}

// ─── Google Places API ────────────────────────────────────────────────────────

async function getPlaceDetails(placeId, apiKey) {
  const fields = [
    'place_id', 'name', 'formatted_address', 'formatted_phone_number',
    'website', 'rating', 'user_ratings_total', 'photos', 'opening_hours',
    'types', 'url', 'business_status',
  ].join(',');

  const res = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
    params: { place_id: placeId, fields, key: apiKey },
    timeout: 10000,
  });

  if (res.data.status !== 'OK') {
    throw new Error(`Place details failed: ${res.data.status} for ${placeId}`);
  }
  return res.data.result;
}

async function searchPlaces(query, apiKey, maxResults = 20) {
  const results = [];
  let pageToken = null;

  do {
    const params = { query, key: apiKey };
    if (pageToken) params.pagetoken = pageToken;

    const res = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params,
      timeout: 10000,
    });

    if (!['OK', 'ZERO_RESULTS'].includes(res.data.status)) {
      throw new Error(`Places search failed: ${res.data.status}`);
    }

    results.push(...(res.data.results || []));
    pageToken = res.data.next_page_token;
    if (pageToken) await sleep(2000);
  } while (pageToken && results.length < maxResults);

  return results.slice(0, maxResults);
}

// ─── Main Scan ────────────────────────────────────────────────────────────────

async function runScan({ areas, categories, maxResults, scanOnlyNew, delay } = {}) {
  const settings = getSettings();
  const apiKey = settings.google_places_key;
  if (!apiKey) throw new Error('Google Places API key not configured');

  const scanAreas    = areas      || settings.scan_areas      || [];
  const scanCats     = categories || settings.scan_categories || [];
  const max          = parseInt(maxResults || settings.scan_max_results || 20);
  const onlyNew      = scanOnlyNew !== undefined ? scanOnlyNew : (settings.scan_only_new === 'true' || settings.scan_only_new === true);
  const scanDelay    = parseInt(delay || settings.scan_delay_ms || 500);
  const requireEmail = settings.scan_require_email === 'true' || settings.scan_require_email === true;

  const scanRun = await ScanRuns.create(scanAreas, scanCats);
  let totalFound = 0, totalNew = 0, totalSkipped = 0, totalNoEmail = 0;

  logger.info('Scan started', { runId: scanRun.id, areas: scanAreas, categories: scanCats, requireEmail });

  try {
    for (const area of scanAreas) {
      for (const category of scanCats) {
        const query = `${category} in ${area}`;
        logger.info('Scanning', { query });

        let places;
        try {
          places = await searchPlaces(query, apiKey, max);
        } catch (err) {
          logger.error('Search failed', { query, error: err.message });
          continue;
        }

        for (const place of places) {
          totalFound++;

          // Skip blacklisted places (manually deleted — never come back)
          if (await Blacklist.has(place.place_id)) {
            totalSkipped++;
            logger.debug('Skipping — place is blacklisted', { place_id: place.place_id });
            continue;
          }

          // Skip duplicates
          if (onlyNew) {
            const existing = await Leads.findByPlaceId(place.place_id);
            if (existing) { totalSkipped++; continue; }
          }

          await sleep(scanDelay);

          // Fetch full details from Google Places
          let details;
          try {
            details = await getPlaceDetails(place.place_id, apiKey);
          } catch (err) {
            logger.error('Detail fetch failed', { place_id: place.place_id, error: err.message });
            continue;
          }

          if (details.business_status === 'PERMANENTLY_CLOSED') {
            totalSkipped++;
            continue;
          }

          const websiteUrl = details.website || null;

          // ── Step 1: Check website status ──────────────────────────────────
          const { status: websiteStatus } = await checkWebsiteAndExtractEmail(websiteUrl);

          // Skip leads with a working website
          if (websiteStatus === null) {
            totalSkipped++;
            logger.debug('Skipping — website is alive', { name: details.name });
            continue;
          }

          // ── Step 2: Try to find email ─────────────────────────────────────
          let email = null;

          if (websiteUrl && websiteStatus !== 'none') {
            // Business had a website (dead or parked) — try scraping it for email
            email = await scrapeEmailFromWebsite(websiteUrl);
            if (email) logger.info('Email scraped from website', { name: details.name, email });
          }

          if (!email && details.url) {
            // No email from website — try the Google Maps listing page
            email = await scrapeEmailFromGMB(details.url);
            if (email) logger.info('Email scraped from GMB page', { name: details.name, email });
          }

          // ── Step 3: Apply require_email filter ────────────────────────────
          if (requireEmail && !email) {
            totalNoEmail++;
            logger.debug('Skipping — no email found and require_email is ON', { name: details.name });
            continue;
          }

          // ── Step 4: Save lead ─────────────────────────────────────────────
          const leadData = {
            place_id: details.place_id,
            business_name: details.name,
            category,
            location: area,
            address: details.formatted_address || '',
            phone: details.formatted_phone_number || null,
            email,
            gmb_url: details.url || null,
            rating: details.rating || null,
            review_count: details.user_ratings_total || 0,
            has_photos: !!(details.photos && details.photos.length > 0),
            opening_hours: details.opening_hours?.weekday_text || null,
            website_url: websiteUrl,
            website_status: websiteStatus,
            raw_gmb_data: details,
          };

          try {
            const lead = await Leads.upsert(leadData);
            if (lead.inserted) {
              totalNew++;
              await Activity.log('lead_found', lead.id, {
                website_status: websiteStatus,
                email_found: !!email,
                category,
                location: area,
              });
              logger.info('New lead saved', {
                name: details.name,
                website_status: websiteStatus,
                has_email: !!email,
              });
            }
          } catch (err) {
            logger.error('Lead upsert failed', { name: details.name, error: err.message });
          }
        }
      }
    }

    await ScanRuns.complete(scanRun.id, { found: totalFound, new_leads: totalNew, skipped: totalSkipped });

    logger.info('Scan completed', {
      found: totalFound,
      new: totalNew,
      skipped: totalSkipped,
      no_email_filtered: totalNoEmail,
    });

    return { found: totalFound, new_leads: totalNew, skipped: totalSkipped, no_email_filtered: totalNoEmail };

  } catch (err) {
    await ScanRuns.fail(scanRun.id, err.message);
    logger.error('Scan failed', { error: err.message });
    throw err;
  }
}

module.exports = { runScan, checkWebsite: checkWebsiteAndExtractEmail };