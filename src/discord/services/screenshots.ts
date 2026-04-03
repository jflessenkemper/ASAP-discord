import puppeteer, { Browser, Page } from 'puppeteer';
import { TextChannel, AttachmentBuilder, Collection, Message } from 'discord.js';
import { postAgentErrorLog } from './agentErrors';
import { PUPPETEER_LAUNCH_ARGS, resolvePuppeteerExecutablePath } from './browserRuntime';

/** iPhone 17 Pro Max approximate viewport (6.9" display, 3x retina → logical pixels) */
const VIEWPORT = { width: 440, height: 956, deviceScaleFactor: 3 };
const NAV_TIMEOUT = parseInt(process.env.SCREENSHOT_NAV_TIMEOUT_MS || '30000', 10);
/** Overall timeout for the entire capture operation (90 seconds) */
const CAPTURE_TIMEOUT = 90_000;

/** Allowed URL patterns for screenshot targets */
const ALLOWED_URL_PATTERNS = [
  /^https:\/\/asap-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app(?:[\/:?#]|$)/i,
  /^https?:\/\/localhost(:\d+)?/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?/,
];

/** Concurrency guard — only one capture at a time */
let captureInProgress = false;
let browserPool: Browser | null = null;
let browserPoolTimer: ReturnType<typeof setTimeout> | null = null;
const BROWSER_POOL_IDLE_MS = parseInt(process.env.SCREENSHOT_BROWSER_POOL_IDLE_MS || '180000', 10);

/** All screens/states to capture */
const SCREENS: Array<{ name: string; action?: (page: Page) => Promise<void>; waitFor?: string }> = [
  {
    name: '01-hero',
    waitFor: '.three-background, canvas, [data-testid="hero"]',
  },
  {
    name: '02-hero-loaded',
    action: async (page) => {
      await page.waitForSelector('text/Dive In', { timeout: 10_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000)); // Let animations settle
    },
  },
  {
    name: '03-map-screen',
    action: async (page) => {
      const btn = await page.$('text/Dive In').catch(() => null)
        || await page.$('text/Support').catch(() => null)
        || await page.$('[data-testid="dive-in"]').catch(() => null);
      if (btn) {
        await btn.click();
        await new Promise((r) => setTimeout(r, 2200));
      }
    },
    waitFor: '.screen2-map, .gm-style, iframe[title="ASAP map fallback"]',
  },
  {
    name: '04-map-dashboard',
    action: async (page) => {
      await new Promise((r) => setTimeout(r, 1600));
    },
    waitFor: '.screen2-map, .gm-style, iframe[title="ASAP map fallback"]',
  },
];

let screenshotsChannel: TextChannel | null = null;

export function setScreenshotsChannel(channel: TextChannel): void {
  screenshotsChannel = channel;
}

async function getPooledBrowser(): Promise<Browser> {
  if (browserPool) {
    if (browserPoolTimer) clearTimeout(browserPoolTimer);
    browserPoolTimer = null;
    return browserPool;
  }

  browserPool = await puppeteer.launch({
    headless: true,
    executablePath: resolvePuppeteerExecutablePath(),
    args: [...PUPPETEER_LAUNCH_ARGS],
  });
  return browserPool;
}

function scheduleBrowserPoolClose(): void {
  if (browserPoolTimer) clearTimeout(browserPoolTimer);
  browserPoolTimer = setTimeout(() => {
    if (!browserPool) return;
    browserPool.close().catch(() => {});
    browserPool = null;
    browserPoolTimer = null;
  }, BROWSER_POOL_IDLE_MS);
}

/**
 * Navigation helper tuned for SPAs/websocket apps where networkidle can hang.
 * First attempt: domcontentloaded (fast + resilient).
 * Retry: load with extended timeout if the first attempt times out.
 */
async function navigateForScreenshot(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes('timeout')) throw err;
    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT + 15000 });
  }

  await page.waitForNetworkIdle({ idleTime: 1200, timeout: 5000 }).catch(() => {});
}

/**
 * Clear all messages from the screenshots channel before posting new ones.
 */
