export {};

import { login, AuthInputs, ExecFn } from '../src/auth';

const INPUTS: AuthInputs = {
  apiUrl:  'https://app.harness.io',
  account: 'acc-123',
  token:   'pat.acc-123.secret',
  org:     'my-org',
  project: 'my-project',
};
const HARNESS = '/runner/temp/setup-harness-cli/bin/harness';

function makeExecFn(exitCode: number, stdout = '', stderr = ''): ExecFn {
  return jest.fn().mockResolvedValue({ exitCode, stdout, stderr });
}

describe('login', () => {
  test('runs harness auth login non-interactively with scope and --overwrite', async () => {
    const execFn = makeExecFn(0);
    await login(INPUTS, HARNESS, execFn);

    expect(execFn).toHaveBeenCalledWith(
      HARNESS,
      [
        'auth', 'login',
        '--api-url', 'https://app.harness.io',
        '--account', 'acc-123',
        '--api-token', 'pat.acc-123.secret',
        '--org', 'my-org',
        '--project', 'my-project',
        '--overwrite',
      ],
      { silent: true },
    );
  });

  test('throws on non-zero exit code', async () => {
    const execFn = makeExecFn(1, 'auth failed', '');
    await expect(login(INPUTS, HARNESS, execFn)).rejects.toThrow(/harness auth login failed/);
  });

  test('redacts token from error message', async () => {
    const execFn = makeExecFn(1, 'bad token pat.acc-123.secret rejected', '');
    await expect(login(INPUTS, HARNESS, execFn)).rejects.toThrow(/\*\*\*/);
    await expect(login(INPUTS, HARNESS, execFn)).rejects.not.toThrow(/pat\.acc-123\.secret/);
  });
});
