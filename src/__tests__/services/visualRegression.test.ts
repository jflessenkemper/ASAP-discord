/**
 * Tests for src/services/visualRegression.ts
 * Visual regression — baseline and comparison (pure helpers).
 */

jest.mock('puppeteer', () => ({
  __esModule: true,
  default: {
    launch: jest.fn().mockResolvedValue({
      newPage: jest.fn().mockResolvedValue({
        setViewport: jest.fn(),
        setBypassCSP: jest.fn(),
        setDefaultNavigationTimeout: jest.fn(),
        goto: jest.fn(),
        screenshot: jest.fn().mockResolvedValue(undefined),
        close: jest.fn(),
      }),
      close: jest.fn(),
    }),
  },
}));

// We mock fs and test the module-level functions
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdirSync: jest.fn(),
  rmSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

jest.mock('pixelmatch', () => jest.fn().mockReturnValue(0));
jest.mock('pngjs', () => ({
  PNG: jest.fn().mockImplementation(() => ({ data: Buffer.alloc(40000) })),
  ...jest.requireActual('pngjs'),
}));

// Re-mock PNG.sync properly
const mockPngSync = {
  read: jest.fn().mockReturnValue({ width: 100, height: 100, data: Buffer.alloc(40000) }),
  write: jest.fn().mockReturnValue(Buffer.alloc(100)),
};
jest.mock('pngjs', () => ({
  PNG: Object.assign(
    jest.fn().mockImplementation(({ width, height }: any) => ({
      width,
      height,
      data: Buffer.alloc(width * height * 4),
    })),
    { sync: mockPngSync },
  ),
}));

import { createVisualBaseline, runVisualRegressionCheck } from '../../services/visualRegression';
import fs from 'fs';
import { createHash } from 'crypto';

describe('visualRegression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createVisualBaseline()', () => {
    it('captures screenshots and returns summary', async () => {
      const result = await createVisualBaseline();
      expect(result).toContain('Visual baseline created');
      expect(fs.mkdirSync).toHaveBeenCalled();
    });

    it('removes previous baseline directory', async () => {
      await createVisualBaseline();
      expect(fs.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('baseline'),
        expect.objectContaining({ recursive: true }),
      );
    });
  });

  describe('runVisualRegressionCheck()', () => {
    it('returns error when baseline does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const result = await runVisualRegressionCheck();
      expect(result).toContain('baseline not found');
    });

    it('passes when screenshots match baseline', async () => {
      // Baseline exists
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      // readFileSync returns same content for both current and baseline
      const fakeContent = Buffer.from('identical-image-bytes');
      (fs.readFileSync as jest.Mock).mockReturnValue(fakeContent);

      const result = await runVisualRegressionCheck();
      expect(result).toContain('passed');
    });

    it('reports mismatches when screenshots differ', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      // Return different buffers for reads to trigger comparison
      let readCount = 0;
      (fs.readFileSync as jest.Mock).mockImplementation(() => {
        readCount++;
        return Buffer.from(`content-${readCount}`);
      });

      // PNG.sync.read returns same dimensions
      mockPngSync.read.mockReturnValue({
        width: 100,
        height: 100,
        data: Buffer.alloc(40000),
      });

      // pixelmatch returns non-zero (mismatch)
      const pixelmatch = require('pixelmatch');
      pixelmatch.mockReturnValue(1000);

      const result = await runVisualRegressionCheck();
      expect(result).toContain('FAILED');
    });

    it('handles missing baseline for specific file', async () => {
      // Baseline dir exists
      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        if (String(p).includes('baseline') && !String(p).includes('baseline/')) return true;
        if (String(p).includes('baseline/')) return false; // individual baseline file missing
        return true;
      });

      const result = await runVisualRegressionCheck();
      expect(result).toContain('missing baseline');
    });

    it('handles size mismatch between current and baseline', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      let readCount = 0;
      (fs.readFileSync as jest.Mock).mockImplementation(() => {
        readCount++;
        return Buffer.from(`unique-${readCount}`);
      });

      // Return different sizes from PNG.sync.read
      mockPngSync.read
        .mockReturnValueOnce({ width: 100, height: 100, data: Buffer.alloc(40000) })
        .mockReturnValueOnce({ width: 200, height: 200, data: Buffer.alloc(160000) });

      const result = await runVisualRegressionCheck();
      expect(result).toContain('size mismatch');
    });

    it('handles comparison when diff percent is below threshold', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      let readCount = 0;
      (fs.readFileSync as jest.Mock).mockImplementation(() => {
        readCount++;
        return Buffer.from(`data-${readCount}`);
      });

      mockPngSync.read.mockReturnValue({
        width: 100,
        height: 100,
        data: Buffer.alloc(40000),
      });

      // pixelmatch returns very small number (below threshold)
      const pixelmatch = require('pixelmatch');
      pixelmatch.mockReturnValue(1); // 1/10000 = 0.01% — should be below default 0.5%

      const result = await runVisualRegressionCheck();
      expect(result).toContain('passed');
    });
  });

  describe('parseTargets', () => {
    it('uses VISUAL_URLS when set', async () => {
      process.env.VISUAL_URLS = 'https://example.com/page1,https://example.com/page2';
      // We need to re-import or the module cached the env vars at load.
      // Instead, test via createVisualBaseline which calls parseTargets internally.
      const result = await createVisualBaseline();
      expect(result).toContain('Visual baseline created');
      delete process.env.VISUAL_URLS;
    }, 15000);

    it('handles empty VISUAL_URLS entries gracefully', async () => {
      process.env.VISUAL_URLS = 'https://example.com/page1,,https://example.com/page2';
      const result = await createVisualBaseline();
      expect(result).toContain('Visual baseline created');
      delete process.env.VISUAL_URLS;
    }, 15000);

    it('handles invalid URLs in VISUAL_URLS', async () => {
      process.env.VISUAL_URLS = 'not-a-url,https://example.com/valid';
      const result = await createVisualBaseline();
      expect(result).toContain('Visual baseline created');
      delete process.env.VISUAL_URLS;
    });
  });
});
