jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: jest.fn().mockRejectedValue(new Error('Could not load the default credentials')),
  })),
}));

import { getGoogleCredentialBootstrapState } from '../../services/googleCredentials';

describe('googleCredentials', () => {
  describe('getGoogleCredentialBootstrapState', () => {
    it('returns the bootstrap state object', () => {
      const state = getGoogleCredentialBootstrapState();
      expect(state).toHaveProperty('attempted');
      expect(state).toHaveProperty('path');
      expect(typeof state.attempted).toBe('boolean');
    });
  });
});
