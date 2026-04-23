/**
 * Generate agent avatars using Vertex AI Imagen 3.
 *
 * Each agent gets a unique prompt that matches their Greek-god role (or
 * Cortana). The style is consistent across all avatars: portrait-framed,
 * 3D-rendered game-character style with a themed background — same visual
 * language as the existing avatar set, just with subject swapped.
 *
 * Outputs: assets/avatars/<agentId>.png (1024x1024, overwritten in place)
 *
 * Usage:
 *   npx tsx scripts/generate-avatars-imagen.ts
 *   npx tsx scripts/generate-avatars-imagen.ts executive-assistant qa   # subset
 *
 * Auth: reuses the project's Vertex AI credentials via GoogleAuth
 *       (ADC or GOOGLE_APPLICATION_CREDENTIALS_JSON/BASE64).
 * Env:
 *   GOOGLE_CLOUD_PROJECT / VERTEX_PROJECT_ID   — GCP project id (required)
 *   VERTEX_LOCATION                            — default: us-central1
 *   IMAGEN_MODEL                               — default: imagen-3.0-generate-002
 */

import * as fs from 'fs';
import * as path from 'path';

import { GoogleAuth } from 'google-auth-library';

import { ensureGoogleCredentials } from '../src/services/googleCredentials';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.VERTEX_PROJECT_ID || process.env.GCLOUD_PROJECT;
const LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const MODEL = process.env.IMAGEN_MODEL || 'imagen-3.0-generate-002';
const OUT_DIR = path.resolve(__dirname, '../assets/avatars');

interface AgentSpec {
  id: string;                // agent id (filename)
  displayName: string;       // name of the deity/character
  role: string;              // role descriptor
  prompt: string;            // subject + mood
}

const SHARED_STYLE =
  'Portrait framing, head-and-shoulders, subject centered and facing forward. ' +
  'Cinematic 3D-rendered game-character style — glossy, detailed, dramatic lighting. ' +
  'Square 1:1 composition, suitable for a Discord profile avatar. ' +
  'Painterly digital art, clean silhouette, soft rim light on the subject. ' +
  'No watermarks, no text, no logos, no hands visible, no lower body.';

const NEGATIVE =
  'Australian flag, Union Jack, country flag, nation flag, national emblem, national colors, ' +
  'text, letters, words, captions, logos, brand marks, ' +
  'hands, fingers, lower body, multiple people, crowd, photograph of real person, ' +
  'low quality, deformed, extra limbs, watermark, signature';

