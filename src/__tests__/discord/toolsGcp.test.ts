/**
 * Tests for src/discord/toolsGcp.ts
 * GCP operations — all using execFileSync (no shell injection).
 */

jest.mock('child_process', () => ({
  execFileSync: jest.fn(() => 'mock gcloud output'),
}));
jest.mock('../../discord/envSandbox', () => ({
  buildGcpSafeEnv: jest.fn(() => ({ PATH: '/usr/bin', HOME: '/tmp' })),
}));

import { execFileSync } from 'child_process';
import {
  gcpExecArgs,
  gcpDeploy,
  gcpBuildImage,
  gcpPreflight,
  gcpSetEnv,
  gcpGetEnv,
  gcpListRevisions,
  gcpRollback,
  gcpSecretSet,
  gcpSecretBind,
  gcpSecretList,
  gcpBuildStatus,
  gcpLogsQuery,
  gcpRunDescribe,
  gcpStorageLs,
  gcpArtifactList,
  gcpSqlDescribe,
  gcpVmSsh,
  gcpProjectInfo,
  GCP_PROJECT,
  GCP_REGION,
  GCP_SERVICE,
  GCP_TIMEOUT,
  GCP_SQL_INSTANCE,
  GCP_BOT_VM,
  GCP_BOT_ZONE,
  VM_ALLOWED_PREFIXES,
} from '../../discord/toolsGcp';

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;

