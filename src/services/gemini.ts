import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

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

  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

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
    console.error('Gemini assessment error:', err);
    return { difficulty: 5, estimatedMinutes: 60 };
  }
}
