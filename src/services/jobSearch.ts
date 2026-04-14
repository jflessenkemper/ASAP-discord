/**
 * Job search service — Adzuna API + ATS portal scanning for Australian job listings.
 * Used by Riley's job_scan, job_evaluate, and job_tracker tools.
 */
import https from 'https';
import pool from '../db/pool';
import { errMsg } from '../utils/errors';

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
  cover_letter?: string;
  resume_text?: string;
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
      errors.push(`${portal.company_name}: ${errMsg(err)}`);
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

// ── Application Drafting & Submission ──────────────────────────────

export async function getListingById(id: number): Promise<JobListing | null> {
  const res = await pool.query('SELECT * FROM job_listings WHERE id = $1', [id]);
  return res.rows[0] || null;
}

export async function saveDraft(listingId: number, coverLetter: string, resumeText: string): Promise<void> {
  await pool.query(
    `UPDATE job_listings SET cover_letter = $1, resume_text = $2, status = 'drafted', updated_at = NOW() WHERE id = $3`,
    [coverLetter, resumeText, listingId]
  );
}

export async function getPortalByCompany(company: string): Promise<{ company_name: string; careers_url: string; api_type: string; api_url: string; board_api_key?: string } | null> {
  const res = await pool.query(
    'SELECT company_name, careers_url, api_type, api_url, board_api_key FROM job_portals WHERE company_name ILIKE $1 AND enabled = TRUE',
    [company]
  );
  return res.rows[0] || null;
}

/**
 * Draft a tailored cover letter and resume highlights for a listing using Gemini Flash.
 * Returns the drafted text and saves it to the DB.
 */
export async function draftApplication(listingId: number): Promise<{ coverLetter: string; resumeHighlights: string } | null> {
  const listing = await getListingById(listingId);
  if (!listing) return null;

  const profile = await getProfile();
  if (!profile) return null;

  const prompt = `You are an expert career coach drafting a job application for an Australian professional.

**Applicant Profile:**
- Name: ${profile.first_name || 'Jordan'} ${profile.last_name || 'Flessenkemper'}
- Phone: ${profile.phone || 'Not provided'}
- Email: ${profile.email || 'Not provided'}
- Target roles: ${(profile.target_roles || []).join(', ')}
- Location: ${profile.location || 'New South Wales'}
- Current/Recent: ${profile.cv_text ? profile.cv_text.slice(0, 2000) : 'DBA with 6+ years experience'}
- Deal-breakers: ${profile.deal_breakers || 'None specified'}

**Job Listing:**
- Title: ${listing.title}
- Company: ${listing.company}
- Location: ${listing.location || 'Not specified'}
- Salary: ${listing.salary_min ? `$${Math.round(listing.salary_min / 1000)}k–$${Math.round((listing.salary_max || listing.salary_min) / 1000)}k` : 'Not specified'}
- Description: ${(listing.description || 'No description available').slice(0, 3000)}

**Instructions:**
Write TWO sections separated by "---RESUME---":

1. **COVER LETTER** — A concise, professional cover letter (200-350 words). Highlight relevant experience from the profile that matches the job requirements. Be specific about skills and achievements. Australian tone — professional but not overly formal. Do NOT fabricate experience or qualifications. Include the applicant's phone number and email (if provided) in the sign-off.

2. **RESUME HIGHLIGHTS** — After the "---RESUME---" separator, write 5-8 bullet points highlighting the most relevant skills, experience, and qualifications from the applicant's profile that match this specific role. Each bullet should be a concrete, specific achievement or skill.

Output the cover letter text first, then "---RESUME---", then the resume highlights. No other formatting or headers.`;

  // Use Gemini Flash via the same pattern as other services
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('draftApplication: GEMINI_API_KEY not set');
    return null;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  const separatorIdx = text.indexOf('---RESUME---');
  let coverLetter: string;
  let resumeHighlights: string;

  if (separatorIdx !== -1) {
    coverLetter = text.slice(0, separatorIdx).trim();
    resumeHighlights = text.slice(separatorIdx + '---RESUME---'.length).trim();
  } else {
    // Fallback: treat entire response as cover letter
    coverLetter = text;
    resumeHighlights = '';
  }

  await saveDraft(listingId, coverLetter, resumeHighlights);
  return { coverLetter, resumeHighlights };
}

/**
 * Guess a company's careers/HR email from portal data or company name.
 * Extracts domain from careers_url, falls back to sanitised company name.
 */
export async function guessCompanyEmail(company: string): Promise<string> {
  const portal = await getPortalByCompany(company);
  if (portal?.careers_url) {
    try {
      const host = new URL(portal.careers_url).hostname.replace(/^www\./, '');
      return `careers@${host}`;
    } catch { /* fall through */ }
  }
  // Fallback: derive domain from company name
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `careers@${slug}.com`;
}

/**
 * Submit an application to a Greenhouse job board via their public API.
 * Requires a board_api_key configured on the portal.
 */
export async function submitToGreenhouse(
  listing: JobListing,
  profile: any,
  coverLetter: string,
  resumeText: string
): Promise<{ success: boolean; error?: string }> {
  const portal = await getPortalByCompany(listing.company);
  if (!portal || portal.api_type !== 'greenhouse' || !portal.board_api_key) {
    return { success: false, error: 'No Greenhouse API key configured for this company' };
  }

  // Extract board token from api_url: https://boards-api.greenhouse.io/v1/boards/{token}/jobs
  const boardMatch = portal.api_url.match(/\/boards\/([^/]+)\//);
  if (!boardMatch) return { success: false, error: 'Cannot extract board token from portal URL' };
  const boardToken = boardMatch[1];

  const firstName = profile.first_name || 'Jordan';
  const lastName = profile.last_name || 'Flessenkemper';
  const email = profile.email;
  if (!email) return { success: false, error: 'Email not set in profile — update profile with email before submitting' };

  const externalId = listing.external_id;
  if (!externalId) return { success: false, error: 'Listing has no external_id — cannot target Greenhouse job post' };

  const body = JSON.stringify({
    first_name: firstName,
    last_name: lastName,
    email,
    phone: profile.phone || undefined,
    resume_text: resumeText || undefined,
    cover_letter_text: coverLetter,
  });

  const authHeader = 'Basic ' + Buffer.from(portal.board_api_key + ':').toString('base64');

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'boards-api.greenhouse.io',
        path: `/v1/boards/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(externalId)}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `Greenhouse returned ${res.statusCode}: ${data.slice(0, 300)}` });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.write(body);
    req.end();
  });
}
