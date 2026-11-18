export {};

import * as crypto from 'crypto';
import * as path from 'path';

const mockInfo = jest.fn();
const mockAddPath = jest.fn();
const mockExportVariable = jest.fn();
const mockExec = jest.fn();
const mockRestoreCache = jest.fn();
const mockSaveCache = jest.fn();
const mockDownloadTool = jest.fn();
const mockExtractTar = jest.fn();
const mockExtractZip = jest.fn();
const mockReadFileSync = jest.fn();
const mockCreateReadStream = jest.fn();
const mockExistsSync = jest.fn();
const mockCopyFile = jest.fn();
let mockPlatform = 'linux';
let mockArch = 'x64';

jest.mock('@actions/core', () => ({
  info:           (...args: unknown[]) => mockInfo(...args),
  debug:          (...args: unknown[]) => mockInfo(...args),
  addPath:        (...args: unknown[]) => mockAddPath(...args),
  exportVariable: (...args: unknown[]) => mockExportVariable(...args),
}));

jest.mock('@actions/exec', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

jest.mock('@actions/cache', () => ({
  restoreCache: (...args: unknown[]) => mockRestoreCache(...args),
  saveCache:    (...args: unknown[]) => mockSaveCache(...args),
}));

jest.mock('@actions/tool-cache', () => ({
  downloadTool: (...args: unknown[]) => mockDownloadTool(...args),
  extractTar:   (...args: unknown[]) => mockExtractTar(...args),
  extractZip:   (...args: unknown[]) => mockExtractZip(...args),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    mkdir:    jest.fn().mockResolvedValue(undefined),
    copyFile: (...args: unknown[]) => mockCopyFile(...args),
    chmod:    jest.fn().mockResolvedValue(undefined),
  },
  readFileSync:     (...args: unknown[]) => mockReadFileSync(...args),
  createReadStream: (...args: unknown[]) => mockCreateReadStream(...args),
  existsSync:       (...args: unknown[]) => mockExistsSync(...args),
}));

jest.mock('https', () => ({ get: jest.fn() }));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  platform: () => mockPlatform,
  arch:     () => mockArch,
  tmpdir:   () => '/tmp',
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { normalizeCliVersion, versionsMatch, resolveCliVersion, ensureCli } = require('../src/install');

const RUNNER_TEMP = '/runner/temp';
const BIN_DIR = path.join(RUNNER_TEMP, 'setup-harness-cli', 'bin');
const CLI_HOME = path.join(RUNNER_TEMP, 'setup-harness-cli', 'home');
const HARNESS = path.join(BIN_DIR, 'harness');
const LINUX_BUNDLE = 'harness-bundle_3.12.0_linux_amd64.tar.gz';

const MOCK_ARCHIVE = Buffer.from('mock harness bundle');
const MOCK_HASH = crypto.createHash('sha256').update(MOCK_ARCHIVE).digest('hex');

/** Makes createReadStream emit MOCK_ARCHIVE so hashFile() returns MOCK_HASH. */
function mockHashableStream() {
  const stream = {
    on(event: string, handler: any) {
      if (event === 'data') setImmediate(() => handler(MOCK_ARCHIVE));
      if (event === 'end') setImmediate(() => handler());
      return stream;
    },
  };
  mockCreateReadStream.mockReturnValue(stream);
}

function mockGithubLatest(statusCode: number, body: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https');
  https.get.mockImplementation((_opts: any, cb: any) => {
    const res = {
      statusCode,
      on: (event: string, handler: any) => {
        if (event === 'data') handler(body);
        if (event === 'end') handler();
        return res;
      },
    };
    cb(res);
    return { on: jest.fn() };
  });
}

/** harness version prints `versionOutput`; install plugin exits with `pluginExit`. */
function mockHarnessExec(versionOutput = 'harness version 3.12.0 (202611010000Z)\n', pluginExit = 0) {
  mockExec.mockImplementation(async (_cmd: string, args: string[], opts: any) => {
    if (args[0] === 'version') {
      opts?.listeners?.stdout?.(Buffer.from(versionOutput));
      return 0;
    }
    if (args[0] === 'install' && args[1] === 'plugin') return pluginExit;
    throw new Error(`unexpected: ${args}`);
  });
}