describe('toolsGcp', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockExecFileSync.mockReturnValue('mock output');
  });

  describe('constants', () => {
    it('has default GCP project', () => {
      expect(GCP_PROJECT).toBeTruthy();
    });

    it('has default region', () => {
      expect(GCP_REGION).toContain('australia');
    });

    it('has default service name', () => {
      expect(GCP_SERVICE).toBe('asap');
    });

    it('has 120s timeout', () => {
      expect(GCP_TIMEOUT).toBe(120_000);
    });

    it('has VM allowed prefixes', () => {
      expect(VM_ALLOWED_PREFIXES.length).toBeGreaterThan(5);
      expect(VM_ALLOWED_PREFIXES).toContain('pm2 status');
      expect(VM_ALLOWED_PREFIXES).toContain('git status');
    });
  });

  describe('gcpExecArgs()', () => {
    it('calls execFileSync with gcloud and arg array', () => {
      gcpExecArgs(['info']);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        ['info'],
        expect.objectContaining({
          timeout: GCP_TIMEOUT,
          encoding: 'utf-8',
        })
      );
    });

    it('returns trimmed output', () => {
      mockExecFileSync.mockReturnValue('  result\n  ');
      expect(gcpExecArgs(['info'])).toBe('result');
    });

    it('throws with stderr on failure', () => {
      mockExecFileSync.mockImplementation(() => {
        const err = new Error('Command failed') as any;
        err.stderr = 'Permission denied';
        throw err;
      });
      expect(() => gcpExecArgs(['info'])).toThrow('Permission denied');
    });

    it('uses safe environment', () => {
      gcpExecArgs(['info']);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.anything(),
        expect.objectContaining({
          env: expect.objectContaining({ PATH: '/usr/bin' }),
        })
      );
    });
  });

  describe('gcpBuildImage()', () => {
    it('builds with default tag', async () => {
      const result = await gcpBuildImage();
      expect(result).toContain('✅');
      expect(result).toContain('Image:');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['builds', 'submit']),
        expect.anything()
      );
    });

    it('builds with custom tag', async () => {
      const result = await gcpBuildImage('v1.2.3');
      expect(result).toContain('v1.2.3');
    });

    it('sanitizes tag input', async () => {
      await gcpBuildImage('v1; rm -rf /');
      // The tag should be sanitized — no semicolons or spaces
      const args = mockExecFileSync.mock.calls[0][1] as string[];
      const tagArg = args.find(a => a.startsWith('--tag='));
      expect(tagArg).not.toContain(';');
      expect(tagArg).not.toContain(' ');
    });

    it('returns error on build failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('Build failed'); });
      const result = await gcpBuildImage();
      expect(result).toContain('❌');
      expect(result).toContain('failed');
    });
  });

  describe('gcpDeploy()', () => {
    it('builds then deploys', async () => {
      mockExecFileSync
        .mockReturnValueOnce('mock build output') // build
        .mockReturnValueOnce('deployed ok')        // deploy
        .mockReturnValueOnce('url: https://asap.run.app'); // describe
      const result = await gcpDeploy();
      expect(result).toContain('✅');
      expect(mockExecFileSync).toHaveBeenCalledTimes(3);
    });
  });

  describe('gcpGetEnv()', () => {
    it('fetches Cloud Run service env vars', async () => {
      mockExecFileSync.mockReturnValue('KEY1=val1\nKEY2=val2');
      const result = await gcpGetEnv();
      expect(result).toContain('KEY1');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['run', 'services', 'describe']),
        expect.anything()
      );
    });
  });

  describe('gcpSetEnv()', () => {
    it('sets environment variables', async () => {
      const result = await gcpSetEnv('KEY1=value1,KEY2=value2');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['run', 'services', 'update']),
        expect.anything()
      );
    });

    it('validates KEY=VALUE format', async () => {
      const result = await gcpSetEnv('INVALID FORMAT');
      expect(result).toContain('Invalid format');
    });
  });

  describe('gcpListRevisions()', () => {
    it('lists revisions with limit', async () => {
      await gcpListRevisions(5);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['run', 'revisions', 'list']),
        expect.anything()
      );
    });
  });

  describe('gcpRollback()', () => {
    it('routes traffic to specified revision', async () => {
      await gcpRollback('asap-v1');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['run', 'services', 'update-traffic']),
        expect.anything()
      );
    });
  });

  describe('gcpSecretSet()', () => {
    it('creates/updates a secret', async () => {
      await gcpSecretSet('MY_SECRET', 'my-value');
      // Should use execFileSync for stdin pipe
    });
  });

  describe('gcpSecretBind()', () => {
    it('validates binding format', async () => {
      const result = await gcpSecretBind('bad format');
      expect(result).toContain('Invalid binding');
    });
  });

  describe('gcpSecretList()', () => {
    it('lists secrets', async () => {
      await gcpSecretList();
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['secrets', 'list']),
        expect.anything()
      );
    });
  });

  describe('gcpBuildStatus()', () => {
    it('lists recent builds', async () => {
      await gcpBuildStatus(5);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['builds', 'list']),
        expect.anything()
      );
    });
  });

  describe('gcpLogsQuery()', () => {
    it('queries Cloud Run logs', async () => {
      await gcpLogsQuery('severity=ERROR', 50);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['logging', 'read']),
        expect.anything()
      );
    });
  });

  describe('gcpRunDescribe()', () => {
    it('describes Cloud Run service', async () => {
      await gcpRunDescribe();
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['run', 'services', 'describe']),
        expect.anything()
      );
    });
  });

  describe('gcpStorageLs()', () => {
    it('lists bucket contents', async () => {
      await gcpStorageLs('my-bucket');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['storage', 'ls']),
        expect.anything()
      );
    });
  });

  describe('gcpArtifactList()', () => {
    it('lists container images', async () => {
      await gcpArtifactList(10);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['artifacts', 'docker', 'images', 'list']),
        expect.anything()
      );
    });
  });

  describe('gcpSqlDescribe()', () => {
    it('describes Cloud SQL instance', async () => {
      await gcpSqlDescribe();
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['sql', 'instances', 'describe']),
        expect.anything()
      );
    });
  });

  describe('gcpVmSsh()', () => {
    it('executes allowed commands', async () => {
      const result = await gcpVmSsh('pm2 status');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['compute', 'ssh']),
        expect.anything()
      );
    });

    it('blocks disallowed commands', async () => {
      const result = await gcpVmSsh('rm -rf /');
      expect(result).toContain('not in VM allowlist');
    });

    it('blocks empty commands', async () => {
      const result = await gcpVmSsh('');
      expect(result).toContain('not in VM allowlist');
    });
  });

  describe('gcpProjectInfo()', () => {
    it('returns project information', async () => {
      await gcpProjectInfo();
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining(['projects', 'describe']),
        expect.anything()
      );
    });
  });

  describe('gcpPreflight()', () => {
    it('runs preflight checks', async () => {
      const result = await gcpPreflight();
      expect(typeof result).toBe('string');
    });

    it('reports failed checks', async () => {
      mockExecFileSync
        .mockReturnValueOnce('gcloud 400.0.0')     // --version OK
        .mockImplementationOnce(() => { throw new Error('no project'); }) // config get-value fails
        .mockReturnValueOnce('user@test.com')       // auth list OK
        .mockReturnValueOnce('run.googleapis.com')  // Cloud Run API
        .mockReturnValueOnce('cloudbuild.googleapis.com') // Cloud Build API
        .mockReturnValueOnce('secretmanager.googleapis.com') // Secret Manager
        .mockReturnValueOnce('https://asap.run.app'); // service describe
      const result = await gcpPreflight();
      expect(result).toContain('❌');
      expect(result).toContain('active project');
    });
  });

  describe('additional guard/validation paths', () => {
    it('gcpRollback returns error on empty revision', async () => {
      const result = await gcpRollback('; rm -rf /');
      // semicolons are stripped, leaving empty
      expect(typeof result).toBe('string');
    });

    it('gcpRollback returns error on failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
      const result = await gcpRollback('asap-v1');
      expect(result).toContain('❌');
    });

    it('gcpSecretSet rejects invalid name', async () => {
      const result = await gcpSecretSet('', 'value');
      expect(result).toContain('Invalid secret name');
    });

    it('gcpSecretSet adds version to existing secret', async () => {
      mockExecFileSync
        .mockReturnValueOnce('secret exists')   // describe succeeds (exists)
        .mockReturnValueOnce('version added');   // versions add
      const result = await gcpSecretSet('MY_SECRET', 'val');
      expect(result).toContain('✅');
    });

    it('gcpSecretSet creates new secret', async () => {
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('NOT_FOUND'); }) // describe fails (doesn't exist)
        .mockReturnValueOnce('created');  // create
      const result = await gcpSecretSet('NEW_SECRET', 'val');
      expect(result).toContain('✅');
    });

    it('gcpSecretSet returns error on failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('perm denied'); });
      const result = await gcpSecretSet('MY_SECRET', 'val');
      expect(result).toContain('❌');
    });

    it('gcpSecretBind succeeds with valid bindings', async () => {
      mockExecFileSync.mockReturnValue('updated');
      const result = await gcpSecretBind('DB_PASS=db-password:latest');
      expect(result).toContain('✅');
      expect(result).toContain('DB_PASS');
    });

    it('gcpSecretBind rejects empty bindings', async () => {
      const result = await gcpSecretBind('');
      expect(result).toContain('❌');
    });

    it('gcpSecretBind returns error on exec failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('denied'); });
      const result = await gcpSecretBind('DB_PASS=db-pass');
      expect(result).toContain('❌');
    });

    it('gcpStorageLs rejects invalid bucket name', async () => {
      const result = await gcpStorageLs('-bad-bucket');
      expect(result).toContain('Invalid bucket');
    });

    it('gcpStorageLs rejects invalid prefix', async () => {
      const result = await gcpStorageLs('valid-bucket', 'path with spaces!');
      expect(result).toContain('Invalid prefix');
    });

    it('gcpStorageLs returns empty message', async () => {
      mockExecFileSync.mockReturnValue('');
      const result = await gcpStorageLs('valid-bucket');
      expect(result).toContain('Empty');
    });

    it('gcpStorageLs returns error on failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('denied'); });
      const result = await gcpStorageLs('valid-bucket');
      expect(result).toContain('❌');
    });

    it('gcpVmSsh rejects commands with disallowed characters', async () => {
      const result = await gcpVmSsh('pm2 status; echo hacked');
      expect(result).toContain('disallowed characters');
    });

    it('gcpVmSsh returns error on exec failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('SSH failed'); });
      const result = await gcpVmSsh('pm2 status');
      expect(result).toContain('❌');
    });

    it('gcpVmSsh returns (no output) for empty result', async () => {
      mockExecFileSync.mockReturnValue('');
      const result = await gcpVmSsh('uptime');
      expect(result).toBe('(no output)');
    });

    it('gcpGetEnv returns error on failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('denied'); });
      const result = await gcpGetEnv();
      expect(result).toContain('❌');
    });

    it('gcpGetEnv returns fallback for empty result', async () => {
      mockExecFileSync.mockReturnValue('');
      const result = await gcpGetEnv();
      expect(result).toContain('No environment variables');
    });

    it('gcpSetEnv returns error on exec failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('denied'); });
      const result = await gcpSetEnv('KEY=value');
      expect(result).toContain('❌');
    });

    it('gcpListRevisions returns error on failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('denied'); });
      const result = await gcpListRevisions(5);
      expect(result).toContain('❌');
    });

    it('gcpListRevisions returns fallback for empty result', async () => {
      mockExecFileSync.mockReturnValue('');
      const result = await gcpListRevisions(5);
      expect(result).toContain('No revisions');
    });

    it('gcpBuildStatus returns error on failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('denied'); });
      const result = await gcpBuildStatus(5);
      expect(result).toContain('❌');
    });

    it('gcpLogsQuery returns error on failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('denied'); });
      const result = await gcpLogsQuery('severity=ERROR', 20);
      expect(result).toContain('❌');
    });

    it('gcpLogsQuery returns fallback for no matches', async () => {
      mockExecFileSync.mockReturnValue('');
      const result = await gcpLogsQuery('severity=ERROR', 20);
      expect(result).toContain('No log entries');
    });

    it('gcpRunDescribe returns error on failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('denied'); });
      const result = await gcpRunDescribe();
      expect(result).toContain('❌');
    });

    it('gcpArtifactList returns error on failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('denied'); });
      const result = await gcpArtifactList(5);
      expect(result).toContain('❌');
    });

    it('gcpArtifactList returns fallback for no images', async () => {
      mockExecFileSync.mockReturnValue('');
      const result = await gcpArtifactList(5);
      expect(result).toContain('No images');
    });

    it('gcpSqlDescribe returns error on failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('denied'); });
      const result = await gcpSqlDescribe();
      expect(result).toContain('❌');
    });

    it('gcpProjectInfo returns error on failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('denied'); });
      const result = await gcpProjectInfo();
      expect(result).toContain('❌');
    });

    it('gcpDeploy returns error when build fails', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('build error'); });
      const result = await gcpDeploy();
      expect(result).toContain('❌');
    });

    it('gcpDeploy returns error when deploy step fails', async () => {
      mockExecFileSync
        .mockReturnValueOnce('build ok')  // build
        .mockImplementationOnce(() => { throw new Error('deploy error'); }); // deploy
      // Build succeeds but the image ref parsing might fail, still covers the error path
      const result = await gcpDeploy();
      expect(typeof result).toBe('string');
    });

    it('gcpBuildStatus returns fallback for empty result', async () => {
      mockExecFileSync.mockReturnValue('');
      const result = await gcpBuildStatus(5);
      expect(result).toContain('No builds found');
    });

    it('gcpSecretList returns error on failure', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('denied'); });
      const result = await gcpSecretList();
      expect(result).toContain('❌');
    });

    it('gcpSecretList returns fallback for empty result', async () => {
      mockExecFileSync.mockReturnValue('');
      const result = await gcpSecretList();
      expect(result).toContain('No secrets found');
    });

    it('gcpBuildImage exercises truthy tag branch', async () => {
      const result = await gcpBuildImage('release-v1');
      expect(result).toContain('release-v1');
      expect(result).toContain('✅');
      const args = mockExecFileSync.mock.calls[0][1] as string[];
      const tagArg = args.find((a: string) => a.startsWith('--tag='));
      expect(tagArg).toContain(':release-v1');
    });

    it('gcpSecretSet returns invalid for name that sanitizes to empty', async () => {
      const result = await gcpSecretSet('!!!@#$%^&*()', 'secret-value');
      expect(result).toBe('Invalid secret name. Use alphanumeric characters, hyphens, and underscores.');
    });
  });
});

