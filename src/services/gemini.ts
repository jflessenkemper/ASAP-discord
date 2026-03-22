import { GoogleGenerativeAI, DynamicRetrievalMode } from '@google/generative-ai';

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

function getModel() {
  return genAI?.getGenerativeModel({ model: 'gemini-1.5-flash' }) ?? null;
}

function getGroundedModel() {
  return genAI?.getGenerativeModel({
    model: 'gemini-1.5-flash',
    tools: [{
      googleSearchRetrieval: {
        dynamicRetrievalConfig: {
          mode: DynamicRetrievalMode.MODE_DYNAMIC,
          dynamicThreshold: 0.3,
        },
      },
    }],
  }) ?? null;
}

interface DifficultyAssessment {
  difficulty: number;       // 1-10
  estimatedMinutes: number; // estimated duration
}

export async function assessJobDifficulty(
  description: string,
  photoUrls: string[] = []
): Promise<DifficultyAssessment> {
  if (!genAI) {
    // Fallback when no API key — estimate based on description length
    const words = description.trim().split(/\s+/).length;
    return {
      difficulty: Math.min(10, Math.max(1, Math.round(words / 10))),
      estimatedMinutes: Math.max(15, words * 3),
    };
  }

  const model = getModel()!;

  // Sanitize description to prevent prompt injection
  const sanitized = description.replace(/[\r\n]+/g, ' ').slice(0, 2000);

  const prompt = `You are assessing a tech support job request. Based on the description${photoUrls.length > 0 ? ' and attached photos' : ''}, provide a JSON response with:
- "difficulty": integer 1-10 (1=trivial like password reset, 10=extremely complex like data recovery from damaged drive)
- "estimatedMinutes": integer estimate of how long this job would take a competent technician

Job description: "${sanitized}"
${photoUrls.length > 0 ? `\nPhotos attached: ${photoUrls.length} image(s)` : ''}

Respond ONLY with valid JSON, no markdown, no explanation. Example: {"difficulty": 3, "estimatedMinutes": 45}`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    // Extract JSON from response (handle potential markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON in response');
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      difficulty: Math.min(10, Math.max(1, Math.round(parsed.difficulty))),
      estimatedMinutes: Math.max(5, Math.round(parsed.estimatedMinutes)),
    };
  } catch (err) {
    // Retry once on failure
    try {
      const retryResult = await model.generateContent(prompt);
      const retryText = retryResult.response.text().trim();
      const retryMatch = retryText.match(/\{[\s\S]*\}/);
      if (retryMatch) {
        const parsed = JSON.parse(retryMatch[0]);
        return {
          difficulty: Math.min(10, Math.max(1, Math.round(parsed.difficulty))),
          estimatedMinutes: Math.max(5, Math.round(parsed.estimatedMinutes)),
        };
      }
    } catch { /* fall through to default */ }
    console.error('Gemini assessment error:', err instanceof Error ? err.message : 'Unknown error');
    return { difficulty: 5, estimatedMinutes: 60 };
  }
}

// ─── Audio Transcription ───
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string
): Promise<string> {
  const model = getModel();
  if (!model) throw new Error('Gemini API key not configured');

  const base64Audio = audioBuffer.toString('base64');

  const result = await model.generateContent([
    { text: 'Transcribe the following audio recording. Return ONLY the transcribed text, nothing else. If the audio is unclear, do your best to transcribe it.' },
    { inlineData: { mimeType, data: base64Audio } },
  ]);

  const text = result.response.text().trim();
  if (!text) throw new Error('Empty transcription');
  return text;
}

// ─── Job Categorization for Business Search ───
export async function categorizeJob(description: string): Promise<string> {
  const model = getModel();
  if (!model) {
    return description.slice(0, 100);
  }

  const sanitized = description.replace(/[\r\n]+/g, ' ').slice(0, 2000);

  const prompt = `Given this job/service request, return a concise Google Maps search query (max 6 words) to find relevant local businesses that could handle this job. Return ONLY the search query text, nothing else.

Job description: "${sanitized}"

Examples:
- "My kitchen tap is leaking and the pipes under the sink are corroded" → "plumber"
- "I need someone to mow my lawn and trim the hedges" → "lawn mowing garden maintenance"
- "The power points in my bedroom stopped working" → "electrician"
- "My laptop screen is cracked" → "computer repair"`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim().slice(0, 100);
}

// ─── Fuel Price Summary ───
export async function summarizeFuelPrices(
  prices: Array<{ fuelType: string; fuelLabel: string; pricePerLitre: number; stationName: string; stationAddress: string; distanceKm: number }>
): Promise<string> {
  const model = getModel();
  if (!model || prices.length === 0) {
    return '';
  }

  const table = prices
    .slice(0, 20)
    .map(p => `${p.fuelLabel}: $${p.pricePerLitre.toFixed(3)}/L at ${p.stationName} (${p.distanceKm.toFixed(1)} km)`)
    .join('\n');

  const prompt = `You are a helpful Australian fuel price assistant. Given these nearby fuel prices, write a brief 1-2 sentence summary highlighting the cheapest option and any notable savings. Be concise and friendly. Use Australian English.

Fuel prices:
${table}

Return ONLY the summary text, no markdown, no bullet points.`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim().slice(0, 500);
  } catch (err) {
    console.error('Gemini fuel summary error:', err instanceof Error ? err.message : 'Unknown');
    return '';
  }
}

// ─── Product Price Search ───
export interface ProductResult {
  title: string;
  price: number | null;
  priceText: string;
  source: string;
  sourceUrl: string;
}

export async function searchBestPrices(
  query: string,
): Promise<ProductResult[]> {
  const model = getGroundedModel() || getModel();
  if (!model) throw new Error('Gemini API key not configured');

  const sanitized = query.replace(/[\r\n]+/g, ' ').slice(0, 200);

  const prompt = `Find the current best prices for "${sanitized}" available to buy in Australia right now. Check major Australian retailers including JB Hi-Fi, Harvey Norman, Officeworks, Kmart, Big W, Target, Bunnings, Amazon Australia, and eBay Australia.

Return a JSON array of up to 10 results, sorted by price ascending (cheapest first). Each result:
{
  "title": "Product name / listing title",
  "price": 99.95,
  "priceText": "$99.95",
  "source": "JB Hi-Fi",
  "sourceUrl": "https://..."
}

If you cannot find a URL, use "" for sourceUrl. If price is unknown, use null for price and "Price N/A" for priceText.
Return ONLY valid JSON array, no markdown, no explanation.`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in response');
    const parsed = JSON.parse(jsonMatch[0]) as ProductResult[];
    return parsed.map(p => ({
      title: String(p.title || '').slice(0, 200),
      price: typeof p.price === 'number' ? p.price : null,
      priceText: String(p.priceText || 'Price N/A').slice(0, 30),
      source: String(p.source || 'Unknown').slice(0, 50),
      sourceUrl: typeof p.sourceUrl === 'string' && /^https?:\/\//.test(p.sourceUrl) ? p.sourceUrl : '',
    }));
  } catch (err) {
    console.error('Gemini search error:', err instanceof Error ? err.message : 'Unknown');
    return [];
  }
}
