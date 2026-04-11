/**
 * Job search service — Adzuna API + ATS portal scanning for Australian job listings.
 * Used by Riley's job_scan, job_evaluate, and job_tracker tools.
 */
import https from 'https';
import pool from '../db/pool';

// ── Types ──────────────────────────────────────────────────────────

export interface JobListing {
  id?: number;
  source: string;
  external_id?: string;
  title: string;
  company: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
  url: string;
  description?: string;
  score?: number;
  evaluation?: string;
  status?: string;
  discord_msg_id?: string;
  scanned_at?: string;
}

interface AdzunaJob {
  id: string;
  title: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  salary_min?: number;
  salary_max?: number;
  redirect_url?: string;
  description?: string;
  created?: string;
}

interface AdzunaResponse {
  results?: AdzunaJob[];
  count?: number;
}

// ── Adzuna API ─────────────────────────────────────────────────────

function adzunaFetch(path: string): Promise<string> {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) {
    return Promise.resolve(JSON.stringify({ error: 'ADZUNA_APP_ID or ADZUNA_APP_KEY not configured' }));
  }

  const separator = path.includes('?') ? '&' : '?';
  const url = `https://api.adzuna.com/v1/api/jobs/au/${path}${separator}app_id=${appId}&app_key=${appKey}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15_000, headers: { Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Adzuna API HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Adzuna API timeout')); });
  });
}

// ── ATS API parsers (Greenhouse, Ashby, Lever) ─────────────────────

function atsFetch(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.get({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      timeout: 15_000,
      headers: { Accept: 'application/json', 'User-Agent': 'ASAP-Agent/1.0' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`ATS API HTTP ${res.statusCode}`));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ATS API timeout')); });
  });
}

function parseGreenhouse(json: any, companyName: string): JobListing[] {
  const jobs = json.jobs || [];
  return jobs.map((j: any) => ({
    source: 'greenhouse',
    external_id: String(j.id || ''),
    title: j.title || '',
    company: companyName,
    location: j.location?.name || '',
    url: j.absolute_url || '',
  }));
}

function parseAshby(json: any, companyName: string): JobListing[] {
  const jobs = json.jobs || [];
  return jobs.map((j: any) => ({
    source: 'ashby',
    external_id: String(j.id || ''),
    title: j.title || '',
    company: companyName,
    location: j.location || '',
    url: j.jobUrl || '',
  }));
}

function parseLever(json: any, companyName: string): JobListing[] {
  if (!Array.isArray(json)) return [];
  return json.map((j: any) => ({
    source: 'lever',
    external_id: String(j.id || ''),
    title: j.text || '',
    company: companyName,
    location: j.categories?.location || '',
    url: j.hostedUrl || '',
  }));
}

// ── Dedup ──────────────────────────────────────────────────────────

async function getSeenUrls(): Promise<Set<string>> {
  const res = await pool.query('SELECT url FROM job_scan_history');
  return new Set(res.rows.map((r: { url: string }) => r.url));
}

async function markSeen(listings: JobListing[]): Promise<void> {
  if (listings.length === 0) return;
  const values: string[] = [];
  const params: string[] = [];
  let i = 1;
  for (const l of listings) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(l.url, l.source, l.company, l.title);
  }
  await pool.query(
    `INSERT INTO job_scan_history (url, source, company, title) VALUES ${values.join(',')} ON CONFLICT (url) DO NOTHING`,
    params
  );
}

// ── Title filtering ────────────────────────────────────────────────

async function getTitleFilter(): Promise<{ positive: string[]; negative: string[] }> {
  const res = await pool.query('SELECT keywords_pos, keywords_neg FROM job_profile WHERE user_id = $1', ['owner']);
  if (res.rows.length === 0) return { positive: [], negative: [] };
  return {
    positive: res.rows[0].keywords_pos || [],
    negative: res.rows[0].keywords_neg || [],
  };
}

function matchesTitleFilter(title: string, filter: { positive: string[]; negative: string[] }): boolean {
  const lower = title.toLowerCase();
  const hasPositive = filter.positive.length === 0 || filter.positive.some((k) => lower.includes(k.toLowerCase()));
  const hasNegative = filter.negative.some((k) => lower.includes(k.toLowerCase()));
  return hasPositive && !hasNegative;
}

// ── Location filtering ─────────────────────────────────────────────

function isAustralianLocation(location: string | undefined): boolean {
  if (!location) return true; // unknown = allow
  const lower = location.toLowerCase();
  const auKeywords = ['australia', 'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide',
    'nsw', 'new south wales', 'vic', 'victoria', 'qld', 'queensland',
    'wa', 'western australia', 'sa', 'south australia', 'tas', 'tasmania',
    'act', 'canberra', 'nt', 'northern territory', 'remote'];
  return auKeywords.some((k) => lower.includes(k));
}

// ── Public API ─────────────────────────────────────────────────────

export async function scanAdzuna(keywords?: string): Promise<{ listings: JobListing[]; skipped: number; total: number }> {
  const profile = await pool.query('SELECT target_roles, location, salary_min FROM job_profile WHERE user_id = $1', ['owner']);
  const roles: string[] = keywords
    ? [keywords]
    : (profile.rows[0]?.target_roles || []).length > 0
      ? profile.rows[0].target_roles
      : ['software engineer'];
  const where = profile.rows[0]?.location || 'New South Wales';
  const salaryMin = profile.rows[0]?.salary_min;

  const seenUrls = await getSeenUrls();
  const titleFilter = await getTitleFilter();
  const listings: JobListing[] = [];
  const seenInBatch = new Set<string>();
  let skipped = 0;
  let totalApi = 0;

  // Search each role separately (Adzuna doesn't handle long OR queries well)
  for (const role of roles.slice(0, 5)) {
    let path = `search/1?results_per_page=20&what=${encodeURIComponent(role)}&where=${encodeURIComponent(where)}&sort_by=date&content-type=application/json`;
    if (salaryMin) path += `&salary_min=${salaryMin}`;

    try {
      const raw = await adzunaFetch(path);
      const data: AdzunaResponse = JSON.parse(raw);
      totalApi += data.count || 0;

      for (const job of data.results || []) {
        const url = job.redirect_url || '';
        if (!url || seenUrls.has(url) || seenInBatch.has(url)) { skipped++; continue; }
        if (!matchesTitleFilter(job.title || '', titleFilter)) { skipped++; continue; }

        seenInBatch.add(url);
        listings.push({
          source: 'adzuna',
          external_id: String(job.id || ''),
          title: job.title || '',
          company: job.company?.display_name || 'Unknown',
          location: job.location?.display_name || '',
          salary_min: job.salary_min,
          salary_max: job.salary_max,
          url,
          description: job.description || '',
        });
      }
    } catch {
      // Skip failed role search, continue with others
    }
  }

  // Persist
  if (listings.length > 0) {
    await insertListings(listings);
    await markSeen(listings);
  }

  return { listings, skipped, total: totalApi };
}

export async function scanPortals(): Promise<{ listings: JobListing[]; errors: string[] }> {
  const portals = await pool.query('SELECT company_name, careers_url, api_type, api_url FROM job_portals WHERE enabled = TRUE');
  const seenUrls = await getSeenUrls();
  const titleFilter = await getTitleFilter();
  const allListings: JobListing[] = [];
  const errors: string[] = [];

  for (const portal of portals.rows) {
    try {
      let raw: string;
      let parsed: JobListing[];

      if (portal.api_type === 'greenhouse' && portal.api_url) {
        raw = await atsFetch(portal.api_url);
        parsed = parseGreenhouse(JSON.parse(raw), portal.company_name);
      } else if (portal.api_type === 'ashby' && portal.api_url) {
        raw = await atsFetch(portal.api_url);
        parsed = parseAshby(JSON.parse(raw), portal.company_name);
      } else if (portal.api_type === 'lever' && portal.api_url) {
        raw = await atsFetch(portal.api_url);
        parsed = parseLever(JSON.parse(raw), portal.company_name);
      } else {
        continue;
      }

      for (const listing of parsed) {
        if (!listing.url || seenUrls.has(listing.url)) continue;
        if (!matchesTitleFilter(listing.title, titleFilter)) continue;
        if (!isAustralianLocation(listing.location)) continue;
        allListings.push(listing);
      }
    } catch (err) {
      errors.push(`${portal.company_name}: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  }

  if (allListings.length > 0) {
    await insertListings(allListings);
    await markSeen(allListings);
  }

  return { listings: allListings, errors };
}

