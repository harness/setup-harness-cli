export {};

const mockGetInput = jest.fn();
const mockSetOutput = jest.fn();
const mockSetFailed = jest.fn();
const mockSetSecret = jest.fn();
const mockSaveState = jest.fn();
const mockInfo = jest.fn();
const mockStartGroup = jest.fn();
const mockEndGroup = jest.fn();
const mockExportVariable = jest.fn();

jest.mock('@actions/core', () => ({
  getInput:       mockGetInput,
  setOutput:      mockSetOutput,
  setFailed:      mockSetFailed,
  setSecret:      mockSetSecret,
  saveState:      mockSaveState,
  info:           mockInfo,
  startGroup:     mockStartGroup,
  endGroup:       mockEndGroup,
  exportVariable: mockExportVariable,
}));

const mockExec = jest.fn();
jest.mock('@actions/exec', () => ({
  exec: mockExec,
}));

const HARNESS = '/runner/temp/setup-harness-cli/bin/harness';
const CLI_HOME = '/runner/temp/setup-harness-cli/home';
const mockEnsureCli = jest.fn();
jest.mock('../src/install', () => ({
  ensureCli: (...args: unknown[]) => mockEnsureCli(...args),
  MARKER_CLI_VERSION: 'SETUP_HARNESS_CLI_VERSION',
}));

async function runModule(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../src/index');
  await mod.run();
}

const INPUTS: Record<string, string> = {
  'api-url':      'https://app.harness.io',
  'account':      'acc-123',
  'token':        'pat.acc-123.secret',
  'org':          'my-org',
  'project':      'my-project',
  'cli-version':  'v3.12.0',
  'github-token': '',
};

const ENV_VARS = ['HARNESS_URL', 'HARNESS_ACCOUNT_ID', 'HARNESS_PAT_TOKEN', 'HARNESS_ORG_ID', 'HARNESS_PROJECT_ID'];

function setupInputMock(overrides: Record<string, string> = {}) {
  const merged = { ...INPUTS, ...overrides };
  mockGetInput.mockImplementation((name: string) => merged[name] ?? '');
}

function mockExecHappyPath(versionOutput = 'harness version 3.12.0 (202611010000Z)\n') {
  mockExec.mockImplementation(async (_cmd: string, args: string[], opts: any) => {
    if (args[0] === 'version') {
      opts?.listeners?.stdout?.(Buffer.from(versionOutput));
    }
    return 0;
  });
}

function authCall() {
  return mockExec.mock.calls.find((c: any[]) => c[1][0] === 'auth');
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  delete process.env.SETUP_HARNESS_LOGGED_IN;
  // Harness CI pods inject HARNESS_ORG_ID/HARNESS_PROJECT_ID; clear them for hermetic tests.
  for (const name of ENV_VARS) delete process.env[name];
  mockEnsureCli.mockResolvedValue({ version: 'v3.12.0', harnessPath: HARNESS, cliHome: CLI_HOME });
});

