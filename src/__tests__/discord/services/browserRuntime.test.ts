import fs from 'fs';

jest.mock('puppeteer', () => ({
  executablePath: jest.fn(),
}));

import { PUPPETEER_LAUNCH_ARGS, resolvePuppeteerExecutablePath } from '../../../discord/services/browserRuntime';
import puppeteer from 'puppeteer';

describe('browserRuntime', () => {
  const originalEnv = process.env.PUPPETEER_EXECUTABLE_PATH;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PUPPETEER_EXECUTABLE_PATH = originalEnv;
    } else {
      delete process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    jest.restoreAllMocks();
  });

  describe('PUPPETEER_LAUNCH_ARGS', () => {
    it('includes --no-sandbox', () => {
      expect(PUPPETEER_LAUNCH_ARGS).toContain('--no-sandbox');
    });

    it('includes --disable-setuid-sandbox', () => {
      expect(PUPPETEER_LAUNCH_ARGS).toContain('--disable-setuid-sandbox');
    });

    it('is a readonly array', () => {
      expect(Array.isArray(PUPPETEER_LAUNCH_ARGS)).toBe(true);
      expect(PUPPETEER_LAUNCH_ARGS.length).toBeGreaterThan(0);
    });
  });

  describe('resolvePuppeteerExecutablePath', () => {
    it('uses PUPPETEER_EXECUTABLE_PATH env var when file exists', () => {
      process.env.PUPPETEER_EXECUTABLE_PATH = '/usr/bin/test-chrome';
      jest.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/usr/bin/test-chrome');
      expect(resolvePuppeteerExecutablePath()).toBe('/usr/bin/test-chrome');
    });

    it('falls back to common paths when env var file does not exist', () => {
      process.env.PUPPETEER_EXECUTABLE_PATH = '/nonexistent';
      jest.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/usr/bin/chromium');
      expect(resolvePuppeteerExecutablePath()).toBe('/usr/bin/chromium');
    });

    it('tries all common browser paths in order', () => {
      delete process.env.PUPPETEER_EXECUTABLE_PATH;
      jest.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/usr/bin/google-chrome-stable');
      expect(resolvePuppeteerExecutablePath()).toBe('/usr/bin/google-chrome-stable');
    });

    it('uses puppeteer bundled path as fallback', () => {
      delete process.env.PUPPETEER_EXECUTABLE_PATH;
      const existsSyncSpy = jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
        return p === '/bundled/chrome';
      });
      (puppeteer.executablePath as jest.Mock).mockReturnValue('/bundled/chrome');
      expect(resolvePuppeteerExecutablePath()).toBe('/bundled/chrome');
      existsSyncSpy.mockRestore();
    });

    it('throws when no browser is found', () => {
      delete process.env.PUPPETEER_EXECUTABLE_PATH;
      jest.spyOn(fs, 'existsSync').mockReturnValue(false);
      (puppeteer.executablePath as jest.Mock).mockReturnValue('');
      expect(() => resolvePuppeteerExecutablePath()).toThrow('Chrome/Chromium is not available');
    });

    it('handles puppeteer.executablePath throwing', () => {
      delete process.env.PUPPETEER_EXECUTABLE_PATH;
      jest.spyOn(fs, 'existsSync').mockReturnValue(false);
      (puppeteer.executablePath as jest.Mock).mockImplementation(() => { throw new Error('no browser'); });
      expect(() => resolvePuppeteerExecutablePath()).toThrow('Chrome/Chromium is not available');
    });
  });
});
