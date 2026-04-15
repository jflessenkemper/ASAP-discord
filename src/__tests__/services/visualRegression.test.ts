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
  PNG: {
    sync: {
      read: jest.fn().mockReturnValue({ width: 100, height: 100, data: Buffer.alloc(40000) }),
      write: jest.fn().mockReturnValue(Buffer.alloc(100)),
    },
  },
}));

import { createVisualBaseline, runVisualRegressionCheck } from '../../services/visualRegression';
import fs from 'fs';

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
  });

  describe('runVisualRegressionCheck()', () => {
    it('returns error when baseline does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const result = await runVisualRegressionCheck();
      expect(result).toContain('baseline not found');
    });
  });
});