describe('main orchestration', () => {
  test('installs the CLI, logs in with scope, sets cli-version output', async () => {
    setupInputMock();
    mockExecHappyPath();

    await runModule();

    expect(mockEnsureCli).toHaveBeenCalledWith('v3.12.0', '');
    expect(authCall()[0]).toBe(HARNESS);
    expect(authCall()[1]).toEqual([
      'auth', 'login',
      '--api-url', 'https://app.harness.io',
      '--account', 'acc-123',
      '--api-token', 'pat.acc-123.secret',
      '--org', 'my-org',
      '--project', 'my-project',
      '--overwrite',
    ]);
    expect(authCall()[2]).toEqual(expect.objectContaining({ silent: true }));
    expect(mockSaveState).toHaveBeenCalledWith('harness-path', HARNESS);
    expect(mockSaveState).toHaveBeenCalledWith('cli-home', CLI_HOME);
    expect(mockSetOutput).toHaveBeenCalledWith('cli-version', 'v3.12.0');
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  test.each([
    ['org', 'HARNESS_ORG_ID'],
    ['project', 'HARNESS_PROJECT_ID'],
  ])('fails before installing when %s is missing', async (input, envName) => {
    setupInputMock({ [input]: '' });

    await runModule();

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining(envName));
    expect(mockEnsureCli).not.toHaveBeenCalled();
  });

  test('skips login when marker matches the same url, account, org and project', async () => {
    setupInputMock();
    process.env.SETUP_HARNESS_LOGGED_IN = 'https://app.harness.io|acc-123|my-org|my-project';
    mockExecHappyPath();

    await runModule();

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Already logged in'));
    expect(authCall()).toBeUndefined();
  });

  test('logs in again when the project changes within a job', async () => {
    setupInputMock({ project: 'other-project' });
    process.env.SETUP_HARNESS_LOGGED_IN = 'https://app.harness.io|acc-123|my-org|my-project';
    mockExecHappyPath();

    await runModule();

    expect(mockStartGroup).toHaveBeenCalledWith('harness auth login');
    expect(mockExportVariable).toHaveBeenCalledWith(
      'SETUP_HARNESS_LOGGED_IN', 'https://app.harness.io|acc-123|my-org|other-project',
    );
  });

  test('fails if harness is not usable after setup', async () => {
    setupInputMock();
    mockExec.mockImplementation(async (_cmd: string, args: string[]) => (args[0] === 'version' ? 1 : 0));

    await runModule();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('Harness CLI is not usable after setup'),
    );
  });

  test('masks token before installing or running anything', async () => {
    setupInputMock();
    const callOrder: string[] = [];
    mockSetSecret.mockImplementation(() => { callOrder.push('setSecret'); });
    mockEnsureCli.mockImplementation(async () => {
      callOrder.push('ensureCli');
      return { version: 'v3.12.0', harnessPath: HARNESS, cliHome: CLI_HOME };
    });
    mockExecHappyPath();

    await runModule();

    expect(callOrder[0]).toBe('setSecret');
    expect(mockSetSecret).toHaveBeenCalledWith('pat.acc-123.secret');
  });

  test('logs redacted login command (no real token)', async () => {
    setupInputMock();
    mockExecHappyPath();

    await runModule();

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('--api-token ***'));
    expect(mockInfo).not.toHaveBeenCalledWith(expect.stringContaining('pat.acc-123.secret'));
  });

  test('login failure calls setFailed and closes group', async () => {
    setupInputMock();
    mockExec.mockImplementation(async (_cmd: string, args: string[], opts: any) => {
      if (args[0] === 'auth') {
        opts?.listeners?.stdout?.(Buffer.from('authentication failed 401'));
        return 1;
      }
      return 0;
    });

    await runModule();

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('harness auth login failed'));
    expect(mockEndGroup).toHaveBeenCalled();
  });

  test('uses env vars when action inputs are empty', async () => {
    mockGetInput.mockReturnValue('');
    process.env.HARNESS_URL        = 'https://env.harness.io';
    process.env.HARNESS_ACCOUNT_ID = 'acc-env';
    process.env.HARNESS_PAT_TOKEN  = 'pat.env.token';
    process.env.HARNESS_ORG_ID     = 'env-org';
    process.env.HARNESS_PROJECT_ID = 'env-project';
    mockExecHappyPath();

    await runModule();

    expect(mockSetSecret).toHaveBeenCalledWith('pat.env.token');
    expect(authCall()[1]).toEqual(expect.arrayContaining(['https://env.harness.io', 'env-org', 'env-project']));
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  test('input takes precedence over env var', async () => {
    setupInputMock();
    process.env.HARNESS_PAT_TOKEN = 'pat.from.env';
    mockExecHappyPath();

    await runModule();

    expect(mockSetSecret).toHaveBeenCalledWith('pat.acc-123.secret');
  });

  test('fails when neither input nor env var provides token', async () => {
    mockGetInput.mockReturnValue('');

    await runModule();

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('HARNESS_PAT_TOKEN'));
  });
});