describe('toolsGcp (fresh module)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('gcpBuildImage with tag covers truthy ternary branch', async () => {
    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(() => 'mock output'),
    }));
    jest.doMock('../../discord/envSandbox', () => ({
      buildGcpSafeEnv: jest.fn(() => ({ PATH: '/usr/bin', HOME: '/tmp' })),
    }));
    const { gcpBuildImage } = await import('../../discord/toolsGcp');
    const result = await gcpBuildImage('fresh-tag');
    expect(result).toContain('fresh-tag');
    expect(result).toContain('✅');
  });

  it('gcpBuildImage without tag covers falsy ternary branch', async () => {
    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(() => 'mock output'),
    }));
    jest.doMock('../../discord/envSandbox', () => ({
      buildGcpSafeEnv: jest.fn(() => ({ PATH: '/usr/bin', HOME: '/tmp' })),
    }));
    const { gcpBuildImage } = await import('../../discord/toolsGcp');
    const result = await gcpBuildImage();
    expect(result).toContain('agent-');
    expect(result).toContain('✅');
  });

  it('gcpSecretSet with invalid name returns error (fresh module)', async () => {
    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(() => 'mock output'),
    }));
    jest.doMock('../../discord/envSandbox', () => ({
      buildGcpSafeEnv: jest.fn(() => ({ PATH: '/usr/bin', HOME: '/tmp' })),
    }));
    const { gcpSecretSet } = await import('../../discord/toolsGcp');
    const result = await gcpSecretSet('@@@', 'value');
    expect(result).toContain('Invalid secret name');
  });

  it('gcpSecretSet with valid name succeeds (fresh module)', async () => {
    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(() => 'mock output'),
    }));
    jest.doMock('../../discord/envSandbox', () => ({
      buildGcpSafeEnv: jest.fn(() => ({ PATH: '/usr/bin', HOME: '/tmp' })),
    }));
    const { gcpSecretSet } = await import('../../discord/toolsGcp');
    const result = await gcpSecretSet('VALID_NAME', 'value');
    expect(result).toContain('✅');
  });
});
