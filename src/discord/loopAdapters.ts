import { buildLoopHealthDetailedReport, getLoopHealthSnapshot, type LoopId } from './loopHealth';
import type { ExecutionIssue, LoopExecutionReport } from './handoff';
import { logAgentEvent } from './activityLog';
import { consolidateMemoryInsights, recordAgentLearning } from './vectorMemory';

const OPS_STEWARD_AGENT_ID = 'operations-manager';

function buildUnsupportedLoopReport(loopId: string): LoopExecutionReport {
  const snapshot = getLoopHealthSnapshot().find((entry) => entry.id === loopId);
  return {
    loopId,
    status: 'partial',
    summary: `${loopId} is currently event-driven and does not have a dedicated callable adapter yet.`,
    detail: snapshot
      ? `${snapshot.label} | status=${snapshot.status} | runs=${snapshot.runCount} | detail=${snapshot.lastDetail}`
      : buildLoopHealthDetailedReport(),
    evidence: snapshot
      ? [{ kind: 'loop', value: `${snapshot.id}:${snapshot.status}:${snapshot.lastDetail}` }]
      : [{ kind: 'loop', value: buildLoopHealthDetailedReport() }],
  };
}

export async function executeLoopAdapter(loopId: string): Promise<LoopExecutionReport> {
  const safeLoopId = String(loopId || '').trim() as LoopId | string;
  logAgentEvent(OPS_STEWARD_AGENT_ID, 'tool', `loop-adapter:start:${safeLoopId}`);
  try {
    let report: LoopExecutionReport;
    switch (safeLoopId) {
      case 'logging-engine': {
        const [{ getBotChannels }, { runLoggingEngine, buildLoggingEngineReport }] = await Promise.all([
          import('./bot'),
          import('./loggingEngine'),
        ]);
        const channels = getBotChannels();
        if (!channels) {
          report = {
            loopId: safeLoopId,
            status: 'blocked',
            summary: 'Logging engine cannot run because bot channels are not configured.',
            issues: [{ scope: 'loop', severity: 'error', message: 'Bot channels unavailable', source: safeLoopId }],
          };
          break;
        }
        await runLoggingEngine(channels);
        report = {
          loopId: safeLoopId,
          status: 'completed',
          summary: 'Logging engine snapshot refreshed.',
          evidence: [{ kind: 'loop', value: buildLoggingEngineReport() }],
        };
        break;
      }
      case 'database-audit': {
        const [{ getBotChannels, runDatabaseAudit }] = await Promise.all([
          import('./bot'),
        ]);
        const channels = getBotChannels();
        if (!channels) {
          report = {
            loopId: safeLoopId,
            status: 'blocked',
            summary: 'Database audit cannot run because bot channels are not configured.',
            issues: [{ scope: 'loop', severity: 'error', message: 'Bot channels unavailable', source: safeLoopId }],
          };
          break;
        }
        await runDatabaseAudit(channels);
        report = {
          loopId: safeLoopId,
          status: 'completed',
          summary: 'Database audit completed.',
          evidence: [{ kind: 'loop', value: 'database-audit:completed' }],
        };
        break;
      }
      case 'memory-consolidation': {
        const insight = await consolidateMemoryInsights();
        if (insight) {
          await recordAgentLearning(OPS_STEWARD_AGENT_ID, insight).catch(() => {});
        }
        report = {
          loopId: safeLoopId,
          status: 'completed',
          summary: insight ? 'Memory consolidation completed with new insight.' : 'Memory consolidation ran with no new insight.',
          evidence: insight ? [{ kind: 'loop', value: insight }] : [{ kind: 'loop', value: 'memory-consolidation:no-new-insight' }],
        };
        break;
      }
      case 'thread-status-reporter': {
        const mod = await import('./handlers/groupchat');
        await mod.postThreadStatusSnapshotNow('manual');
        const threadStatusLine = await mod.getThreadStatusOpsLine();
        report = {
          loopId: safeLoopId,
          status: 'completed',
          summary: 'Thread status snapshot refreshed.',
          evidence: [{ kind: 'loop', value: threadStatusLine }],
        };
        break;
      }
      case 'upgrades-triage': {
        const [{ getBotChannels, runUpgradesTriage }] = await Promise.all([
          import('./bot'),
        ]);
        const channels = getBotChannels();
        if (!channels) {
          report = {
            loopId: safeLoopId,
            status: 'blocked',
            summary: 'Upgrades triage cannot run because bot channels are not configured.',
            issues: [{ scope: 'loop', severity: 'error', message: 'Bot channels unavailable', source: safeLoopId }],
          };
          break;
        }
        await runUpgradesTriage(channels);
        report = {
          loopId: safeLoopId,
          status: 'completed',
          summary: 'Upgrades triage refreshed.',
          evidence: [{ kind: 'loop', value: 'upgrades-triage:completed' }],
        };
        break;
      }
      case 'channel-heartbeat': {
        const [{ getBotChannels, runChannelHeartbeat }] = await Promise.all([
          import('./bot'),
        ]);
        const channels = getBotChannels();
        if (!channels) {
          report = {
            loopId: safeLoopId,
            status: 'blocked',
            summary: 'Channel heartbeat cannot run because bot channels are not configured.',
            issues: [{ scope: 'loop', severity: 'error', message: 'Bot channels unavailable', source: safeLoopId }],
          };
          break;
        }
        await runChannelHeartbeat(channels);
        report = {
          loopId: safeLoopId,
          status: 'completed',
          summary: 'Channel heartbeat check completed.',
          evidence: [{ kind: 'loop', value: 'channel-heartbeat:completed' }],
        };
        break;
      }
      case 'test-engine': {
        const { smokeTestAgents } = await import('./tools');
        const result = await smokeTestAgents({ profile: 'readiness', timeoutMs: 60_000 });
        const issues: ExecutionIssue[] = /FAIL|❌/i.test(result)
          ? [{ scope: 'loop', severity: 'warn', message: 'Readiness smoke reported failures', source: safeLoopId }]
          : [];
        report = {
          loopId: safeLoopId,
          status: issues.length > 0 ? 'partial' : 'completed',
          summary: issues.length > 0 ? 'Test engine ran with failures.' : 'Test engine ran successfully.',
          evidence: [{ kind: 'test', value: result.slice(0, 1200) }],
          issues,
        };
        break;
      }
      default:
        report = buildUnsupportedLoopReport(safeLoopId);
        break;
    }
    logAgentEvent(
      OPS_STEWARD_AGENT_ID,
      report.status === 'blocked' ? 'error' : 'response',
      `loop-adapter:${safeLoopId}:${report.status}:${report.summary}`
    );
    return report;
  } catch (err) {
    const report: LoopExecutionReport = {
      loopId: safeLoopId,
      status: 'blocked',
      summary: `Loop adapter failed for ${safeLoopId}.`,
      issues: [{
        scope: 'loop',
        severity: 'error',
        source: safeLoopId,
        message: err instanceof Error ? err.stack || err.message : String(err),
      }],
    };
    logAgentEvent(OPS_STEWARD_AGENT_ID, 'error', `loop-adapter:${safeLoopId}:blocked:${report.issues?.[0]?.message || report.summary}`);
    return report;
  }
}

export async function executeLoopAdapters(loopIds: string[]): Promise<LoopExecutionReport[]> {
  const uniqueLoopIds = [...new Set(loopIds.filter(Boolean))];
  const reports = await Promise.all(uniqueLoopIds.map((loopId) => executeLoopAdapter(loopId)));
  return reports;
}