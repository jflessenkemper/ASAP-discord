import puppeteer, { Browser, Page } from 'puppeteer';
import { AttachmentBuilder, TextChannel } from 'discord.js';

const VIEWPORT = { width: 440, height: 956, deviceScaleFactor: 3 };
const NAV_TIMEOUT = 30_000;

const ALLOWED_URL_PATTERNS = [
  // Accept both regional and hashed Cloud Run hostnames used by ASAP.
  /^https:\/\/asap-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app(?:[\/:?#]|$)/i,
  /^https?:\/\/localhost(:\d+)?/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?/,
];

type HarnessAction = 'tap' | 'type' | 'wait' | 'goto' | 'key' | 'back';

interface HarnessSession {
  browser: Browser;
  page: Page;
  lastUrl: string;
  startedAt: number;
}

const sessions = new Map<string, HarnessSession>();

function isAllowedUrl(url: string): boolean {
  return ALLOWED_URL_PATTERNS.some((pattern) => pattern.test(url));
}

function sanitizeLabel(label: string): string {
  return label
    .replace(/@(everyone|here)/gi, '[at-$1]')
    .replace(/<@[!&]?\d+>/g, '[mention]')
    .slice(0, 100);
}

function requireSession(sessionId: string): HarnessSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('No active mobile harness session. Start one with mobile_harness_start first.');
  }
  return session;
}

async function postSnapshot(channel: TextChannel | undefined, page: Page, label: string): Promise<void> {
  if (!channel) return;
  const screenshot = await page.screenshot({ type: 'png', fullPage: false });
  const safe = sanitizeLabel(label).replace(/\s+/g, '-').toLowerCase();
  const file = new AttachmentBuilder(screenshot as Buffer, { name: `${safe || 'harness'}.png` });
  await channel.send({ content: `📱 Harness snapshot: ${sanitizeLabel(label)}`, files: [file] });
}

function launchArgs(): string[] {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ];
}

async function createPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1'
  );
  return page;
}

export async function mobileHarnessStart(
  sessionId: string,
  appUrl: string,
  channel?: TextChannel,
  label?: string
): Promise<string> {
  if (!isAllowedUrl(appUrl)) {
    throw new Error(`URL not allowed for mobile harness: ${appUrl.slice(0, 100)}`);
  }

  await mobileHarnessStop(sessionId).catch(() => {});

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: launchArgs(),
  });

  const page = await createPage(browser);
  await page.goto(appUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
  await new Promise((r) => setTimeout(r, 1200));

  sessions.set(sessionId, {
    browser,
    page,
    lastUrl: appUrl,
    startedAt: Date.now(),
  });

  await postSnapshot(channel, page, label || 'harness-start');
  return `Mobile harness started for ${sessionId} at ${appUrl}`;
}

export async function mobileHarnessStep(
  sessionId: string,
  input: {
    action: HarnessAction;
    selector?: string;
    text?: string;
    ms?: number;
    url?: string;
    key?: string;
  },
  channel?: TextChannel,
  label?: string
): Promise<string> {
  const session = requireSession(sessionId);
  const { page } = session;

  switch (input.action) {
    case 'tap': {
      if (!input.selector) throw new Error('tap action requires selector');
      await page.waitForSelector(input.selector, { timeout: 8000 });
      await page.click(input.selector);
      await new Promise((r) => setTimeout(r, 900));
      break;
    }
    case 'type': {
      if (!input.selector) throw new Error('type action requires selector');
      const text = input.text ?? '';
      await page.waitForSelector(input.selector, { timeout: 8000 });
      await page.click(input.selector, { clickCount: 3 });
      await page.keyboard.press('Backspace');
      if (text.length > 0) {
        await page.type(input.selector, text, { delay: 20 });
      }
      await new Promise((r) => setTimeout(r, 400));
      break;
    }
    case 'wait': {
      const ms = Math.min(Math.max(Number(input.ms || 500), 100), 10_000);
      await new Promise((r) => setTimeout(r, ms));
      break;
    }
    case 'goto': {
      const url = input.url || session.lastUrl;
      if (!isAllowedUrl(url)) throw new Error(`URL not allowed for mobile harness: ${url.slice(0, 100)}`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
      session.lastUrl = url;
      await new Promise((r) => setTimeout(r, 800));
      break;
    }
    case 'key': {
      const key = input.key || 'Enter';
      await page.keyboard.press(key as any);
      await new Promise((r) => setTimeout(r, 300));
      break;
    }
    case 'back': {
      await page.goBack({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(async () => {
        await page.evaluate(() => {
          const h = (globalThis as any).history;
          if (h && typeof h.back === 'function') h.back();
        });
      });
      await new Promise((r) => setTimeout(r, 800));
      break;
    }
    default:
      throw new Error(`Unsupported harness action: ${String(input.action)}`);
  }

  await postSnapshot(channel, page, label || `harness-${input.action}`);
  return `Harness action completed: ${input.action}`;
}

export async function mobileHarnessSnapshot(
  sessionId: string,
  channel?: TextChannel,
  label?: string
): Promise<string> {
  const session = requireSession(sessionId);
  await postSnapshot(channel, session.page, label || 'harness-snapshot');
  return 'Harness snapshot captured';
}

export async function mobileHarnessStop(sessionId: string): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return `No active mobile harness session for ${sessionId}`;

  sessions.delete(sessionId);
  await session.browser.close().catch(() => {});
  const runtimeSec = Math.max(1, Math.round((Date.now() - session.startedAt) / 1000));
  return `Mobile harness stopped for ${sessionId} (${runtimeSec}s)`;
}
