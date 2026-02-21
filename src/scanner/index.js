'use strict';

const axios = require('axios');
const { getSettings } = require('../config');
const { Leads, ScanRuns, Activity } = require('../db');
const logger = require('../utils/logger');

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

async function checkWebsite(url) {
  if (!url) return 'none';

  try {
    const cleanUrl = url.startsWith('http') ? url : `https://${url}`;
    const response = await axios.get(cleanUrl, {
      timeout: 8000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadGenBot/1.0)' },
      validateStatus: () => true,
    });

    // Dead: server errors or common dead-site codes
    if (response.status >= 400 || response.status === 0) {
      return 'dead';
    }

    // Parked: check body for parking patterns
    const body = typeof response.data === 'string' ? response.data : '';
    for (const pattern of PARKED_PATTERNS) {
      if (pattern.test(body)) return 'parked';
    }

    // Check for redirect to parking services in final URL
    const finalUrl = response.request?.res?.responseUrl || '';
    const parkingDomains = ['sedoparking', 'godaddy', 'namecheap', 'dan.com', 'afternic'];
    for (const d of parkingDomains) {
      if (finalUrl.includes(d)) return 'parked';
    }

    return null; // website is alive and real
  } catch (err) {
    // Connection refused, timeout, DNS failure = dead
    if (
      err.code === 'ECONNREFUSED' ||
      err.code === 'ENOTFOUND' ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'ECONNRESET' ||
      err.message?.includes('timeout')
    ) {
      return 'dead';
    }
    return 'dead';
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getPlaceDetails(placeId, apiKey) {
  const fields = [
    'place_id', 'name', 'formatted_address', 'formatted_phone_number',
    'website', 'rating', 'user_ratings_total', 'photos', 'opening_hours',
    'types', 'url', 'business_status',
  ].join(',');

  const res = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
    params: { place_id: placeId, fields, key: apiKey },
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

    const res = await axios.get(
      'https://maps.googleapis.com/maps/api/place/textsearch/json',
      { params }
    );

    if (!['OK', 'ZERO_RESULTS'].includes(res.data.status)) {
      throw new Error(`Places search failed: ${res.data.status}`);
    }

    results.push(...(res.data.results || []));
    pageToken = res.data.next_page_token;

    if (pageToken) await sleep(2000); // Google requires delay before next page
  } while (pageToken && results.length < maxResults);

  return results.slice(0, maxResults);
}

async function runScan({ areas, categories, maxResults, scanOnlyNew, delay }) {
  const settings = getSettings();
  const apiKey = settings.google_places_key;

  if (!apiKey) throw new Error('Google Places API key not configured');

  const scanAreas = areas || settings.scan_areas || [];
  const scanCats = categories || settings.scan_categories || [];
  const max = maxResults || settings.scan_max_results || 20;
  const onlyNew = scanOnlyNew !== undefined ? scanOnlyNew : settings.scan_only_new;
  const scanDelay = delay || settings.scan_delay_ms || 500;

  const scanRun = await ScanRuns.create(scanAreas, scanCats);
  let totalFound = 0;
  let totalNew = 0;
  let totalSkipped = 0;

  logger.info('Scan started', { runId: scanRun.id, areas: scanAreas, categories: scanCats });

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

          // Skip if already in DB and onlyNew is enabled
          if (onlyNew) {
            const existing = await Leads.findByPlaceId(place.place_id);
            if (existing) {
              totalSkipped++;
              continue;
            }
          }

          await sleep(scanDelay);

          let details;
          try {
            details = await getPlaceDetails(place.place_id, apiKey);
          } catch (err) {
            logger.error('Detail fetch failed', { place_id: place.place_id, error: err.message });
            continue;
          }

          // Skip permanently closed businesses
          if (details.business_status === 'PERMANENTLY_CLOSED') continue;

          const websiteUrl = details.website || null;
          let websiteStatus = await checkWebsite(websiteUrl);

          // Only include leads with bad/no website
          if (websiteStatus === null) {
            totalSkipped++;
            logger.debug('Skipping - website alive', { name: details.name });
            continue;
          }

          const leadData = {
            place_id: details.place_id,
            business_name: details.name,
            category,
            location: area,
            address: details.formatted_address || '',
            phone: details.formatted_phone_number || null,
            email: null, // Google Places rarely has email
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
                category,
                location: area,
              });
              logger.info('New lead found', { name: details.name, website_status: websiteStatus });
            }
          } catch (err) {
            logger.error('Lead upsert failed', { name: details.name, error: err.message });
          }
        }
      }
    }

    await ScanRuns.complete(scanRun.id, {
      found: totalFound,
      new_leads: totalNew,
      skipped: totalSkipped,
    });

    logger.info('Scan completed', { found: totalFound, new: totalNew, skipped: totalSkipped });
    return { found: totalFound, new_leads: totalNew, skipped: totalSkipped };
  } catch (err) {
    await ScanRuns.fail(scanRun.id, err.message);
    logger.error('Scan failed', { error: err.message });
    throw err;
  }
}

module.exports = { runScan, checkWebsite };
