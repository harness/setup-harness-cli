# Setup Harness CLI

[![CI](https://github.com/harness/setup-harness-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/harness/setup-harness-cli/actions/workflows/ci.yml)

A GitHub Action that installs and authenticates the [Harness CLI (`harness`)](https://github.com/harness/cli) with its Artifact Registry (`har`) plugin. After the action runs, `harness` is on `PATH` and authenticated, so you can push and manage artifacts in Harness Artifact Registry in the subsequent steps.

## Prerequisites

- A Harness account with Artifact Registry
- A Harness Personal Access Token (PAT) stored as a GitHub secret
- The Harness organization and project that contain your registry

## Quick Start

```yaml
steps:
  - uses: actions/checkout@v4

  - name: Setup Harness CLI
    uses: harness/setup-harness-cli@v2
    with:
      api-url: ${{ secrets.HARNESS_URL }}
      account: ${{ secrets.HARNESS_ACCOUNT_ID }}
      token: ${{ secrets.HARNESS_PAT_TOKEN }}
      org: my-org
      project: my-project

  - name: Push artifact
    run: harness push artifact:generic my-registry/my-app build.tar.gz --version 1.0.0
```

## Examples

### Push multiple artifact types

```yaml
- uses: harness/setup-harness-cli@v2
  with:
    api-url: ${{ secrets.HARNESS_URL }}
    account: ${{ secrets.HARNESS_ACCOUNT_ID }}
    token: ${{ secrets.HARNESS_PAT_TOKEN }}
    org: my-org
    project: my-project

- run: harness push artifact:generic my-registry/my-app build.tar.gz --version 1.0.0
- run: harness push artifact:python my-registry dist/my_pkg-1.0.0-py3-none-any.whl
- run: harness push artifact:npm my-registry my-pkg-1.0.0.tgz
- run: harness push artifact:rpm my-registry package.rpm
```

Generic artifacts take `<registry>/<name>`. Package types such as Python, npm, and RPM take only the registry, because the name and version come from the package file. Run `harness push artifact:<type> --help` for the flags each package type supports.

### Reuse credentials across multiple jobs

Set credentials at the workflow level using environment variables so that every job picks them up without repeating `with:`:

```yaml
env:
  HARNESS_URL:        ${{ secrets.HARNESS_URL }}
  HARNESS_ACCOUNT_ID: ${{ secrets.HARNESS_ACCOUNT_ID }}
  HARNESS_PAT_TOKEN:  ${{ secrets.HARNESS_PAT_TOKEN }}
  HARNESS_ORG_ID:     my-org
  HARNESS_PROJECT_ID: my-project

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: harness/setup-harness-cli@v2
      - run: harness push artifact:generic my-registry/my-app build.tar.gz --version 1.0.0

  publish-python:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: harness/setup-harness-cli@v2
      - run: harness push artifact:python my-registry dist/my_pkg-1.0.0-py3-none-any.whl
```

> Note: the CLI and the `har` plugin are cached by version, operating system, and architecture. Later jobs on the same runner type restore them from cache instead of downloading them again.

### Pin to a specific CLI version

```yaml
- uses: harness/setup-harness-cli@v2
  with:
    api-url: ${{ secrets.HARNESS_URL }}
    account: ${{ secrets.HARNESS_ACCOUNT_ID }}
    token: ${{ secrets.HARNESS_PAT_TOKEN }}
    org: my-org
    project: my-project
    cli-version: v3.12.0
```

To always install the latest release, omit `cli-version` (or set it to `latest`).

### Use the resolved version in later steps

```yaml
- name: Setup Harness CLI
  id: setup
  uses: harness/setup-harness-cli@v2
  with:
    api-url: ${{ secrets.HARNESS_URL }}
    account: ${{ secrets.HARNESS_ACCOUNT_ID }}
    token: ${{ secrets.HARNESS_PAT_TOKEN }}
    org: my-org
    project: my-project

- run: echo "Running with Harness CLI ${{ steps.setup.outputs.cli-version }}"
```

## Inputs

You can provide the credentials and scope as action inputs or as environment variables.

> Note: Inputs take precedence when both action inputs and environment variables are set.

| Input | Environment Variable | Required | Default | Description |
|-------|---------|----------|---------|-------------|
| `api-url` | `HARNESS_URL` | yes | - | Harness API base URL, no trailing slash. |
| `account` | `HARNESS_ACCOUNT_ID` | yes | - | Harness account ID. |
| `token` | `HARNESS_PAT_TOKEN` | yes | - | Harness PAT token. Always pass using `${{ secrets.* }}` - the action masks it from logs automatically. |
| `org` | `HARNESS_ORG_ID` | yes | - | Harness organization ID. |
| `project` | `HARNESS_PROJECT_ID` | yes | - | Harness project ID. |
| `cli-version` | - | no | `latest` | Harness CLI release tag to install from [harness/cli](https://github.com/harness/cli/releases) (for example, `v3.12.0`). Defaults to the latest release. |
| `github-token` | - | no | `${{ github.token }}` | Token used to call the GitHub API when resolving the latest release. The default workflow token is sufficient. |

## Outputs

| Output | Description |
|--------|-------------|
| `cli-version` | The resolved Harness CLI version that was installed (for example, `v3.12.0`). |

## How it works

1. **Resolves version** - if `cli-version` is `latest`, fetches the current release tag of `harness/cli` from the GitHub Releases API.
2. **Restores cache** - looks for the cached CLI and `har` plugin keyed by version + OS/arch. On a hit, restores without downloading again.
3. **Installs** - on a cache miss, downloads the `harness-bundle` archive from GitHub Releases, verifies its SHA-256 checksum against the published checksums file, installs `harness`, and registers the `har` plugin.
4. **Authenticates** - runs `harness auth login` with the provided credentials, organization, and project. The PAT token is masked before any logging.
5. **Health check** - runs `harness version` to confirm the CLI is usable before reporting ready.
6. **Cleanup** - after the job finishes (even on failure), runs `harness auth logout` and deletes the stored credentials from the runner.

The CLI uses a dedicated home directory under `RUNNER_TEMP` (exported as `HARNESS_CLI_HOME`), so it never reads or changes an existing `~/.harness` on self-hosted runners.

## Migrating from v1

`v2` installs the new Harness CLI from [harness/cli](https://github.com/harness/cli) instead of `hc` from `harness/harness-cli`. `v1` keeps working with `hc`.

- Change `harness/setup-harness-cli@v1` to `harness/setup-harness-cli@v2`.
- Set `org` and `project` (or `HARNESS_ORG_ID` and `HARNESS_PROJECT_ID`). They are now required.
- Rename the `hc-version` input and output to `cli-version`, and use a `harness/cli` tag such as `v3.12.0`.
- Replace `hc artifact push <type> <registry> <file> --name <name>` with `harness push artifact:<type> <registry>/<name> <file>`. For example:

```text
hc artifact push generic my-registry build.tar.gz --name my-app --version 1.0.0
harness push artifact:generic my-registry/my-app build.tar.gz --version 1.0.0
```

## Security

- The PAT token is masked using `core.setSecret` before any command runs. The token will never appear in the logs.
- The CLI bundle is verified against a SHA-256 checksum published alongside the release before anything in it is executed.
- Credentials are automatically removed from the runner at the end of each job through the post-step cleanup.

## Contributing

Refer [CONTRIBUTING.md](https://github.com/harness/harness/blob/main/CONTRIBUTING.md).

## License

Apache License 2.0. Refer [LICENSE](LICENSE).


<!-- BT-24203: onboarding PR to trigger centralisedTsCoverageCheck validation; no functional change. -->