const SPECS: AgentSpec[] = [
  {
    id: 'executive-assistant',
    displayName: 'Cortana',
    role: 'AI assistant modeled on Cortana from Halo',
    prompt:
      'Cortana from the Halo video games — a glowing purple-blue holographic female AI, skin with softly luminescent circuitry, short dark hair swept back, confident and calm expression. ' +
      'Deep space background: star fields, nebula, faint orbital rings, gentle cool teal highlights. ' +
      'Iconic Halo Cortana aesthetic, modernised.',
  },
  {
    id: 'operations-manager',
    displayName: 'Cortana Ops',
    role: 'Cortana in ops/steward mode',
    prompt:
      'Cortana from Halo, same purple-blue holographic figure, slightly more watchful and focused expression. ' +
      'Background: a dark command deck interior with soft amber and teal UI glows, subtle holographic readouts, deep space beyond a visor window. ' +
      'Slightly different framing from the main Cortana portrait — still unmistakably her.',
  },
  {
    id: 'qa',
    displayName: 'Argus',
    role: 'Greek mythological all-seeing giant Argus Panoptes — QA',
    prompt:
      'Argus Panoptes, the hundred-eyed watcher of Greek mythology, reimagined as a stoic bearded figure draped in forest-green robes, faint luminous eyes patterning across his shoulders and chest like constellations. ' +
      'Background: deep emerald-green forest at dusk with shafts of golden light through ancient trees.',
  },
  {
    id: 'ux-reviewer',
    displayName: 'Aphrodite',
    role: 'Greek goddess of beauty — UX reviewer',
    prompt:
      'Aphrodite, Greek goddess of beauty, serene and confident young woman with flowing golden hair, soft coral and gold draped robes, gentle smile. ' +
      'Background: Aegean coast at golden hour — soft seafoam waves, pale coral sky, distant marble cliffs.',
  },
  {
    id: 'security-auditor',
    displayName: 'Athena',
    role: 'Greek goddess of wisdom and strategic defense — security',
    prompt:
      'Athena, Greek goddess of wisdom, dark-haired warrior in polished bronze breastplate with an owl motif, olive-leaf laurel in hair, sharp intelligent gaze, spear handle just visible. ' +
      'Background: Athenian temple at twilight, columns silhouetted against a stormy slate-blue sky.',
  },
  {
    id: 'api-reviewer',
    displayName: 'Iris',
    role: 'Greek messenger goddess, rainbow bridge — APIs',
    prompt:
      'Iris, Greek messenger goddess of the rainbow, young woman with iridescent flowing hair, pale silver robes with prismatic trim, small elegant wings at her back, poised mid-stride. ' +
      'Background: cloudscape with a faint rainbow arc and soft pearlescent sky.',
  },
  {
    id: 'dba',
    displayName: 'Mnemosyne',
    role: 'Titaness of memory — database',
    prompt:
      'Mnemosyne, Greek Titaness of memory, mature serene woman in deep indigo and gold robes, long dark hair, thoughtful expression, subtle glowing starlight threads woven through her hair. ' +
      'Background: vast dim library of scrolls and amphorae with candlelight, deep violet and warm amber tones.',
  },
  {
    id: 'performance',
    displayName: 'Hermes',
    role: 'Greek messenger god, swift-footed — performance',
    prompt:
      'Hermes, Greek god of speed and travel, young athletic man with close-cropped dark hair, winged helm, bronze shoulder clasp, alert and amused expression, motion-blur trails of light around his shoulders. ' +
      'Background: dawn sky over distant mountains, soft cyan and peach gradient.',
  },
  {
    id: 'devops',
    displayName: 'Hephaestus',
    role: 'Greek god of the forge — DevOps',
    prompt:
      'Hephaestus, Greek god of the forge, broad-shouldered bearded smith in soot-streaked leather apron over bronze, red-amber firelight on his face, calm focused expression, anvil motif stitched on his collar. ' +
      'Background: dim forge interior with glowing orange coals and sparks drifting.',
  },
  {
    id: 'copywriter',
    displayName: 'Calliope',
    role: 'Muse of eloquence and epic poetry — copywriter',
    prompt:
      'Calliope, Greek Muse of epic poetry, graceful woman with dark auburn hair woven with a slender laurel, teal and cream flowing robes, holding a reed stylus lightly, thoughtful smile. ' +
      'Background: warm candlelit study with open scrolls and soft teal velvet drape behind her.',
  },
  {
    id: 'lawyer',
    displayName: 'Themis',
    role: 'Greek goddess of law and custom — legal',
    prompt:
      'Themis, Greek goddess of divine law, poised tall woman with long silver-streaked black hair, deep forest-green and gold draped robes, dignified calm expression, balanced scale motif engraved on her clasp. ' +
      'Background: marble courthouse atrium at dusk, cool jade-green tones.',
  },
  {
    id: 'ios-engineer',
    displayName: 'Artemis',
    role: 'Greek goddess of the hunt — iOS',
    prompt:
      'Artemis, Greek goddess of the hunt, lithe young woman with auburn braided hair, crescent-moon circlet, silver-grey hunting tunic with soft orange accents, bow just visible over one shoulder, sharp alert gaze. ' +
      'Background: moonlit forest clearing, cool silver-blue with warm orange accents.',
  },
  {
    id: 'android-engineer',
    displayName: 'Prometheus',
    role: 'Titan who gave fire to mortals — Android',
    prompt:
      'Prometheus, Greek Titan who gave fire to humanity, rugged bearded figure in earth-tone robes with bronze cuffs, cupped palm holding a small flame, determined forward-looking expression, warm green and amber tones on his skin from the firelight. ' +
      'Background: rocky mountain ledge at twilight, faint warm glow from below.',
  },
];

interface ImagenPrediction {
  bytesBase64Encoded?: string;
  mimeType?: string;
}

async function getAccessToken(): Promise<string> {
  await ensureGoogleCredentials(PROJECT_ID).catch(() => false);
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const value = typeof token === 'string' ? token : token?.token;
  if (!value) throw new Error('Failed to acquire Google access token');
  return value;
}

async function generateImage(spec: AgentSpec, token: string): Promise<Buffer> {
  const endpoint =
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

  const prompt = `${spec.prompt} ${SHARED_STYLE}`;

  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: '1:1',
      safetyFilterLevel: 'block_only_high',
      personGeneration: 'allow_adult',
      negativePrompt: NEGATIVE,
    },
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Imagen HTTP ${res.status} for ${spec.id}: ${err.slice(0, 400)}`);
  }

  const data = (await res.json()) as { predictions?: ImagenPrediction[] };
  const b64 = data.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error(`Imagen returned no image bytes for ${spec.id}`);
  return Buffer.from(b64, 'base64');
}

async function main(): Promise<void> {
  if (!PROJECT_ID) {
    console.error('Set GOOGLE_CLOUD_PROJECT (or VERTEX_PROJECT_ID) to run this script.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const subsetIds = process.argv.slice(2);
  const queue = subsetIds.length
    ? SPECS.filter((s) => subsetIds.includes(s.id))
    : SPECS;

  if (queue.length === 0) {
    console.error(`No matching agent ids. Known ids: ${SPECS.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`Generating ${queue.length} avatar(s) via Imagen ${MODEL} in ${LOCATION}…`);
  const token = await getAccessToken();

  // Serial, not parallel — Imagen has per-project QPS limits and the output
  // is small (13 images total on a full run). Predictable beats fast here.
  for (const spec of queue) {
    const out = path.join(OUT_DIR, `${spec.id}.png`);
    try {
      const bytes = await generateImage(spec, token);
      fs.writeFileSync(out, bytes);
      console.log(`  ✓ ${spec.displayName.padEnd(14)} → ${out} (${(bytes.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      console.error(`  ✗ ${spec.displayName}: ${(err as Error).message}`);
    }
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
