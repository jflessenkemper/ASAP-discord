/**
 * Generate professional agent avatars with a draped Australian flag background.
 *
 * Usage:
 *   npm install --save-dev sharp @types/sharp   # one-time
 *   npx tsx scripts/generate-avatars.ts
 *
 * Outputs 256×256 PNGs to assets/avatars/<agentId>.png
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// ── Agent seeds (same seeds keep faces consistent across regenerations) ──
const AGENTS: Record<string, string> = {
  qa:                    'MaxQA',
  'ux-reviewer':         'SophieUX',
  'security-auditor':    'KaneSecurity',
  'api-reviewer':        'RajAPI',
  dba:                   'ElenaDBA',
  performance:           'KaiPerformance',
  devops:                'JudeDevOps',
  copywriter:            'LivCopywriter',
  developer:             'AceDeveloper',
  lawyer:                'HarperLawyer',
  'executive-assistant': 'RileyEA',
  'ios-engineer':        'MiaiOS',
  'android-engineer':    'LeoAndroid',
};

const SIZE = 256;
const AVATAR_SIZE = 190;
const SHADOW_OFFSET = 4;
const SHADOW_BLUR = 8;
const SHADOW_OPACITY = 0.45;
const OUTPUT_DIR = path.resolve(__dirname, '../assets/avatars');

// ── Geometry helper: n-pointed star polygon ─────────────────────────────────
function star(cx: number, cy: number, points: number, outerR: number, innerR: number): string {
  const coords: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = (Math.PI * i) / points - Math.PI / 2;
    coords.push(`${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`);
  }
  return coords.join(' ');
}

// ── Australian flag SVG (1024×512 landscape) ────────────────────────────────
// Simplified but recognisable: Union Jack canton, Commonwealth Star, Southern Cross.
function australianFlagSVG(w = 1024, h = 512): string {
  const cW = w / 2;   // canton width
  const cH = h / 2;   // canton height
  const cx = cW / 2;
  const cy = cH / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
  <!-- Blue ensign background -->
  <rect width="${w}" height="${h}" fill="#00008B"/>

  <!-- Union Jack canton -->
  <g>
    <line x1="0" y1="0" x2="${cW}" y2="${cH}" stroke="white" stroke-width="16"/>
    <line x1="${cW}" y1="0" x2="0" y2="${cH}" stroke="white" stroke-width="16"/>
    <line x1="0" y1="0" x2="${cW}" y2="${cH}" stroke="#CF142B" stroke-width="8"/>
    <line x1="${cW}" y1="0" x2="0" y2="${cH}" stroke="#CF142B" stroke-width="8"/>
    <line x1="${cx}" y1="0" x2="${cx}" y2="${cH}" stroke="white" stroke-width="28"/>
    <line x1="0" y1="${cy}" x2="${cW}" y2="${cy}" stroke="white" stroke-width="28"/>
    <line x1="${cx}" y1="0" x2="${cx}" y2="${cH}" stroke="#CF142B" stroke-width="14"/>
    <line x1="0" y1="${cy}" x2="${cW}" y2="${cy}" stroke="#CF142B" stroke-width="14"/>
  </g>

  <!-- Commonwealth Star (7-pointed, below canton) -->
  <polygon points="${star(cW / 2, h * 0.75, 7, 42, 20)}" fill="white"/>

  <!-- Southern Cross -->
  <polygon points="${star(w * 0.75,  h * 0.76, 7, 18, 8)}" fill="white"/>
  <polygon points="${star(w * 0.625, h * 0.50, 7, 18, 8)}" fill="white"/>
  <polygon points="${star(w * 0.75,  h * 0.28, 7, 18, 8)}" fill="white"/>
  <polygon points="${star(w * 0.85,  h * 0.52, 7, 18, 8)}" fill="white"/>
  <polygon points="${star(w * 0.81,  h * 0.62, 5, 10, 5)}" fill="white"/>

  <!-- Subtle drape shading (fabric fold effect) -->
  <defs>
    <linearGradient id="drape" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="black" stop-opacity="0.10"/>
      <stop offset="20%"  stop-color="white" stop-opacity="0.06"/>
      <stop offset="40%"  stop-color="black" stop-opacity="0.08"/>
      <stop offset="60%"  stop-color="white" stop-opacity="0.04"/>
      <stop offset="80%"  stop-color="black" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.06"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#drape)"/>
</svg>`;
}

// ── Fetch DiceBear avatar (notionists-neutral — professional, no dummies) ───
async function fetchAvatar(seed: string): Promise<Buffer> {
  const url = `https://api.dicebear.com/9.x/notionists-neutral/png?seed=${encodeURIComponent(seed)}&size=${AVATAR_SIZE}&backgroundColor=transparent`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`DiceBear fetch failed for ${seed}: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ── Create flag background (rotated 90° CW → draped vertical orientation) ──
// After rotation: Union Jack sits at the top-right, flag drapes downward.
async function createFlagBackground(): Promise<Buffer> {
  const flagSvg = Buffer.from(australianFlagSVG(1024, 512));

  const rotated = await sharp(flagSvg)
    .png()
    .rotate(90)
    .toBuffer();

  const meta = await sharp(rotated).metadata();
  const cropW = Math.min(meta.width!, meta.height!);

  return sharp(rotated)
    .extract({ left: 0, top: 0, width: cropW, height: cropW })
    .resize(SIZE, SIZE)
    .png()
    .toBuffer();
}

// ── Create drop shadow from the avatar's alpha channel ──────────────────────
async function createShadow(avatarBuf: Buffer): Promise<Buffer> {
  const { width, height } = await sharp(avatarBuf).metadata();
  const w = width!;
  const h = height!;

  const { data, info } = await sharp(avatarBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Black silhouette at reduced opacity
  const shadow = Buffer.alloc(info.size);
  for (let i = 0; i < info.size; i += 4) {
    shadow[i]     = 0;
    shadow[i + 1] = 0;
    shadow[i + 2] = 0;
    shadow[i + 3] = Math.round(data[i + 3] * SHADOW_OPACITY);
  }

  return sharp(shadow, { raw: { width: w, height: h, channels: 4 } })
    .blur(SHADOW_BLUR)
    .png()
    .toBuffer();
}

// ── Composite: flag background → shadow → avatar ────────────────────────────
async function generateAvatar(agentId: string, seed: string, flagBg: Buffer): Promise<void> {
  console.log(`  Generating ${agentId} (seed: ${seed})...`);

  const avatarBuf = await fetchAvatar(seed);
  const shadowBuf = await createShadow(avatarBuf);

  const offset = Math.round((SIZE - AVATAR_SIZE) / 2);

  const result = await sharp(flagBg)
    .composite([
      { input: shadowBuf, left: offset + SHADOW_OFFSET, top: offset + SHADOW_OFFSET },
      { input: avatarBuf, left: offset, top: offset },
    ])
    .png()
    .toBuffer();

  const outPath = path.join(OUTPUT_DIR, `${agentId}.png`);
  fs.writeFileSync(outPath, result);
  console.log(`    ✓ ${outPath}`);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Creating Australian flag background (draped orientation)...');
  const flagBg = await createFlagBackground();

  // Also save the flag background on its own for reference
  fs.writeFileSync(path.join(OUTPUT_DIR, '_flag-background.png'), flagBg);
  console.log('  ✓ Flag background saved\n');

  console.log(`Generating ${Object.keys(AGENTS).length} agent avatars...\n`);
  for (const [agentId, seed] of Object.entries(AGENTS)) {
    await generateAvatar(agentId, seed, flagBg);
  }

  console.log('\n✅ All avatars generated in assets/avatars/');
  console.log('\nNext steps:');
  console.log('  1. git add assets/avatars/ && git commit -m "feat: professional agent avatars with Aus flag"');
  console.log('  2. git push origin main');
  console.log('  3. Update AVATAR_MAP in src/discord/agents.ts with GitHub raw URLs:');
  console.log('     https://raw.githubusercontent.com/jflessenkemper/ASAP-discord/main/assets/avatars/<agentId>.png');
}

main().catch((err) => {
  console.error('Avatar generation failed:', err);
  process.exit(1);
});
