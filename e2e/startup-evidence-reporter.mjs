import { preserveFailureEvidence } from '../scripts/startup-evidence.mjs';
import { unlink } from 'node:fs/promises';

export default class StartupEvidenceReporter {
  async onTestEnd(test, result) {
    if (result.status === 'passed' || result.status === 'skipped') return;

    const evidence = await preserveFailureEvidence({
      title: test.titlePath().join(' › '),
      status: result.status,
      errors: result.errors,
      attachments: result.attachments,
      serverLogPath: process.env.REPOLENS_E2E_SERVER_LOG,
    });
    console.error(`RepoLens browser failure evidence preserved at ${evidence.destination}`);
  }

  async onEnd(result) {
    if (result.status !== 'passed' && result.status !== 'timedout') return;
    const logPath = process.env.REPOLENS_E2E_SERVER_LOG;
    if (logPath) await unlink(logPath).catch(() => {});
  }
}
