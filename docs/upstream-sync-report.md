# Upstream sync implementation report

Date: 2026-09-22

## Result

The repository now checks the latest `Dev-Jahn/khala-network` GitHub release
every six hours and on either supported dispatch event. A newer release is
vendored only after its tag, CLI version, commit, and all four platform asset
digests are verified. The workflow tests the changed tree, commits only the two
vendor files, pushes to `main`, and dispatches `ci.yml` for the marketplace
hand-off. The package and plugin versions remain `0.2.1`; the pinned vendor
content remains `0.9.7` so the first automatic run is observable.

All test and validation commands were run under
`nice -n 19 taskset -c 20-71` as required on b200.

## P1: sync behavior and refusal rules

RED was established before production code existed:

```text
$ nice -n 19 taskset -c 20-71 node --test test/sync-upstream.test.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../scripts/sync-upstream.mjs'
tests 1; pass 0; fail 1
```

After implementation, the focused suite passed:

```text
$ nice -n 19 taskset -c 20-71 node --test test/sync-upstream.test.mjs
tests 6; pass 6; fail 0
```

The cases cover numeric version comparison, newer -> vendor, equal -> up to
date without checkout or mutation, backwards refusal, tag/CLI mismatch refusal,
and refusal when any required asset digest is absent.

## P2: live dry-run

The command was bracketed by `git status --short` and `cmp`; `cmp` exited zero,
confirming that the dry-run did not write repository files.

```text
$ nice -n 19 taskset -c 20-71 node scripts/sync-upstream.mjs --dry-run
Khala 0.9.8 is available at c967756b3172dba1fbc2eec8bb4ca40d93c7541d.
khala-link-darwin-amd64 sha256:a97dcbd84f7de5f70c8140946594364aeff381708f3036b48d45f147b1d03e82
khala-link-darwin-arm64 sha256:244b50969e28f3493e49dac7a4b471651ead952c014fa2157889c1ea63172ffd
khala-link-linux-amd64 sha256:887911f1fc894a143a31b7d8a8542ef06fdd86938a655cd49ed74ecf3ec81ab7
khala-link-linux-arm64 sha256:aa4a6f6e80d5e3a5ee4c55619f40fb109ae3097210deb5157e033ea2fff7cc57
Dry run: no files changed.
Upstream sync found a newer release.
```

## P3: repository validation

```text
$ nice -n 19 taskset -c 20-71 node scripts/check.mjs
Plugin 0.2.1, hooks, skill, and pinned vendor files validated.

$ TMPDIR=/NHNHOME/jahn/.khala-sync-test-tmp nice -n 19 taskset -c 20-71 npm test
tests 30; pass 30; fail 0
```

The initial default-`/tmp` run produced four `EACCES` fixture failures because
the host mounts `/tmp` with `noexec`, as already documented in the README. A
first executable `TMPDIR` inside the worktree fixed those but exposed three
`EINVAL` Unix-socket failures because the worktree path was too long. The final
short executable `TMPDIR` above passed without changing tests or product code.
The temporary directory was removed afterward.

## P4: workflow validation

`actionlint` was not installed. The workflow was parsed with PyYAML through
`uv`, and assertions checked the schedule, `workflow_dispatch`,
`repository_dispatch` type, permissions, and concurrency setting:

```text
$ nice -n 19 taskset -c 20-71 uv run --with pyyaml python -c '<parse and assertions>'
workflow YAML and required triggers/permissions validated
```

A direct inspection also confirmed that validation, tests, commit, push, and CI
dispatch are conditional on changed vendor files. The marketplace hand-off is
`gh workflow run ci.yml --ref main`, not reliance on the token-authored push.
The workflow was not run and nothing was pushed.
