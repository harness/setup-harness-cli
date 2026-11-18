import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { login, AuthInputs, ExecFn, ExecOptions } from './auth';
import { ensureCli, MARKER_CLI_VERSION } from './install';
import { STATE_CLI_HOME, STATE_HARNESS_PATH } from './state';

/** Env var used as a within-job marker so login runs only once per scope per job. */
const MARKER_LOGGED_IN = 'SETUP_HARNESS_LOGGED_IN';

/**
 * Reads an action input; falls back to an environment variable if the input is empty.
 * Throws if both are absent and the value is required.
 */
function getInputOrEnv(inputName: string, envName: string, required = false): string {
  const fromInput = core.getInput(inputName);
  if (fromInput) return fromInput;
  const fromEnv = process.env[envName] ?? '';
  if (required && !fromEnv) {
    throw new Error(
      `Input "${inputName}" is required. Set it via the action input or the ${envName} environment variable.`,
    );
  }
  return fromEnv;
}

function buildExecFn(): ExecFn {
  return async (cmd: string, args: string[], options: ExecOptions = {}) => {
    let stdout = '';
    let stderr = '';
    const exitCode = await exec.exec(cmd, args, {
      ignoreReturnCode: true,
      silent: options.silent === true,
      listeners: {
        stdout: (data: Buffer) => { stdout += data.toString(); },
        stderr: (data: Buffer) => { stderr += data.toString(); },
      },
    });
    return { exitCode, stdout, stderr };
  };
}

async function verifyCliCommand(harnessPath: string, execFn: ExecFn): Promise<void> {
  const { exitCode, stdout } = await execFn(harnessPath, ['version'], { silent: true });
  if (exitCode !== 0 || !stdout.includes('harness version')) {
    throw new Error('Harness CLI is not usable after setup — "harness version" failed. Check PATH and installation.');
  }
}

export async function run(): Promise<void> {
  try {
    const token = getInputOrEnv('token', 'HARNESS_PAT_TOKEN', true);
    core.setSecret(token);

    const githubToken = core.getInput('github-token');
    if (githubToken) core.setSecret(githubToken);

    const inputs: AuthInputs = {
      apiUrl:  getInputOrEnv('api-url', 'HARNESS_URL',        true),
      account: getInputOrEnv('account', 'HARNESS_ACCOUNT_ID', true),
      token,
      org:     getInputOrEnv('org',     'HARNESS_ORG_ID',     true),
      project: getInputOrEnv('project', 'HARNESS_PROJECT_ID', true),
    };

    const cli = await ensureCli(core.getInput('cli-version'), githubToken);
    core.saveState(STATE_HARNESS_PATH, cli.harnessPath);
    core.saveState(STATE_CLI_HOME, cli.cliHome);

    const loginMarkerValue = [inputs.apiUrl, inputs.account, inputs.org, inputs.project].join('|');
    if (process.env[MARKER_LOGGED_IN] === loginMarkerValue) {
      core.info(`Already logged in at ${inputs.apiUrl} (${inputs.org}/${inputs.project}), skipping`);
    } else {
      core.startGroup('harness auth login');
      try {
        core.info(
          `harness auth login --api-url ${inputs.apiUrl} --account ${inputs.account} --api-token *** ` +
          `--org ${inputs.org} --project ${inputs.project} --overwrite`,
        );
        await login(inputs, cli.harnessPath, buildExecFn());
        core.exportVariable(MARKER_LOGGED_IN, loginMarkerValue);
      } finally {
        core.endGroup();
      }
    }

    await verifyCliCommand(cli.harnessPath, buildExecFn());

    core.setOutput('cli-version', cli.version);
    core.info(`Harness CLI ${cli.version} with the har plugin is ready`);
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

/* istanbul ignore next */
if (require.main === module) {
  run();
}

export { MARKER_CLI_VERSION, MARKER_LOGGED_IN };
