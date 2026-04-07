import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import puppeteer, { Browser, Page } from 'puppeteer';

interface CaptureTarget {
  name: string;
  url: string;
}

interface ViewportTarget {
  name: string;
  width: number;
  height: number;
  isMobile?: boolean;
  deviceScaleFactor?: number;
}

const VIEWPORTS: ViewportTarget[] = [
  { name: 'desktop', width: 1440, height: 900, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', width: 430, height: 932, isMobile: true, deviceScaleFactor: 2 },
];

const ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACTS_DIR = path.join(ROOT, 'visual-regression');
const BASELINE_DIR = path.join(ARTIFACTS_DIR, 'baseline');
const CURRENT_DIR = path.join(ARTIFACTS_DIR, 'current');

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/(^-|-$)/g, '');
}

function parseTargets(): CaptureTarget[] {
  const urls = String(process.env.VISUAL_URLS || '').trim();
  if (!urls) {
    const fallback = process.env.FRONTEND_URL || 'https://asap-ud54h56rna-ts.a.run.app';
    return [{ name: 'home', url: fallback }];
  }

  return urls
    .split(',')
    .map((v, idx) => {
      const raw = v.trim();
      if (!raw) return null;
      try {
        const parsed = new URL(raw);
        const name = normalizeName(parsed.pathname.replace(/\//g, '-') || `page-${idx + 1}`) || `page-${idx + 1}`;
        return { name, url: parsed.toString() };
      } catch {
        return null;
      }
    })
    .filter((v): v is CaptureTarget => !!v);
}

async function withPage(browser: Browser, viewport: ViewportTarget): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    isMobile: !!viewport.isMobile,
    deviceScaleFactor: viewport.deviceScaleFactor || 1,
  });
  await page.setBypassCSP(true);
  await page.setDefaultNavigationTimeout(30_000);
  return page;
}

function fileHash(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function captureSet(outDir: string): Promise<string[]> {
  ensureDir(outDir);
  const targets = parseTargets();
  if (targets.length === 0) {
    throw new Error('No valid visual regression targets. Set VISUAL_URLS to comma-separated URLs.');
  }

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const written: string[] = [];
  try {
    for (const target of targets) {
      for (const viewport of VIEWPORTS) {
        const page = await withPage(browser, viewport);
        try {
          await page.goto(target.url, { waitUntil: 'networkidle2' });
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const filename = `${normalizeName(target.name)}.${viewport.name}.png`;
          const outPath = path.join(outDir, filename);
          await page.screenshot({ path: outPath, fullPage: true });
          written.push(outPath);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  return written;
}

export async function createVisualBaseline(): Promise<string> {
  ensureDir(ARTIFACTS_DIR);
  fs.rmSync(BASELINE_DIR, { recursive: true, force: true });
  ensureDir(BASELINE_DIR);
  const files = await captureSet(BASELINE_DIR);
  return `Visual baseline created: ${files.length} screenshot(s) in ${BASELINE_DIR}`;
}

export async function runVisualRegressionCheck(): Promise<string> {
  ensureDir(ARTIFACTS_DIR);
  if (!fs.existsSync(BASELINE_DIR)) {
    return 'Visual baseline not found. Run `npm run visual:baseline` first.';
  }

  fs.rmSync(CURRENT_DIR, { recursive: true, force: true });
  ensureDir(CURRENT_DIR);
  const currentFiles = await captureSet(CURRENT_DIR);

  const mismatches: string[] = [];
  for (const currentPath of currentFiles) {
    const filename = path.basename(currentPath);
    const baselinePath = path.join(BASELINE_DIR, filename);
    if (!fs.existsSync(baselinePath)) {
      mismatches.push(`${filename}: missing baseline`);
      continue;
    }
    if (fileHash(currentPath) !== fileHash(baselinePath)) {
      mismatches.push(`${filename}: pixel output changed`);
    }
  }

  if (mismatches.length === 0) {
    return `Visual regression passed: ${currentFiles.length} screenshot(s) matched baseline.`;
  }

  return [
    `Visual regression FAILED: ${mismatches.length} mismatch(es).`,
    ...mismatches.map((m) => `- ${m}`),
    `Current: ${CURRENT_DIR}`,
    `Baseline: ${BASELINE_DIR}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const mode = String(process.argv[2] || 'check').toLowerCase();
  const output = mode === 'baseline'
    ? await createVisualBaseline()
    : await runVisualRegressionCheck();
  console.log(output);
  if (mode !== 'baseline' && output.startsWith('Visual regression FAILED')) {
    process.exitCode = 1;
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