async function insertListings(listings: JobListing[]): Promise<void> {
  for (const l of listings) {
    await pool.query(
      `INSERT INTO job_listings (source, external_id, title, company, location, salary_min, salary_max, url, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'scanned')
       ON CONFLICT (url) DO NOTHING`,
      [l.source, l.external_id || null, l.title, l.company, l.location || null,
       l.salary_min || null, l.salary_max || null, l.url, l.description || null]
    );
  }
}

export async function getListingsByStatus(status: string, limit = 20): Promise<JobListing[]> {
  const res = await pool.query(
    'SELECT * FROM job_listings WHERE status = $1 ORDER BY scanned_at DESC LIMIT $2',
    [status, limit]
  );
  return res.rows;
}

export async function updateListingStatus(listingId: number, status: string): Promise<void> {
  await pool.query(
    'UPDATE job_listings SET status = $1, updated_at = NOW() WHERE id = $2',
    [status, listingId]
  );
}

export async function updateListingByMsgId(discordMsgId: string, status: string): Promise<JobListing | null> {
  const res = await pool.query(
    'UPDATE job_listings SET status = $1, updated_at = NOW() WHERE discord_msg_id = $2 RETURNING *',
    [status, discordMsgId]
  );
  return res.rows[0] || null;
}

export async function setListingDiscordMsg(listingId: number, msgId: string): Promise<void> {
  await pool.query(
    'UPDATE job_listings SET discord_msg_id = $1 WHERE id = $2',
    [msgId, listingId]
  );
}

