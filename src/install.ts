import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as cache from '@actions/cache';
import * as tc from '@actions/tool-cache';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

const CLI_REPO = 'harness/cli';
const CLI_VERSION_RE = /^v?\d+(\.[\w-]+)*$/;

/** Env var used as a within-job marker so the CLI is only installed once per job. */
export const MARKER_CLI_VERSION = 'SETUP_HARNESS_CLI_VERSION';

export interface InstalledCli {
  version: string;
  harnessPath: string;
  cliHome: string;
}

export function normalizeCliVersion(version: string): string {
  const trimmed = version.trim();
  if (!CLI_VERSION_RE.test(trimmed)) {
    throw new Error(
      `Invalid cli-version "${trimmed}". Expected a release tag like v3.12.0`,
    );
  }
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

export function versionsMatch(versionOutput: string, expected: string): boolean {
  const want = normalizeCliVersion(expected).replace(/^v/, '');
  const match = versionOutput.match(/harness version\s+(v?[\w.-]+)/i);
  if (!match) return false;
  return match[1].replace(/^v/, '') === want;
}

export function fetchLatestCliVersion(githubToken?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': 'setup-harness-cli',
      Accept: 'application/vnd.github+json',
    };
    if (githubToken) {
      headers.Authorization = `Bearer ${githubToken}`;
    }
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${CLI_REPO}/releases/latest`,
      headers,
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(
            `GitHub API /releases/latest returned ${res.statusCode}: ${data.slice(0, 200)}`,
          ));
          return;
        }
        try {
          const json = JSON.parse(data) as { tag_name?: string };
          if (json.tag_name) resolve(json.tag_name);
          else reject(new Error(`Unexpected GitHub API response: ${data.slice(0, 200)}`));
        } catch (e) {
          reject(new Error(`Failed to parse GitHub API response: ${e}`));
        }
      });
    }).on('error', (e: Error) => reject(new Error(`GitHub API request failed: ${e.message}`)));
  });
}

export async function resolveCliVersion(requested: string, githubToken?: string): Promise<string> {
  const trimmed = requested.trim().toLowerCase();
  if (!trimmed || trimmed === 'latest') {
    core.info('Resolving latest Harness CLI version from GitHub...');
    const tag = await fetchLatestCliVersion(githubToken);
    core.info(`Latest Harness CLI version: ${tag}`);
    return tag;
  }
  return normalizeCliVersion(requested);
}

function mapPlatform(platform: string): string {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'windows';
  throw new Error(`Unsupported platform: ${platform}. Supported: linux, darwin, win32`);
}

function mapArch(arch: string): string {
  if (arch === 'x64') return 'amd64';
  if (arch === 'arm64') return 'arm64';
  throw new Error(`Unsupported architecture: ${arch}. Supported: x64, arm64`);
}

function exeName(name: string): string {
  return os.platform() === 'win32' ? `${name}.exe` : name;
}

/**
 * The harness binary lives in <root>/bin and the CLI home (plugins, specs,
 * config, credentials) in <root>/home, so the cache can hold the binaries
 * and plugin without ever picking up credentials.
 */
function resolvePaths(): { binDir: string; cliHome: string } {
  const root = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'setup-harness-cli');
  return { binDir: path.join(root, 'bin'), cliHome: path.join(root, 'home') };
}

function cachePaths(binDir: string, cliHome: string): string[] {
  return [binDir, path.join(cliHome, 'bin'), path.join(cliHome, 'spec')];
}

function cacheKey(version: string): string {
  return `setup-harness-cli-${version}-${os.platform()}-${os.arch()}`;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function findChecksum(checksums: string, assetName: string): string | undefined {
  for (const line of checksums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name && name.replace(/^\*/, '') === assetName) return hash;
  }
  return undefined;
}

async function readVersionOutput(harnessPath: string): Promise<string> {
  let stdout = '';
  const exitCode = await exec.exec(harnessPath, ['version'], {
    ignoreReturnCode: true,
    silent: true,
    listeners: { stdout: (data: Buffer) => { stdout += data.toString(); } },
  });
  return exitCode === 0 ? stdout : '';
}

async function installCli(version: string, binDir: string, harnessPath: string): Promise<void> {
  const platform = mapPlatform(os.platform());
  const arch = mapArch(os.arch());
  const ver = version.replace(/^v/, '');
  const ext = platform === 'windows' ? 'zip' : 'tar.gz';
  const assetName = `harness-bundle_${ver}_${platform}_${arch}.${ext}`;
  const checksumsName = `harness_${ver}_checksums.txt`;
  const baseUrl = `https://github.com/${CLI_REPO}/releases/download/${version}`;

  core.info(`Downloading Harness CLI ${version} (${platform}/${arch})...`);

  const [archivePath, checksumsPath] = await Promise.all([
    tc.downloadTool(`${baseUrl}/${assetName}`),
    tc.downloadTool(`${baseUrl}/${checksumsName}`),
  ]);

  // Verify SHA-256 before executing anything from the archive
  const expectedHash = findChecksum(fs.readFileSync(checksumsPath, 'utf8'), assetName);
  if (!expectedHash) {
    throw new Error(`No checksum entry found for ${assetName} in ${checksumsName}`);
  }
  const actualHash = await hashFile(archivePath);
  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA-256 mismatch for ${assetName}: expected ${expectedHash}, got ${actualHash}`,
    );
  }
  core.info(`SHA-256 verified for ${assetName}`);

  const extractDir = ext === 'zip'
    ? await tc.extractZip(archivePath)
    : await tc.extractTar(archivePath);

  await fs.promises.mkdir(binDir, { recursive: true });
  await fs.promises.copyFile(path.join(extractDir, exeName('harness')), harnessPath);
  await fs.promises.chmod(harnessPath, 0o755);

  const pluginSource = path.join(extractDir, exeName('harness-har'));
  const exitCode = await exec.exec(harnessPath, ['install', 'plugin', pluginSource], {
    ignoreReturnCode: true,
  });
  if (exitCode !== 0) {
    throw new Error(`harness install plugin failed (exit ${exitCode}) for ${pluginSource}`);
  }
}

/**
 * Ensures the harness CLI and its har plugin are installed exactly once per job.
 * Uses SETUP_HARNESS_CLI_VERSION as a job-scoped marker so repeated calls
 * within the same job are instant no-ops.
 */
export async function ensureCli(requestedVersion = '', githubToken?: string): Promise<InstalledCli> {
  const version = await resolveCliVersion(requestedVersion, githubToken);
  const { binDir, cliHome } = resolvePaths();
  const harnessPath = path.join(binDir, exeName('harness'));
  const pluginPath = path.join(cliHome, 'bin', exeName('harness-har'));

  core.exportVariable('HARNESS_CLI_HOME', cliHome);
  core.exportVariable('HARNESS_NO_UPDATE_CHECK', '1');
  core.addPath(binDir);

  if (process.env[MARKER_CLI_VERSION] === version && fs.existsSync(pluginPath)) {
    core.info(`Harness CLI ${version} already installed in this job, skipping`);
    return { version, harnessPath, cliHome };
  }

  const paths = cachePaths(binDir, cliHome);
  const key = cacheKey(version);
  const cacheHit = await cache.restoreCache(paths, key);
  if (cacheHit) {
    core.info(`Restored Harness CLI ${version} from cache`);
  } else {
    await installCli(version, binDir, harnessPath);
    try {
      const cacheId = await cache.saveCache(paths, key);
      if (cacheId !== -1) {
        core.info(`Saved Harness CLI ${version} to cache`);
      }
    } catch (e) {
      // Cache save failures are non-fatal — next job will just reinstall
      core.info(`Cache save skipped: ${e}`);
    }
  }

  const installed = await readVersionOutput(harnessPath);
  if (!installed || !versionsMatch(installed, version)) {
    throw new Error(
      `Harness CLI install completed but version mismatch: expected ${version}, got: ${installed.trim() || '(no output)'}`,
    );
  }
  if (!fs.existsSync(pluginPath)) {
    throw new Error(`Harness CLI ${version} installed, but the har plugin is missing at ${pluginPath}`);
  }

  core.info(`Using Harness CLI ${version} with the har plugin`);
  core.exportVariable(MARKER_CLI_VERSION, version);
  return { version, harnessPath, cliHome };
}
