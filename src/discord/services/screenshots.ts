import puppeteer, { Browser, Page } from 'puppeteer';
import { TextChannel, AttachmentBuilder, Collection, Message } from 'discord.js';

/** iPhone 17 Pro Max approximate viewport (6.9" display, 3x retina → logical pixels) */
const VIEWPORT = { width: 440, height: 956, deviceScaleFactor: 3 };
const NAV_TIMEOUT = 15_000;

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
  {
    name: '04-darkmorphism-showcase',
    // Need to go back to hero first, then do the secret combo
    action: async (page) => {
      // Reload to get back to hero
      await page.goto(page.url(), { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
      await new Promise((r) => setTimeout(r, 2000));
      // The top panel is triggered by a click sequence — hard to automate the exact combo
      // Just screenshot whatever is visible
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
    let fetched: Collection<string, Message>;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      if (fetched.size > 0) {
        await channel.bulkDelete(fetched, true).catch(async () => {
          // bulkDelete fails for messages > 14 days old — delete individually
          for (const msg of fetched.values()) {
            await msg.delete().catch(() => {});
          }
        });
      }
    } while (fetched.size >= 2);
  } catch (err) {
    console.warn('Could not clear screenshots channel:', err instanceof Error ? err.message : 'Unknown');
  }
}

/**
 * Capture screenshots of every screen in the app and post them to Discord.
 * Runs headless Chromium sized to iPhone 17 Pro Max.
 */
export async function captureAndPostScreenshots(
  appUrl: string,
  buildLabel?: string
): Promise<void> {
  if (!screenshotsChannel) {
    console.warn('Screenshots channel not configured — skipping capture');
    return;
  }

  let browser: Browser | null = null;

  try {
    const label = buildLabel || new Date().toISOString().slice(0, 19).replace('T', ' ');

    // Clear old screenshots before posting new ones
    await clearChannel(screenshotsChannel);

    await screenshotsChannel.send(`📸 **Build Screenshots** — ${label}\n🔗 ${appUrl}\nCapturing on iPhone 17 Pro Max (${VIEWPORT.width}×${VIEWPORT.height} @${VIEWPORT.deviceScaleFactor}x)...`);

    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--single-process',
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
        await screenshotsChannel.send(`⚠️ Could not capture ${screen.name}`);
      }
    }

    // Post all screenshots to Discord (max 10 per message)
    for (let i = 0; i < attachments.length; i += 10) {
      await screenshotsChannel.send({ files: attachments.slice(i, i + 10) });
    }

    await screenshotsChannel.send(`✅ Captured ${attachments.length}/${SCREENS.length} screens — ${appUrl}`);
  } catch (err) {
    console.error('Screenshot capture error:', err instanceof Error ? err.message : 'Unknown');
    await screenshotsChannel?.send(`❌ Screenshot capture failed: ${err instanceof Error ? err.message : 'Unknown'}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