export async function updateListingScore(listingId: number, score: number, evaluation: string): Promise<void> {
  await pool.query(
    'UPDATE job_listings SET score = $1, evaluation = $2, status = $3, evaluated_at = NOW(), updated_at = NOW() WHERE id = $4',
    [score, evaluation, 'evaluated', listingId]
  );
}

export async function getTrackerSummary(): Promise<Record<string, number>> {
  const res = await pool.query('SELECT status, COUNT(*)::int AS count FROM job_listings GROUP BY status');
  const summary: Record<string, number> = {};
  for (const row of res.rows) {
    summary[row.status] = row.count;
  }
  return summary;
}

export async function getProfile(): Promise<any> {
  const res = await pool.query('SELECT * FROM job_profile WHERE user_id = $1', ['owner']);
  return res.rows[0] || null;
}

export async function upsertProfile(fields: Record<string, any>): Promise<void> {
  const existing = await getProfile();
  if (existing) {
    const sets: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = $${i++}`);
      params.push(value);
    }
    sets.push(`updated_at = NOW()`);
    params.push('owner');
    await pool.query(
      `UPDATE job_profile SET ${sets.join(', ')} WHERE user_id = $${i}`,
      params
    );
  } else {
    const keys = ['user_id', ...Object.keys(fields)];
    const values = ['owner', ...Object.values(fields)];
    const placeholders = values.map((_, idx) => `$${idx + 1}`);
    await pool.query(
      `INSERT INTO job_profile (${keys.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    );
  }
}

export async function seedDefaultPortals(): Promise<number> {
  const portals = [
    { name: 'Canva', url: 'https://www.canva.com/careers/', api_type: 'greenhouse', api_url: 'https://boards-api.greenhouse.io/v1/boards/canva/jobs' },
    { name: 'Atlassian', url: 'https://jobs.lever.co/atlassian', api_type: 'lever', api_url: 'https://api.lever.co/v0/postings/atlassian' },
    { name: 'SafetyCulture', url: 'https://safetyculture.com/careers/', api_type: 'greenhouse', api_url: 'https://boards-api.greenhouse.io/v1/boards/safetyculture/jobs' },
    { name: 'Culture Amp', url: 'https://www.cultureamp.com/careers', api_type: 'greenhouse', api_url: 'https://boards-api.greenhouse.io/v1/boards/cultureamp/jobs' },
    { name: 'Buildkite', url: 'https://buildkite.com/careers', api_type: 'greenhouse', api_url: 'https://boards-api.greenhouse.io/v1/boards/buildkite/jobs' },
    { name: 'Rokt', url: 'https://jobs.lever.co/rokt', api_type: 'lever', api_url: 'https://api.lever.co/v0/postings/rokt' },
    { name: 'Harrison.ai', url: 'https://jobs.lever.co/harrison-ai', api_type: 'lever', api_url: 'https://api.lever.co/v0/postings/harrison-ai' },
    { name: 'Deputy', url: 'https://www.deputy.com/careers', api_type: 'greenhouse', api_url: 'https://boards-api.greenhouse.io/v1/boards/deputy/jobs' },
    { name: 'Immutable', url: 'https://jobs.lever.co/immutable', api_type: 'lever', api_url: 'https://api.lever.co/v0/postings/immutable' },
    { name: 'Employment Hero', url: 'https://employmenthero.com/careers/', api_type: 'greenhouse', api_url: 'https://boards-api.greenhouse.io/v1/boards/employmenthero/jobs' },
  ];

  let seeded = 0;
  for (const p of portals) {
    const res = await pool.query(
      `INSERT INTO job_portals (company_name, careers_url, api_type, api_url, enabled) VALUES ($1, $2, $3, $4, TRUE) ON CONFLICT (company_name) DO NOTHING RETURNING id`,
      [p.name, p.url, p.api_type, p.api_url]
    );
    if (res.rowCount && res.rowCount > 0) seeded++;
  }
  return seeded;
}