function pluginInstallCalls() {
  return mockExec.mock.calls.filter((c: any[]) => c[1][0] === 'install');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatform = 'linux';
  mockArch = 'x64';
  process.env.RUNNER_TEMP = RUNNER_TEMP;
  delete process.env.SETUP_HARNESS_CLI_VERSION;
  mockRestoreCache.mockResolvedValue(undefined);
  mockSaveCache.mockResolvedValue(0);
  mockDownloadTool.mockResolvedValue('/tmp/mock-download');
  mockExtractTar.mockResolvedValue('/tmp/mock-extract');
  mockExtractZip.mockResolvedValue('/tmp/mock-extract');
  mockCopyFile.mockResolvedValue(undefined);
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(
    `0000000000000000000000000000000000000000000000000000000000000000  harness-core_3.12.0_linux_amd64.tar.gz\n` +
    `${MOCK_HASH}  ${LINUX_BUNDLE}\n`,
  );
  mockHashableStream();
});

describe('normalizeCliVersion', () => {
  test('adds leading v when missing', () => {
    expect(normalizeCliVersion('3.12.0')).toBe('v3.12.0');
  });

  test('keeps leading v', () => {
    expect(normalizeCliVersion('v3.12.0')).toBe('v3.12.0');
  });

  test('rejects shell metacharacters', () => {
    expect(() => normalizeCliVersion('v3.12.0; rm -rf /')).toThrow(/Invalid cli-version/);
    expect(() => normalizeCliVersion('$(reboot)')).toThrow(/Invalid cli-version/);
  });
});

describe('versionsMatch', () => {
  test('matches harness version output', () => {
    expect(versionsMatch('harness version 3.12.0 (202611010000Z)\n', 'v3.12.0')).toBe(true);
  });

  test('rejects mismatch', () => {
    expect(versionsMatch('harness version 3.11.0 (x)\n', 'v3.12.0')).toBe(false);
  });

  test('rejects output from the old hc binary', () => {
    expect(versionsMatch('hc version 3.12.0\n', 'v3.12.0')).toBe(false);
  });
});

describe('resolveCliVersion', () => {
  test('returns normalized version when explicit tag given', async () => {
    await expect(resolveCliVersion('3.12.0')).resolves.toBe('v3.12.0');
  });

  test('fetches latest from the harness/cli repo', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const https = require('https');
    mockGithubLatest(200, JSON.stringify({ tag_name: 'v3.12.0' }));

    await expect(resolveCliVersion('latest', 'ghs_test_token')).resolves.toBe('v3.12.0');
    expect(https.get).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/repos/harness/cli/releases/latest',
        headers: expect.objectContaining({ Authorization: 'Bearer ghs_test_token' }),
      }),
      expect.any(Function),
    );
  });

  test('fails clearly on non-200 GitHub API responses', async () => {
    mockGithubLatest(403, '{"message":"API rate limit exceeded"}');
    await expect(resolveCliVersion('')).rejects.toThrow(
      /GitHub API \/releases\/latest returned 403/,
    );
  });
});

