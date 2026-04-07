import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';

import pool from '../db/pool';
import { textToSpeech } from '../services/elevenlabs';
import { sendQuoteNotification, sendOwnerNotification } from '../services/email';
import { getBestPricesByType, haversineKm } from '../services/fuel';
import { intelligentSearch, transcribeAudio, summarizeFuelPrices, searchBestPrices } from '../services/gemini';

const router = Router();

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many search requests, try again shortly' },
});

const voiceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many voice requests, try again shortly' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// Simple in-memory cache for intent classification (5 min TTL)
const intentCache = new Map<string, { result: any; ts: number }>();
const INTENT_TTL_MS = 5 * 60 * 1000;

// ─── POST /api/search — Unified AI Search ───
router.post('/', searchLimiter, async (req: Request, res: Response) => {
  try {
    const { query, lat, lng } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }
    if (query.trim().length > 500) {
      res.status(400).json({ error: 'Query must be 500 characters or less' });
      return;
    }

    const trimmed = query.trim();
    const numLat = lat != null ? Number(lat) : undefined;
    const numLng = lng != null ? Number(lng) : undefined;

    // Check cache
    const cacheKey = `${trimmed.toLowerCase()}|${numLat?.toFixed(2)}|${numLng?.toFixed(2)}`;
    const cached = intentCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < INTENT_TTL_MS) {
      res.json(cached.result);
      return;
    }

    // Step 1: Classify intent
    const classification = await intelligentSearch(trimmed, numLat, numLng);

    // Step 2: Route to appropriate service
    let results: any[] = [];
    let summary = '';
    let directAnswer: string | undefined;

    switch (classification.intent) {
      case 'service': {
        if (numLat == null || numLng == null) {
          res.json({ intent: 'service', results: [], summary: 'Location needed to find services near you.', searchQuery: classification.searchQuery });
          return;
        }
        const placesKey = process.env.GOOGLE_MAPS_API_KEY;
        if (!placesKey) {
          res.json({ intent: 'service', results: [], searchQuery: classification.searchQuery });
          return;
        }
        const placesUrl = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
        placesUrl.searchParams.set('query', classification.searchQuery);
        placesUrl.searchParams.set('location', `${numLat},${numLng}`);
        placesUrl.searchParams.set('radius', '15000');
        placesUrl.searchParams.set('key', placesKey);

        const placesRes = await fetch(placesUrl.toString());
        const placesData = await placesRes.json() as any;
        results = (placesData.results || []).slice(0, 10).map((p: any) => ({
          name: p.name || '',
          rating: p.rating || 0,
          totalRatings: p.user_ratings_total || 0,
          address: p.formatted_address || '',
          lat: p.geometry?.location?.lat || 0,
          lng: p.geometry?.location?.lng || 0,
          distanceKm: parseFloat(haversineKm(numLat, numLng, p.geometry?.location?.lat || 0, p.geometry?.location?.lng || 0).toFixed(1)),
          placeId: p.place_id || '',
          icon: p.icon || '',
          openNow: p.opening_hours?.open_now ?? null,
        }));
        results.sort((a: any, b: any) => b.rating - a.rating);
        break;
      }

      case 'fuel': {
        if (numLat == null || numLng == null) {
          res.json({ intent: 'fuel', results: [], summary: 'Location needed to find fuel prices near you.' });
          return;
        }
        const prices = await getBestPricesByType(numLat, numLng, 15);
        results = prices;
        if (prices.length > 0) {
          summary = await summarizeFuelPrices(prices);
        }
        break;
      }

      case 'shop': {
        results = await searchBestPrices(classification.searchQuery);
        break;
      }

      case 'general': {
        directAnswer = classification.directAnswer;
        break;
      }
    }

    const response = {
      intent: classification.intent,
      searchQuery: classification.searchQuery,
      results,
      summary: summary || undefined,
      directAnswer,
    };

    // Cache the response
    intentCache.set(cacheKey, { result: response, ts: Date.now() });

    res.json(response);
  } catch (err) {
    console.error('Unified search error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

// ─── POST /api/search/voice — Voice Search ───
router.post('/voice', voiceLimiter, upload.single('audio'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Audio file is required' });
      return;
    }

    // Transcribe audio
    const transcript = await transcribeAudio(req.file.buffer, req.file.mimetype);
    const { lat, lng } = req.body;
    const numLat = lat != null ? Number(lat) : undefined;
    const numLng = lng != null ? Number(lng) : undefined;

    // Run through unified search
    const classification = await intelligentSearch(transcript, numLat, numLng);

    let results: any[] = [];
    let summary = '';
    let directAnswer: string | undefined;

    switch (classification.intent) {
      case 'service': {
        if (numLat != null && numLng != null) {
          const placesKey = process.env.GOOGLE_MAPS_API_KEY;
          if (placesKey) {
            const placesUrl = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
            placesUrl.searchParams.set('query', classification.searchQuery);
            placesUrl.searchParams.set('location', `${numLat},${numLng}`);
            placesUrl.searchParams.set('radius', '15000');
            placesUrl.searchParams.set('key', placesKey);
            const placesRes = await fetch(placesUrl.toString());
            const placesData = await placesRes.json() as any;
            results = (placesData.results || []).slice(0, 10).map((p: any) => ({
              name: p.name || '',
              rating: p.rating || 0,
              totalRatings: p.user_ratings_total || 0,
              address: p.formatted_address || '',
              lat: p.geometry?.location?.lat || 0,
              lng: p.geometry?.location?.lng || 0,
              distanceKm: parseFloat(haversineKm(numLat, numLng, p.geometry?.location?.lat || 0, p.geometry?.location?.lng || 0).toFixed(1)),
              placeId: p.place_id || '',
              icon: p.icon || '',
              openNow: p.opening_hours?.open_now ?? null,
            }));
            results.sort((a: any, b: any) => b.rating - a.rating);
          }
        }
        break;
      }
      case 'fuel': {
        if (numLat != null && numLng != null) {
          const prices = await getBestPricesByType(numLat, numLng, 15);
          results = prices;
          if (prices.length > 0) summary = await summarizeFuelPrices(prices);
        }
        break;
      }
      case 'shop': {
        results = await searchBestPrices(classification.searchQuery);
        break;
      }
      case 'general': {
        directAnswer = classification.directAnswer;
        break;
      }
    }

    res.json({
      transcript,
      intent: classification.intent,
      searchQuery: classification.searchQuery,
      results,
      summary: summary || undefined,
      directAnswer,
    });
  } catch (err) {
    console.error('Voice search error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Voice search failed. Please try again.' });
  }
});

