import fs from 'fs';
import puppeteer from 'puppeteer';

export const PUPPETEER_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
] as const;

const COMMON_BROWSER_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

export function resolvePuppeteerExecutablePath(): string {
  const explicit = (process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  for (const candidate of COMMON_BROWSER_PATHS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const bundled = puppeteer.executablePath();
    if (bundled && fs.existsSync(bundled)) {
      return bundled;
    }
  } catch {
  }

  throw new Error(
    'Chrome/Chromium is not available for Puppeteer. Install it with `npx puppeteer browsers install chrome` or set PUPPETEER_EXECUTABLE_PATH.'
  );
}
