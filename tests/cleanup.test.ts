export {};

import * as path from 'path';

const mockInfo = jest.fn();
const mockGetState = jest.fn();
const mockExec = jest.fn();
const mockRmSync = jest.fn();

jest.mock('@actions/core', () => ({
  info:     (...args: unknown[]) => mockInfo(...args),
  getState: (...args: unknown[]) => mockGetState(...args),
}));

jest.mock('@actions/exec', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cleanup } = require('../src/cleanup');

const HARNESS = '/runner/temp/setup-harness-cli/bin/harness';
const CLI_HOME = '/runner/temp/setup-harness-cli/home';

function setState(state: Record<string, string>) {
  mockGetState.mockImplementation((name: string) => state[name] ?? '');
}

beforeEach(() => {
  jest.clearAllMocks();
  setState({ 'harness-path': HARNESS, 'cli-home': CLI_HOME });
});

describe('cleanup', () => {
  test('logs out against the action CLI home and deletes the credentials file', async () => {
    mockExec.mockResolvedValue(0);
    await cleanup();

    expect(mockExec).toHaveBeenCalledWith(
      HARNESS, ['auth', 'logout'],
      expect.objectContaining({
        ignoreReturnCode: true,
        silent: true,
        env: expect.objectContaining({ HARNESS_CLI_HOME: CLI_HOME }),
      }),
    );
    expect(mockRmSync).toHaveBeenCalledWith(path.join(CLI_HOME, 'credentials'), { force: true });
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('removed'));
  });

  test('still deletes credentials when logout throws', async () => {
    mockExec.mockRejectedValue(new Error('harness: command not found'));
    await expect(cleanup()).resolves.toBeUndefined();

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Logout skipped'));
    expect(mockRmSync).toHaveBeenCalledWith(path.join(CLI_HOME, 'credentials'), { force: true });
  });

  test('logs non-fatal message when logout returns non-zero', async () => {
    mockExec.mockResolvedValue(1);
    await cleanup();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('non-zero'));
  });

  test('does nothing when the main step never installed the CLI', async () => {
    setState({});
    await cleanup();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
  });
});
