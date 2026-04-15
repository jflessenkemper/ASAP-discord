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
  });
});
