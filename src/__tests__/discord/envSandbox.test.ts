/**
 * Tests for environment variable sandboxing (envSandbox.ts).
 * Ensures secrets are never leaked to child processes.
 */
import { buildSafeCommandEnv, buildGcpSafeEnv, SAFE_ENV_KEYS, GCP_ENV_PREFIXES } from '../../discord/envSandbox';

describe('buildSafeCommandEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      // Safe keys that SHOULD pass through
      PATH: '/usr/bin:/usr/local/bin',
      HOME: '/home/test',
      USER: 'test',
      SHELL: '/bin/bash',
      TERM: 'xterm',
      LANG: 'en_US.UTF-8',
      AGENT_REPO_ROOT: '/opt/app',
      // Secrets that MUST NOT pass through
      DISCORD_TOKEN: 'secret-discord-token',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENAI_API_KEY: 'sk-openai-secret',
      DATABASE_URL: 'postgres://user:pass@host/db',
      DB_PASSWORD: 'supersecret',
      TWILIO_AUTH_TOKEN: 'twilio-secret',
      GEMINI_API_KEY: 'gemini-secret',
      ADZUNA_API_KEY: 'adzuna-secret',
      GREENHOUSE_API_KEY: 'greenhouse-secret',
      MY_CUSTOM_SECRET: 'should-not-leak',
      PGPASSWORD: 'pg-password',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('includes PATH, HOME, USER, SHELL', () => {
    const env = buildSafeCommandEnv();
    expect(env.PATH).toBe('/usr/bin:/usr/local/bin');
    expect(env.HOME).toBe('/home/test');
    expect(env.USER).toBe('test');
    expect(env.SHELL).toBe('/bin/bash');
  });

  test('always sets NODE_ENV to development', () => {
    const env = buildSafeCommandEnv();
    expect(env.NODE_ENV).toBe('development');
  });

  test('includes AGENT_REPO_ROOT', () => {
    const env = buildSafeCommandEnv();
    expect(env.AGENT_REPO_ROOT).toBe('/opt/app');
  });

  test('strips DISCORD_TOKEN', () => {
    const env = buildSafeCommandEnv();
    expect(env.DISCORD_TOKEN).toBeUndefined();
  });

  test('strips ANTHROPIC_API_KEY', () => {
    const env = buildSafeCommandEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test('strips DATABASE_URL', () => {
    const env = buildSafeCommandEnv();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  test('strips DB_PASSWORD', () => {
    const env = buildSafeCommandEnv();
    expect(env.DB_PASSWORD).toBeUndefined();
  });

  test('strips PGPASSWORD', () => {
    const env = buildSafeCommandEnv();
    expect(env.PGPASSWORD).toBeUndefined();
  });

  test('strips OPENAI_API_KEY', () => {
    const env = buildSafeCommandEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  test('strips TWILIO_AUTH_TOKEN', () => {
    const env = buildSafeCommandEnv();
    expect(env.TWILIO_AUTH_TOKEN).toBeUndefined();
  });

  test('strips GEMINI_API_KEY', () => {
    const env = buildSafeCommandEnv();
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  test('strips arbitrary non-allowlisted keys', () => {
    const env = buildSafeCommandEnv();
    expect(env.MY_CUSTOM_SECRET).toBeUndefined();
    expect(env.ADZUNA_API_KEY).toBeUndefined();
    expect(env.GREENHOUSE_API_KEY).toBeUndefined();
  });

  test('skips entries with undefined values', () => {
    process.env.PATH = undefined;
    const env = buildSafeCommandEnv();
    expect(env.PATH).toBeUndefined();
  });

  test('only contains keys from the safe allowlist (+ NODE_ENV)', () => {
    const env = buildSafeCommandEnv();
    for (const key of Object.keys(env)) {
      if (key === 'NODE_ENV') continue;
      expect(SAFE_ENV_KEYS.has(key)).toBe(true);
    }
  });
});

describe('buildGcpSafeEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PATH: '/usr/bin',
      HOME: '/home/test',
      GOOGLE_CLOUD_PROJECT: 'my-project',
      GOOGLE_APPLICATION_CREDENTIALS: '/path/to/sa.json',
      GCLOUD_PROJECT: 'my-gcloud-project',
      CLOUDSDK_CORE_PROJECT: 'sdk-project',
      CLOUD_RUN_REGION: 'us-central1',
      GCS_PROJECT_ID: 'gcs-proj',
      DISCORD_TOKEN: 'secret',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('includes safe base env', () => {
    const env = buildGcpSafeEnv();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/test');
  });

  test('includes GOOGLE_ prefixed vars', () => {
    const env = buildGcpSafeEnv();
    expect(env.GOOGLE_CLOUD_PROJECT).toBe('my-project');
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/path/to/sa.json');
  });

  test('includes GCLOUD_ prefixed vars', () => {
    const env = buildGcpSafeEnv();
    expect(env.GCLOUD_PROJECT).toBe('my-gcloud-project');
  });

  test('includes CLOUDSDK_ prefixed vars', () => {
    const env = buildGcpSafeEnv();
    expect(env.CLOUDSDK_CORE_PROJECT).toBe('sdk-project');
  });

  test('includes CLOUD_RUN_ prefixed vars', () => {
    const env = buildGcpSafeEnv();
    expect(env.CLOUD_RUN_REGION).toBe('us-central1');
  });

  test('includes GCS_ prefixed vars', () => {
    const env = buildGcpSafeEnv();
    expect(env.GCS_PROJECT_ID).toBe('gcs-proj');
  });

  test('skips GCP entries with undefined values', () => {
    process.env.GOOGLE_CLOUD_PROJECT = undefined;
    const env = buildGcpSafeEnv();
    expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
  });

  test('still strips non-GCP secrets', () => {
    const env = buildGcpSafeEnv();
    expect(env.DISCORD_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
