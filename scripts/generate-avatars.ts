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

const SIZE = 256;
const AVATAR_SIZE = 200;           // avatar is smaller than the image …
const CIRCLE_RADIUS = 108;         // … and sits inside a white circle
const CIRCLE_BORDER = 4;           // subtle border ring
const SHADOW_OFFSET = 3;
const SHADOW_BLUR = 6;
const SHADOW_OPACITY = 0.35;
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

// ── Australian flag SVG (square format for avatar backgrounds) ──────────────
// Rendered directly as square — no rotation/cropping needed.
// Accurate proportions: Union Jack canton, Commonwealth Star, Southern Cross.
function australianFlagSVG(s = 256): string {
  // Canton occupies the top-left quarter
  const cW = s / 2;   // canton width
  const cH = s / 2;   // canton height
  const cx = cW / 2;  // canton center x
  const cy = cH / 2;  // canton center y

  // Stroke widths based on canton height (per Union Jack spec: Flag Institute / jdawiseman.com)
  // Total diagonal band = cH/5, subdivided 3:2:1 → wider white : red : narrower white
  // St George's cross = cH/5 red, fimbriated cH/15 white on each side
  const diagWhite = Math.round(cH / 5);
  const crossTotal = Math.round(cH / 3);   // white fimbriation + red cross total
  const crossRed = Math.round(cH / 5);

  // Counterchanged St Patrick's saltire: red strip (cH/15 wide perpendicular)
  // starts at diagonal centre and extends outward. Axis-aligned offset = cH/(15√2).
  // Hoist (left): red below diagonal → wider white on top.
  // Fly (right): red above diagonal → wider white on bottom.
  const d = Math.round(cH / (15 * Math.SQRT2));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}">
  <!-- Blue ensign background -->
  <rect width="${s}" height="${s}" fill="#00008B"/>

  <!-- Union Jack canton (top-left quarter) -->
  <g clip-path="url(#canton-clip)">
    <!-- White diagonal cross (St Andrew's Saltire) -->
    <line x1="0" y1="0" x2="${cW}" y2="${cH}" stroke="white" stroke-width="${diagWhite}"/>
    <line x1="${cW}" y1="0" x2="0" y2="${cH}" stroke="white" stroke-width="${diagWhite}"/>
    <!-- Red diagonal stripes (St Patrick's Saltire — counterchanged pinwheel) -->
    <!-- TL arm: red below diagonal (wide white on top, hoist side) -->
    <polygon points="0,0 ${cx},${cy} ${cx - d},${cy + d} 0,${2 * d}" fill="#C8102E"/>
    <!-- BR arm: red above diagonal (continues TL pattern) -->
    <polygon points="${cW},${cH} ${cx},${cy} ${cx + d},${cy - d} ${cW},${cH - 2 * d}" fill="#C8102E"/>
    <!-- TR arm: red above-left (narrow white on top, fly side) -->
    <polygon points="${cW},0 ${cx},${cy} ${cx - d},${cy - d} ${cW - 2 * d},0" fill="#C8102E"/>
    <!-- BL arm: red below-right (continues TR pattern) -->
    <polygon points="0,${cH} ${cx},${cy} ${cx + d},${cy + d} ${2 * d},${cH}" fill="#C8102E"/>
    <!-- White cross border (St George's fimbriation) -->
    <line x1="${cx}" y1="0" x2="${cx}" y2="${cH}" stroke="white" stroke-width="${crossTotal}"/>
    <line x1="0" y1="${cy}" x2="${cW}" y2="${cy}" stroke="white" stroke-width="${crossTotal}"/>
    <!-- Red cross (St George's Cross) -->
    <line x1="${cx}" y1="0" x2="${cx}" y2="${cH}" stroke="#C8102E" stroke-width="${crossRed}"/>
    <line x1="0" y1="${cy}" x2="${cW}" y2="${cy}" stroke="#C8102E" stroke-width="${crossRed}"/>
  </g>
  <defs>
    <clipPath id="canton-clip"><rect width="${cW}" height="${cH}"/></clipPath>
  </defs>

  <!-- Commonwealth Star (7-pointed, below canton centre) -->
  <polygon points="${star(cW / 2, s * 0.72, 7, s * 0.08, s * 0.038)}" fill="white"/>

  <!-- Southern Cross (right side) -->
  <polygon points="${star(s * 0.75,  s * 0.76, 7, s * 0.035, s * 0.016)}" fill="white"/>
  <polygon points="${star(s * 0.625, s * 0.50, 7, s * 0.035, s * 0.016)}" fill="white"/>
  <polygon points="${star(s * 0.75,  s * 0.28, 7, s * 0.035, s * 0.016)}" fill="white"/>
  <polygon points="${star(s * 0.85,  s * 0.50, 7, s * 0.035, s * 0.016)}" fill="white"/>
  <polygon points="${star(s * 0.81,  s * 0.62, 5, s * 0.02, s * 0.01)}" fill="white"/>

  <!-- Subtle drape shading -->
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
  <rect width="${s}" height="${s}" fill="url(#drape)"/>
</svg>`;
}

// ── Agent appearance configuration ──────────────────────────────────────────
// Professional stylized illustrations with diversity matching agent names.
// Uses DiceBear "personas" style for clean, corporate-style illustrated avatars.
interface AvatarStyle {
  seed: string;
  /** DiceBear personas clothing: blazer, shirt, dress */
  clothing?: string;
  /** Skin tone hint (DiceBear uses seed for variation, but we nudge via seed suffix) */
  skinColor?: string;
}

const AGENT_STYLES: Record<string, AvatarStyle> = {
  qa:                    { seed: 'MaxQA-professional',       clothing: 'blazer' },
  'ux-reviewer':         { seed: 'SophieUX-corporate',      clothing: 'dress' },
  'security-auditor':    { seed: 'KaneSecurity-formal',     clothing: 'blazer' },
  'api-reviewer':        { seed: 'RajAPI-business',         clothing: 'shirt' },
  dba:                   { seed: 'ElenaDBA-executive',       clothing: 'dress' },
  performance:           { seed: 'KaiPerformance-sharp',     clothing: 'blazer' },
  devops:                { seed: 'JudeDevOps-smart',         clothing: 'shirt' },
  copywriter:            { seed: 'LivCopywriter-elegant',    clothing: 'dress' },
  developer:             { seed: 'AceDeveloper-polished',    clothing: 'blazer' },
  lawyer:                { seed: 'HarperLawyer-barrister',   clothing: 'blazer' },
  'executive-assistant': { seed: 'RileyExecutive-leader',    clothing: 'blazer' },
  'ios-engineer':        { seed: 'MiaiOS-classy',           clothing: 'dress' },
  'android-engineer':    { seed: 'LeoAndroid-suited',        clothing: 'blazer' },
};

// ── Fetch DiceBear avatar (avataaars — colourful illustrated faces) ──────────
async function fetchAvatar(seed: string): Promise<Buffer> {
  const params = new URLSearchParams({
    seed,
    size: String(AVATAR_SIZE),
    backgroundColor: 'transparent',
    clothing: 'blazerAndShirt,blazerAndSweater,collarAndSweater',
    mouth: 'default,smile,twinkle',
    eyes: 'default,happy',
    eyebrows: 'default,defaultNatural,flatNatural',
    accessoriesProbability: '0',
  });
  const url = `https://api.dicebear.com/9.x/avataaars/png?${params}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`DiceBear fetch failed for ${seed}: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ── Create flag background (square format — no rotation needed) ─────────────
async function createFlagBackground(): Promise<Buffer> {
  const flagSvg = Buffer.from(australianFlagSVG(SIZE));
  return sharp(flagSvg).resize(SIZE, SIZE).png().toBuffer();
}

// ── Create white circular backdrop SVG ───────────────────────────────────────
function circleBackdropSVG(): string {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    <circle cx="${cx}" cy="${cy}" r="${CIRCLE_RADIUS}" fill="white"/>
    <circle cx="${cx}" cy="${cy}" r="${CIRCLE_RADIUS}" fill="none" stroke="rgba(0,0,0,0.12)" stroke-width="${CIRCLE_BORDER}"/>
  </svg>`;
}

// ── Circle-mask an avatar into a round portrait ─────────────────────────────
async function circleClip(avatarBuf: Buffer): Promise<Buffer> {
  const r = CIRCLE_RADIUS - CIRCLE_BORDER;
  const dim = r * 2;
  const mask = Buffer.from(
    `<svg width="${dim}" height="${dim}"><circle cx="${r}" cy="${r}" r="${r}" fill="white"/></svg>`,
  );
  return sharp(avatarBuf)
    .resize(dim, dim, { fit: 'cover', position: 'top' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

// ── Composite: flag → white circle → shadow → clipped avatar ────────────────
async function generateAvatar(agentId: string, seed: string, flagBg: Buffer, circleBg: Buffer): Promise<void> {
  console.log(`  Generating ${agentId} (seed: ${seed})...`);

  const avatarRaw = await fetchAvatar(seed);
  const avatarClipped = await circleClip(avatarRaw);
  const { width: aw, height: ah } = await sharp(avatarClipped).metadata();

  // Centre the clipped avatar on the image
  const offsetX = Math.round((SIZE - aw!) / 2);
  const offsetY = Math.round((SIZE - ah!) / 2);

  // Simple shadow: slightly offset dark circle
  const shadowR = CIRCLE_RADIUS - CIRCLE_BORDER;
  const shadowSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
       <circle cx="${SIZE / 2 + SHADOW_OFFSET}" cy="${SIZE / 2 + SHADOW_OFFSET}"
               r="${shadowR}" fill="rgba(0,0,0,${SHADOW_OPACITY})"/>
     </svg>`,
  );
  const shadowBuf = await sharp(shadowSvg).blur(SHADOW_BLUR).png().toBuffer();

  const result = await sharp(flagBg)
    .composite([
      { input: shadowBuf },
      { input: circleBg },
      { input: avatarClipped, left: offsetX, top: offsetY },
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

  // White circle backdrop (rendered once, reused for every agent)
  const circleBg = await sharp(Buffer.from(circleBackdropSVG())).png().toBuffer();

  console.log(`Generating ${Object.keys(AGENT_STYLES).length} agent avatars...\n`);
  for (const [agentId, style] of Object.entries(AGENT_STYLES)) {
    await generateAvatar(agentId, style.seed, flagBg, circleBg);
  }

  console.log('\n✅ All avatars generated in assets/avatars/');
  console.log('\nNext steps:');
  console.log('  1. git add assets/avatars/ && git commit -m "feat: professional agent avatars with Aus flag"');
  console.log('  2. git push origin main');
  console.log('  3. Upload to GCS or push to GitHub for AVATAR_MAP URLs.');
}

main().catch((err) => {
  console.error('Avatar generation failed:', err);
  process.exit(1);
});