// ─── POST /api/search/voice-response — ElevenLabs TTS ───
router.post('/voice-response', voiceLimiter, async (req: Request, res: Response) => {
  try {
    const { text, voiceId } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Text is required' });
      return;
    }

    const resolvedVoiceId = typeof voiceId === 'string' && /^[a-zA-Z0-9]{10,30}$/.test(voiceId) ? voiceId : undefined;
    const audioBuffer = await textToSpeech(text.trim(), resolvedVoiceId);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.send(audioBuffer);
  } catch (err) {
    console.error('Voice response error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Voice synthesis failed.' });
  }
});

// ─── POST /api/search/notify-owner ───
router.post('/notify-owner', searchLimiter, async (req: Request, res: Response) => {
  try {
    const { searchQuery, businessName, businessAddress, businessRating, clientName } = req.body;

    if (!searchQuery || typeof searchQuery !== 'string' || !searchQuery.trim()) {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }
    if (!businessName || typeof businessName !== 'string') {
      res.status(400).json({ error: 'Business name is required' });
      return;
    }

    try {
      await sendOwnerNotification(
        searchQuery.trim(),
        businessName,
        typeof businessAddress === 'string' ? businessAddress : '',
        typeof businessRating === 'number' ? businessRating : 0,
        typeof clientName === 'string' ? clientName : '',
      );
    } catch (emailErr) {
      console.error('Failed to send owner notification email:', emailErr instanceof Error ? emailErr.message : 'Unknown');
    }

    res.json({ sent: true, message: 'Jordan has been notified and will call you shortly!' });
  } catch (err) {
    console.error('Notify owner error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\'t send notification. Please try again.' });
  }
});

// ─── POST /api/search/request-quote ───
router.post('/request-quote', searchLimiter, async (req: Request, res: Response) => {
  try {
    const { business_place_id, description, client_name, client_email, client_phone, lat, lng } = req.body;

    if (!description || typeof description !== 'string' || !description.trim()) {
      res.status(400).json({ error: 'Description is required' });
      return;
    }
    if (description.trim().length > 2000) {
      res.status(400).json({ error: 'Description must be 2000 characters or less' });
      return;
    }
    if (!business_place_id || typeof business_place_id !== 'string') {
      res.status(400).json({ error: 'Business place ID is required' });
      return;
    }

    // Try to find registered business by place_id
    const bizResult = await pool.query(
      'SELECT id, name, email FROM businesses WHERE place_id = $1 LIMIT 1',
      [business_place_id.slice(0, 200)]
    );

    if (bizResult.rows.length === 0) {
      // No registered business — return info that quote request can't be sent yet
      res.json({ sent: false, message: 'This business hasn\'t joined ASAP yet. We\'ll notify them about your request.' });
      return;
    }

    const business = bizResult.rows[0];

    // Create quote request
    const qrResult = await pool.query(
      `INSERT INTO quote_requests (business_id, description, client_name, client_email, client_phone, client_lat, client_lng)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        business.id,
        description.trim().slice(0, 2000),
        typeof client_name === 'string' ? client_name.slice(0, 200) : '',
        typeof client_email === 'string' ? client_email.slice(0, 200) : '',
        typeof client_phone === 'string' ? client_phone.slice(0, 50) : '',
        lat != null ? Number(lat) : null,
        lng != null ? Number(lng) : null,
      ]
    );

    // Send email notification to business
    try {
      await sendQuoteNotification(
        business.email,
        business.name,
        description.trim(),
        typeof client_name === 'string' ? client_name : 'A customer',
      );
    } catch (emailErr) {
      console.error('Failed to send quote notification email:', emailErr instanceof Error ? emailErr.message : 'Unknown');
    }

    res.json({ sent: true, requestId: qrResult.rows[0].id, message: 'Quote request sent!' });
  } catch (err) {
    console.error('Request quote error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\'t send quote request. Please try again.' });
  }
});

export default router;