async function clearChannel(channel: TextChannel): Promise<void> {
  try {
    for (let iterations = 0; iterations < 20; iterations++) {
      const fetched = await channel.messages.fetch({ limit: 100 });
      if (fetched.size === 0) break;

      try {
        await channel.bulkDelete(fetched, true);
      } catch {
        for (const msg of fetched.values()) {
          await msg.delete().catch(() => {});
        }
      }

      const remaining = await channel.messages.fetch({ limit: 100 });
      if (remaining.size >= fetched.size) break;
    }
  } catch (err) {
    console.warn('Could not clear screenshots channel:', err instanceof Error ? err.message : 'Unknown');
  }
}

/**
 * Capture screenshots of every screen in the app and post them to Discord.
 * Runs headless Chromium sized to iPhone 17 Pro Max.
 * URL must match the allowlist. Only one capture runs at a time.
 */

/** Validate that a URL is allowed for screenshotting */
function isAllowedUrl(url: string): boolean {
  return ALLOWED_URL_PATTERNS.some((pattern) => pattern.test(url));
}

/** Sanitize label to prevent Discord mention injection */
function sanitizeLabel(label: string): string {
  return label
    .replace(/@(everyone|here)/gi, '[at-$1]')
    .replace(/<@[!&]?\d+>/g, '[mention]')
    .slice(0, 100);
}

export async function captureAndPostScreenshots(
  appUrl: string,
  buildLabel?: string,
  options?: { targetChannel?: TextChannel; clearTargetChannel?: boolean }
): Promise<void> {
  const targetChannel = options?.targetChannel || screenshotsChannel;
  if (!targetChannel) {
    console.warn('Screenshots channel not configured — skipping capture');
    return;
  }

  if (!isAllowedUrl(appUrl)) {
    await targetChannel.send(`❌ Screenshot refused — URL not in allowlist: ${appUrl.slice(0, 100)}`);
    return;
  }

  if (captureInProgress) {
    await targetChannel.send('⏳ Screenshot capture already in progress — skipping.');
    return;
  }

  captureInProgress = true;
  let page: Page | null = null;

  const timeout = setTimeout(() => {
    if (page) page.close().catch(() => {});
    page = null;
  }, CAPTURE_TIMEOUT);

  try {
    const label = sanitizeLabel(buildLabel || new Date().toISOString().slice(0, 19).replace('T', ' '));

    const shouldClear = options?.clearTargetChannel
      ?? (Boolean(screenshotsChannel) && targetChannel.id === screenshotsChannel!.id);
    if (shouldClear) {
      await clearChannel(targetChannel);
    }

    await targetChannel.send(`📸 **Build Screenshots** — ${label}\n🔗 ${appUrl}\nCapturing on iPhone 17 Pro Max (${VIEWPORT.width}×${VIEWPORT.height} @${VIEWPORT.deviceScaleFactor}x)...`);

    const browser = await getPooledBrowser();
    page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1'
    );

    await navigateForScreenshot(page, appUrl);
    await new Promise((r) => setTimeout(r, 3000)); // Let initial animations/3D settle

    const attachments: AttachmentBuilder[] = [];

    for (const screen of SCREENS) {
      try {
        if (screen.waitFor) {
          await page.waitForSelector(screen.waitFor, { timeout: 8000 }).catch(() => {});
        }

        if (screen.action) {
          await screen.action(page);
        }

        const screenshot = await page.screenshot({
          type: 'png',
          fullPage: false,
        });

        attachments.push(
          new AttachmentBuilder(screenshot as Buffer, { name: `${screen.name}.png` })
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown';
        console.error(`Screenshot error for ${screen.name}:`, msg);
        void postAgentErrorLog('screenshots', `Could not capture ${screen.name}`, {
          level: 'warn',
          detail: msg,
        });
        await targetChannel.send(`⚠️ Could not capture ${screen.name}`);
      }
    }

    for (let i = 0; i < attachments.length; i += 10) {
      await targetChannel.send({ files: attachments.slice(i, i + 10) });
    }

    await targetChannel.send(`✅ Captured ${attachments.length}/${SCREENS.length} screens — ${appUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown';
    console.error('Screenshot capture error:', msg);
    void postAgentErrorLog('screenshots', 'Screenshot capture failed', { detail: msg });
    await targetChannel.send(`❌ Screenshot capture failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
    captureInProgress = false;
    if (page) {
      await page.close().catch(() => {});
    }
    scheduleBrowserPoolClose();
  }
}
