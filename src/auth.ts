export interface AuthInputs {
  apiUrl: string;
  account: string;
  token: string;
  org: string;
  project: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  silent?: boolean;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.replace(
    new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    '***',
  );
}

export async function login(inputs: AuthInputs, harnessPath: string, execFn: ExecFn): Promise<void> {
  const args = [
    'auth', 'login',
    '--api-url', inputs.apiUrl,
    '--account', inputs.account,
    '--api-token', inputs.token,
    '--org', inputs.org,
    '--project', inputs.project,
    '--overwrite',
  ];

  const { exitCode, stdout, stderr } = await execFn(harnessPath, args, { silent: true });

  if (exitCode !== 0) {
    const raw = [stdout, stderr].filter(Boolean).join('\n').slice(0, 2048);
    throw new Error(`harness auth login failed (exit ${exitCode}): ${redact(raw, inputs.token)}`);
  }
}