describe('ensureCli', () => {
  test('exports CLI home and adds bin dir to PATH', async () => {
    mockHarnessExec();
    await ensureCli('v3.12.0');

    expect(mockExportVariable).toHaveBeenCalledWith('HARNESS_CLI_HOME', CLI_HOME);
    expect(mockExportVariable).toHaveBeenCalledWith('HARNESS_NO_UPDATE_CHECK', '1');
    expect(mockAddPath).toHaveBeenCalledWith(BIN_DIR);
  });

  test('skips install when marker matches and plugin is present', async () => {
    process.env.SETUP_HARNESS_CLI_VERSION = 'v3.12.0';

    const result = await ensureCli('v3.12.0');

    expect(result).toEqual({ version: 'v3.12.0', harnessPath: HARNESS, cliHome: CLI_HOME });
    expect(mockRestoreCache).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });

  test('reinstalls when marker matches but plugin is missing', async () => {
    process.env.SETUP_HARNESS_CLI_VERSION = 'v3.12.0';
    mockExistsSync.mockReturnValueOnce(false);
    mockHarnessExec();

    await ensureCli('v3.12.0');

    expect(mockDownloadTool).toHaveBeenCalled();
  });

  test('restores binary and plugin from cache without downloading', async () => {
    mockHarnessExec();
    mockRestoreCache.mockResolvedValue('setup-harness-cli-v3.12.0-linux-x64');

    await ensureCli('v3.12.0');

    expect(mockRestoreCache).toHaveBeenCalledWith(
      [BIN_DIR, path.join(CLI_HOME, 'bin'), path.join(CLI_HOME, 'spec')],
      'setup-harness-cli-v3.12.0-linux-x64',
    );
    expect(mockDownloadTool).not.toHaveBeenCalled();
    expect(mockSaveCache).not.toHaveBeenCalled();
  });

  test('downloads the bundle, verifies it, installs harness and the har plugin', async () => {
    mockHarnessExec();

    await ensureCli('v3.12.0');

    const base = 'https://github.com/harness/cli/releases/download/v3.12.0';
    expect(mockDownloadTool).toHaveBeenCalledWith(`${base}/${LINUX_BUNDLE}`);
    expect(mockDownloadTool).toHaveBeenCalledWith(`${base}/harness_3.12.0_checksums.txt`);
    expect(mockExtractTar).toHaveBeenCalledWith('/tmp/mock-download');
    expect(mockCopyFile).toHaveBeenCalledWith(path.join('/tmp/mock-extract', 'harness'), HARNESS);
    expect(pluginInstallCalls()[0].slice(0, 2)).toEqual([
      HARNESS, ['install', 'plugin', path.join('/tmp/mock-extract', 'harness-har')],
    ]);
    expect(mockSaveCache).toHaveBeenCalledWith(
      [BIN_DIR, path.join(CLI_HOME, 'bin'), path.join(CLI_HOME, 'spec')],
      'setup-harness-cli-v3.12.0-linux-x64',
    );
    expect(mockExportVariable).toHaveBeenCalledWith('SETUP_HARNESS_CLI_VERSION', 'v3.12.0');
  });

  test('uses the zip bundle and .exe binaries on Windows', async () => {
    mockPlatform = 'win32';
    mockArch = 'arm64';
    mockReadFileSync.mockReturnValue(`${MOCK_HASH}  harness-bundle_3.12.0_windows_arm64.zip\n`);
    mockHarnessExec();

    const result = await ensureCli('v3.12.0');

    expect(mockDownloadTool).toHaveBeenCalledWith(
      expect.stringContaining('harness-bundle_3.12.0_windows_arm64.zip'),
    );
    expect(mockExtractZip).toHaveBeenCalled();
    expect(mockExtractTar).not.toHaveBeenCalled();
    expect(result.harnessPath).toBe(path.join(BIN_DIR, 'harness.exe'));
    expect(pluginInstallCalls()[0][1][2]).toBe(path.join('/tmp/mock-extract', 'harness-har.exe'));
  });

  test('rejects a tampered bundle before running anything from it', async () => {
    mockReadFileSync.mockReturnValue(`${'ab'.repeat(32)}  ${LINUX_BUNDLE}\n`);
    mockHarnessExec();

    await expect(ensureCli('v3.12.0')).rejects.toThrow(/SHA-256 mismatch/);
    expect(mockExtractTar).not.toHaveBeenCalled();
    expect(pluginInstallCalls()).toHaveLength(0);
  });

  test('fails when the checksums file has no entry for the bundle', async () => {
    mockReadFileSync.mockReturnValue(`${MOCK_HASH}  ${LINUX_BUNDLE}.sig\n`);
    mockHarnessExec();

    await expect(ensureCli('v3.12.0')).rejects.toThrow(/No checksum entry found/);
  });

  test('fails when plugin install fails', async () => {
    mockHarnessExec(undefined, 1);

    await expect(ensureCli('v3.12.0')).rejects.toThrow(/harness install plugin failed/);
    expect(mockSaveCache).not.toHaveBeenCalled();
  });

  test('fails if installed version does not match', async () => {
    mockHarnessExec('harness version 9.9.9 (x)\n');

    await expect(ensureCli('v3.12.0')).rejects.toThrow(/version mismatch/);
  });

  test('fails if the har plugin is missing after install', async () => {
    mockExistsSync.mockReturnValue(false);
    mockHarnessExec();

    await expect(ensureCli('v3.12.0')).rejects.toThrow(/har plugin is missing/);
  });

  test('rejects unsupported architectures', async () => {
    mockArch = 'ia32';
    mockHarnessExec();

    await expect(ensureCli('v3.12.0')).rejects.toThrow(/Unsupported architecture/);
  });

  test('continues if cache save fails', async () => {
    mockHarnessExec();
    mockSaveCache.mockRejectedValue(new Error('cache quota exceeded'));

    await expect(ensureCli('v3.12.0')).resolves.toEqual(
      expect.objectContaining({ version: 'v3.12.0' }),
    );
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Cache save skipped'));
  });
});
