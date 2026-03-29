import puppeteer, { Browser, Page } from 'puppeteer';
import { TextChannel, AttachmentBuilder, Collection, Message } from 'discord.js';

/** iPhone 17 Pro Max approximate viewport (6.9" display, 3x retina → logical pixels) */
const VIEWPORT = { width: 440, height: 956, deviceScaleFactor: 3 };
const NAV_TIMEOUT = 15_000;
/** Overall timeout for the entire capture operation (90 seconds) */
const CAPTURE_TIMEOUT = 90_000;

/** Allowed URL patterns for screenshot targets */
const ALLOWED_URL_PATTERNS = [
  // Support current and historical ASAP Cloud Run URL shapes:
  // - asap-<id>.<region>.run.app
  // - asap-<hash>.a.run.app
  /^https:\/\/asap-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app(?:[\/:?#]|$)/i,
  /^https?:\/\/localhost(:\d+)?/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?/,
];

/** Concurrency guard — only one capture at a time */
let captureInProgress = false;

/** All screens/states to capture */
const SCREENS: Array<{ name: string; action?: (page: Page) => Promise<void>; waitFor?: string }> = [
  {
    name: '01-hero',
    waitFor: '.three-background, canvas, [data-testid="hero"]',
  },
  {
    name: '02-hero-loaded',
    // Wait for typewriter + button to appear
    action: async (page) => {
      await page.waitForSelector('text/Dive In', { timeout: 10_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000)); // Let animations settle
    },
  },
  {
    name: '03-support-intake',
    action: async (page) => {
      // Click "Dive In" or "Support" button to go to screen 2
      const btn = await page.$('text/Dive In').catch(() => null)
        || await page.$('text/Support').catch(() => null)
        || await page.$('[data-testid="dive-in"]').catch(() => null);
      if (btn) {
        await btn.click();
        await new Promise((r) => setTimeout(r, 1500));
      }
    },
  },
];

let screenshotsChannel: TextChannel | null = null;

export function setScreenshotsChannel(channel: TextChannel): void {
  screenshotsChannel = channel;
}

/**
 * Clear all messages from the screenshots channel before posting new ones.
 */
async function clearChannel(channel: TextChannel): Promise<void> {
  try {
    for (let iterations = 0; iterations < 20; iterations++) {
      const fetched = await channel.messages.fetch({ limit: 100 });
      if (fetched.size === 0) break;

      // Try bulk delete first (only works for messages < 14 days old)
      try {
        await channel.bulkDelete(fetched, true);
      } catch {
        // bulkDelete failed — delete individually (sequentially for rate limits)
        for (const msg of fetched.values()) {
          await msg.delete().catch(() => {});
        }
      }

      // Verify progress — if nothing was deleted, stop
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
  let browser: Browser | null = null;

  // Overall timeout to prevent hanging forever
  const timeout = setTimeout(() => {
    if (browser) browser.close().catch(() => {});
    browser = null;
  }, CAPTURE_TIMEOUT);

  try {
    const label = sanitizeLabel(buildLabel || new Date().toISOString().slice(0, 19).replace('T', ' '));

    const shouldClear = options?.clearTargetChannel
      ?? (Boolean(screenshotsChannel) && targetChannel.id === screenshotsChannel!.id);
    if (shouldClear) {
      await clearChannel(targetChannel);
    }

    await targetChannel.send(`📸 **Build Screenshots** — ${label}\n🔗 ${appUrl}\nCapturing on iPhone 17 Pro Max (${VIEWPORT.width}×${VIEWPORT.height} @${VIEWPORT.deviceScaleFactor}x)...`);

    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    // Set mobile user agent
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1'
    );

    // Navigate to the app
    await page.goto(appUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
    await new Promise((r) => setTimeout(r, 3000)); // Let initial animations/3D settle

    const attachments: AttachmentBuilder[] = [];

    for (const screen of SCREENS) {
      try {
        // Wait for specific element if specified
        if (screen.waitFor) {
          await page.waitForSelector(screen.waitFor, { timeout: 8000 }).catch(() => {});
        }

        // Run custom action (navigation, clicks, etc.)
        if (screen.action) {
          await screen.action(page);
        }

        // Capture screenshot
        const screenshot = await page.screenshot({
          type: 'png',
          fullPage: false,
        });

        attachments.push(
          new AttachmentBuilder(screenshot as Buffer, { name: `${screen.name}.png` })
        );
      } catch (err) {
        console.error(`Screenshot error for ${screen.name}:`, err instanceof Error ? err.message : 'Unknown');
        await targetChannel.send(`⚠️ Could not capture ${screen.name}`);
      }
    }

    // Post all screenshots to Discord (max 10 per message)
    for (let i = 0; i < attachments.length; i += 10) {
      await targetChannel.send({ files: attachments.slice(i, i + 10) });
    }

    await targetChannel.send(`✅ Captured ${attachments.length}/${SCREENS.length} screens — ${appUrl}`);
  } catch (err) {
    console.error('Screenshot capture error:', err instanceof Error ? err.message : 'Unknown');
    await targetChannel.send(`❌ Screenshot capture failed: ${err instanceof Error ? err.message : 'Unknown'}`);
  } finally {
    clearTimeout(timeout);
    captureInProgress = false;
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
