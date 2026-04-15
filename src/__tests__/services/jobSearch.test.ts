/**
 * Tests for src/services/jobSearch.ts
 * Job scanning (Adzuna, ATS portals), dedup, filtering, DB CRUD.
 */

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../db/pool', () => ({
  default: { query: mockQuery, on: jest.fn() },
  __esModule: true,
}));

import {
  getListingsByStatus,
  updateListingStatus,
  updateListingByMsgId,
  setListingDiscordMsg,
  updateListingScore,
  getTrackerSummary,
  getProfile,
  upsertProfile,
  getListingById,
  saveDraft,
  guessCompanyEmail,
  getPortalByCompany,
} from '../../services/jobSearch';

describe('jobSearch', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('getListingsByStatus()', () => {
    it('queries by status with limit', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, title: 'Engineer', status: 'scanned' }] });
      const result = await getListingsByStatus('scanned', 10);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE status = $1'),
        ['scanned', 10],
      );
      expect(result).toHaveLength(1);
    });

    it('uses default limit of 20', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await getListingsByStatus('evaluated');
      expect(mockQuery).toHaveBeenCalledWith(expect.anything(), ['evaluated', 20]);
    });
  });

  describe('updateListingStatus()', () => {
    it('updates status by listing ID', async () => {
      await updateListingStatus(42, 'applied');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE job_listings SET status'),
        ['applied', 42],
      );
    });
  });

  describe('updateListingByMsgId()', () => {
    it('updates by discord message ID and returns listing', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, status: 'applied' }] });
      const result = await updateListingByMsgId('msg-123', 'applied');
      expect(result).toEqual({ id: 1, status: 'applied' });
    });

    it('returns null when no match', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await updateListingByMsgId('no-match', 'applied');
      expect(result).toBeNull();
    });
  });

  describe('setListingDiscordMsg()', () => {
    it('sets discord_msg_id on listing', async () => {
      await setListingDiscordMsg(5, 'msg-456');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('discord_msg_id = $1'),
        ['msg-456', 5],
      );
    });
  });

  describe('updateListingScore()', () => {
    it('updates score and evaluation', async () => {
      await updateListingScore(10, 85, 'Great match');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('score = $1'),
        [85, 'Great match', 'evaluated', 10],
      );
    });
  });

  describe('getTrackerSummary()', () => {
    it('returns status counts', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { status: 'scanned', count: 10 },
          { status: 'evaluated', count: 5 },
          { status: 'applied', count: 2 },
        ],
      });
      const summary = await getTrackerSummary();
      expect(summary).toEqual({ scanned: 10, evaluated: 5, applied: 2 });
    });

    it('returns empty object when no listings', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const summary = await getTrackerSummary();
      expect(summary).toEqual({});
    });
  });

  describe('getProfile()', () => {
    it('returns profile when found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'owner', first_name: 'Jordan' }] });
      const profile = await getProfile();
      expect(profile).toEqual({ user_id: 'owner', first_name: 'Jordan' });
    });

    it('returns null when no profile', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const profile = await getProfile();
      expect(profile).toBeNull();
    });
  });

  describe('upsertProfile()', () => {
    it('inserts when no existing profile', async () => {
      // First query: SELECT (getProfile) returns nothing
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Second query: INSERT
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      await upsertProfile({ first_name: 'Jordan', location: 'NSW' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const insertCall = mockQuery.mock.calls[1];
      expect(insertCall[0]).toContain('INSERT INTO job_profile');
    });

    it('updates when profile exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'owner' }] });
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      await upsertProfile({ location: 'Melbourne' });
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain('UPDATE job_profile');
    });
  });

  describe('getListingById()', () => {
    it('returns listing when found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, title: 'Dev' }] });
      const listing = await getListingById(1);
      expect(listing).toEqual({ id: 1, title: 'Dev' });
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const listing = await getListingById(999);
      expect(listing).toBeNull();
    });
  });

  describe('saveDraft()', () => {
    it('saves cover letter and resume', async () => {
      await saveDraft(1, 'Dear hiring manager...', 'Skills: TypeScript...');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('cover_letter'),
        ['Dear hiring manager...', 'Skills: TypeScript...', 1],
      );
    });
  });

  describe('guessCompanyEmail()', () => {
    it('derives email from portal careers_url', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ company_name: 'Canva', careers_url: 'https://www.canva.com/careers/' }],
      });
      const email = await guessCompanyEmail('Canva');
      expect(email).toBe('careers@canva.com');
    });

    it('falls back to company name slug', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const email = await guessCompanyEmail('My Company');
      expect(email).toBe('careers@mycompany.com');
    });
  });

  describe('getPortalByCompany()', () => {
    it('returns portal data', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ company_name: 'Canva', api_type: 'greenhouse', api_url: 'https://boards-api.greenhouse.io/v1/boards/canva/jobs' }],
      });
      const portal = await getPortalByCompany('Canva');
      expect(portal).toBeDefined();
      expect(portal!.api_type).toBe('greenhouse');
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const portal = await getPortalByCompany('Unknown Corp');
      expect(portal).toBeNull();
    });
  });
});
