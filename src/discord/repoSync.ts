import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { errMsg } from '../utils/errors';

const ASAP_REPO_URL = process.env.ASAP_REPO_URL || 'https://github.com/jflessenkemper/ASAP.git';
const ASAP_REPO_DIR = process.env.ASAP_REPO_DIR || '/opt/asap-app';
const REPO_SYNC_INTERVAL_MS = Math.max(60_000, parseInt(process.env.REPO_SYNC_INTERVAL_MS || '300000', 10));
const REPO_SYNC_BRANCH = process.env.REPO_SYNC_BRANCH || 'main';

let syncTimer: ReturnType<typeof setInterval> | null = null;
let lastSyncAt = 0;
let lastLockHash = '';
let repoIndexed = false;

function git(args: string[], cwd: string): string {
  const token = process.env.GITHUB_TOKEN;
  const env: Record<string, string> = { ...process.env as Record<string, string>, GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    env.GIT_ASKPASS = 'echo';
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `url.https://${token}@github.com/.insteadOf`;
    env.GIT_CONFIG_VALUE_0 = 'https://github.com/';
  }
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 120_000, env }).trim();
}

function fileHashQuick(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').slice(0, 8192);
  } catch {
    return '';
  }
}

function npmInstallIfNeeded(dir: string): void {
  const lockPath = path.join(dir, 'package-lock.json');
  const currentHash = fileHashQuick(lockPath);
  const nodeModulesExists = fs.existsSync(path.join(dir, 'node_modules'));

  if (nodeModulesExists && currentHash === lastLockHash && lastLockHash !== '') return;

  console.log(`[repo-sync] Running npm install in ${dir}`);
  try {
    execFileSync('npm', ['install', '--no-scripts', '--ignore-scripts'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 180_000,
      env: { ...process.env as Record<string, string>, NODE_ENV: 'development' },
    });
  } catch (err) {
    console.warn(`[repo-sync] npm install in ${dir} failed:`, errMsg(err));
  }
  lastLockHash = currentHash;
}

export function syncRepo(): { cloned: boolean; synced: boolean; head: string; error?: string } {
  const repoDir = ASAP_REPO_DIR;

  try {
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      console.log(`[repo-sync] Cloning ${ASAP_REPO_URL} → ${repoDir}`);
      fs.mkdirSync(repoDir, { recursive: true });
      git(['clone', '--depth=1', '--branch', REPO_SYNC_BRANCH, ASAP_REPO_URL, repoDir], path.dirname(repoDir));
      npmInstallIfNeeded(repoDir);
      const serverDir = path.join(repoDir, 'server');
      if (fs.existsSync(path.join(serverDir, 'package.json'))) {
        npmInstallIfNeeded(serverDir);
      }
      const head = git(['rev-parse', '--short', 'HEAD'], repoDir);
      lastSyncAt = Date.now();
      return { cloned: true, synced: true, head };
    }

    // Already cloned — fetch and reset to origin/main
    git(['fetch', 'origin', REPO_SYNC_BRANCH, '--depth=1'], repoDir);
    const localHead = git(['rev-parse', 'HEAD'], repoDir);
    const remoteHead = git(['rev-parse', `origin/${REPO_SYNC_BRANCH}`], repoDir);

    if (localHead !== remoteHead) {
      console.log(`[repo-sync] Updating ${localHead.slice(0, 7)} → ${remoteHead.slice(0, 7)}`);
      git(['reset', '--hard', `origin/${REPO_SYNC_BRANCH}`], repoDir);
      git(['clean', '-fd'], repoDir);
      npmInstallIfNeeded(repoDir);
      const serverDir = path.join(repoDir, 'server');
      if (fs.existsSync(path.join(serverDir, 'package.json'))) {
        npmInstallIfNeeded(serverDir);
      }
    }

    const head = git(['rev-parse', '--short', 'HEAD'], repoDir);
    lastSyncAt = Date.now();
    return { cloned: false, synced: localHead !== remoteHead, head };
  } catch (err) {
    const error = errMsg(err);
    console.error(`[repo-sync] Failed:`, error);
    return { cloned: false, synced: false, head: '', error };
  }
}

export function startRepoSyncLoop(): void {
  if (syncTimer) return;
  console.log(`[repo-sync] Starting sync loop every ${REPO_SYNC_INTERVAL_MS / 1000}s for ${ASAP_REPO_DIR}`);

  // Initial sync
  try {
    const result = syncRepo();
    console.log(`[repo-sync] Initial sync: cloned=${result.cloned} synced=${result.synced} head=${result.head}${result.error ? ` error=${result.error}` : ''}`);
    // One-time: index the ASAP app repo into repo_memory so semantic search is warm
    if ((result.cloned || result.synced) && !repoIndexed) {
      repoIndexed = true;
      import('./tools').then(({ repoMemoryIndex }) => {
        repoMemoryIndex('full', 800).then((summary) => {
          console.log(`[repo-sync] Repo memory index complete: ${summary.slice(0, 200)}`);
        }).catch((err) => {
          console.warn('[repo-sync] Repo memory index failed:', errMsg(err));
        });
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[repo-sync] Initial sync failed:', errMsg(err));
  }

  syncTimer = setInterval(() => {
    try {
      const result = syncRepo();
      if (result.synced) {
        console.log(`[repo-sync] Updated to ${result.head}`);
        // Incremental re-index when new commits arrive
        import('./tools').then(({ repoMemoryIndex }) => {
          repoMemoryIndex('incremental', 800).catch((err) => {
            console.warn('[repo-sync] Incremental re-index failed:', errMsg(err));
          });
        }).catch(() => {});
      }
    } catch (err) {
      console.error('[repo-sync] Periodic sync failed:', errMsg(err));
    }
  }, REPO_SYNC_INTERVAL_MS);
}

export function stopRepoSyncLoop(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

export function getRepoSyncStatus(): { dir: string; lastSyncAt: number; branch: string } {
  return { dir: ASAP_REPO_DIR, lastSyncAt, branch: REPO_SYNC_BRANCH };
}
