import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';
import { STATE_CLI_HOME, STATE_HARNESS_PATH } from './state';

export async function cleanup(): Promise<void> {
  const harnessPath = core.getState(STATE_HARNESS_PATH);
  const cliHome = core.getState(STATE_CLI_HOME);
  if (!harnessPath || !cliHome) {
    core.info('Harness CLI was not set up in this step; nothing to clean up');
    return;
  }

  try {
    core.info('Removing Harness CLI authentication...');
    const exitCode = await exec.exec(harnessPath, ['auth', 'logout'], {
      ignoreReturnCode: true,
      silent: true,
      env: { ...process.env, HARNESS_CLI_HOME: cliHome } as Record<string, string>,
    });
    if (exitCode !== 0) {
      core.info('harness auth logout returned non-zero; credentials may already be cleared');
    } else {
      core.info('Harness CLI credentials removed');
    }
  } catch (err) {
    core.info(`Logout skipped: ${err}`);
  }

  // Logout can fail if the binary is gone, so also delete the credentials file directly.
  try {
    fs.rmSync(path.join(cliHome, 'credentials'), { force: true });
  } catch (err) {
    core.info(`Could not remove credentials file: ${err}`);
  }
}

/* istanbul ignore next */
if (require.main === module) {
  cleanup();
}
