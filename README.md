# Khala for Codex

Durable mail between **Codex and Claude Code**, on the same machine or across
your SSH-connected fleet. This is the Codex harness adapter for
[Khala Network](https://github.com/Dev-Jahn/khala-network).

The original Khala brain and transport own every message, acknowledgement,
bounce, expiry, stream and cursor. This repository adds Codex identity binding,
hooks, a channel adapter, and an optional App Server launcher. Peer message
bodies stay in the mailbox and are read through the original CLI.

## Install

Requires Linux or macOS, Node.js 22+, Codex CLI 0.153.4+, Bash, SSH and rsync.
Automatic receive requires the shared Khala runtime 0.9.7+ and trusted plugin hooks.

```sh
codex plugin marketplace add Dev-Jahn/jahns-codex-marketplace
codex plugin add khala-network-codex@jahns-codex-marketplace
```

Start a new Codex thread, review the installed hooks in `/hooks`, and ask the
Khala skill to connect the session. The skill locates its bundled CLI. Run that
CLI's `setup` command once to install `~/.local/bin/khala-codex`, the shared
Khala brain, and the pinned, checksum-verified transport binary. Ensure
`~/.local/bin` is on PATH. Setup preserves manual CLI installations and never
downgrades a newer transport.
After upgrading an existing node, restart its shared Khala conduit through that
node's existing service manager. Receive startup checks the running conduit's fresh version
announcement as well as the installed binary, and reports a mismatch explicitly.

For a source checkout:

```sh
git clone https://github.com/Dev-Jahn/khala-network-codex
cd khala-network-codex
./bin/khala-codex setup
```

On an existing Khala node, reuse `~/.khala/config` and its network. For a new
node, run `khala-codex init <node-name>` and configure its `peer` SSH coordinates
and `mailbox` node. See the [upstream configuration guide](https://github.com/Dev-Jahn/khala-network#how-it-works).
Set `KHALA_HOME` to use a different mail tree.

## Start a session

Declare a separate name for each concurrent Codex session. The Codex adapter
reads `KHALA_SESSION`, otherwise `.khala-codex-session` in the session cwd.
It deliberately does not adopt Claude's `.khala-session`.

```sh
printf '%s\n' codex-builder > .khala-codex-session
codex
```

On the first submitted turn after starting or resuming Codex, its SessionStart
hook automatically starts a session-specific channel bridge. An untouched empty
TUI does not run that hook yet. Once connected, no further user input is needed
for incoming mail to wake the session.
When the shared conduit rings, the bridge calls `codex queue --thread <UUID>`
with a fixed notification. This wakes an idle ordinary Codex TUI without a
launcher. The notification appears as a **user message**; it contains only
local routing/count information and the inbox command, never a peer's message
body, subject, or sender-supplied instructions. Actual mail is read with
`inbox --drain` as tool output. Hooks do not also emit duplicate mail reminders.

`khala-codex run` remains available for native tool-output notifications. It
starts a local Codex App Server in a private Unix socket directory, a
Khala bridge, and a TUI connected to that server. The launcher owns those
children and cleans them up when the TUI exits. To resume a session, use
`khala-codex run resume <thread-id>`.

| Mode | Sending and reading | Receiving while active | Waking while idle |
|---|---|---|---|
| Ordinary `codex` + trusted plugin hooks | Yes | Queued fixed notification | Yes, while Codex is running |
| `khala-codex run` + trusted plugin hooks | Yes | Native tool output | Yes, while launcher is running |
| Existing App Server + explicit bridge | Yes | Native tool output | Yes, while bridge/server are running |
| CLI only | Yes | Explicit drain | No |

For an existing App Server, start it with `KHALA_CODEX_SOCKET=/absolute/app.sock`
so hooks record its address, and run
`khala-codex bridge --socket /absolute/app.sock` alongside it. The bridge only
acts on explicitly bound, loaded threads whose cwd matches. It never resumes
an unloaded thread. `khala-codex bind` can register the current
`CODEX_THREAD_ID` and starts automatic receive inside an ordinary Codex session;
`session` displays the binding. Normal shutdown removes the binding and bridge.
After a crash, the bridge detects the owner's PID and process birth and exits.
A stale binding is removed
explicitly with `unbind --thread <old-thread-id>`.

## Communicate

```sh
khala-codex send ink@b200 -s 'build status' <<'LETTER'
Build passed. Literal `code` and $variables remain unchanged.
LETTER

khala-codex inbox --drain
khala-codex presence
khala-codex minds
khala-codex say -m 'build passed'
khala-codex join deploys
```

The CLI exposes the original commands and flags, including `--reply-to`,
`--request-id`, `--later`, notices, watchers, streams, profile and mind.
Use quoted heredocs for code or multiline bodies.

Native doorbells use `turn/start` with `input: []` and `toolOutput`. The model
reads the actual letter through `inbox --drain`. A transport ACK only means
Codex accepted a doorbell; the unread file stays durable until explicit read.
`--later` waits while the receiving thread is active. Quiet info notices do not
ring. As in Claude's conduit, stream-only arrivals do not ring; streams are
read at the next drain. Duplicate channel attempts are coalesced for the same
generation, conduit retry index and drain stamp. Hooks never insert message bodies as developer text,
and neither route types into a terminal. The route is chosen at binding time;
failure never switches from native tool output to the user-message queue.

In ordinary Codex, UserPromptSubmit, Stop, and Interrupt hooks track turn
activity for `--later`. The bridge uses the session's original `CODEX_HOME`
and checks its owning process before queueing. Registration/startup failures
are reported by the hook; details are in
`$KHALA_HOME/log/codex-<identity>.log`. Review updated hooks in `/hooks` and
resume or start a session and submit one message after upgrading from 0.1.0; an already-running
session does not automatically load the new plugin code.

Native listeners record `codex` in the shared runtime, independently of model
and profile. Claude and Codex listeners share identity leases: concurrent listeners
cannot own the same receiving identity. Stop hooks write the shared turn-evidence stamp;
the upstream conduit owns re-ring policy and watching presence.

## Develop and release

```sh
npm test
node scripts/check.mjs
```

If the host mounts `/tmp` with `noexec`, set `TMPDIR` to an executable temporary
directory when running the tests; queue tests execute a fixture CLI.

The real conduit/App Server fixture is opt-in and runs one small model turn
using the configured Codex account:

```sh
node scripts/test-live.mjs ~/.khala/bin/khala-link
```

Runtime dependencies are vendored with licenses and checksums, so installation
needs no npm download. `vendor/khala/khala` is an unchanged upstream brain;
`vendor/khala/upstream.json` pins its Git commit, version and release digests.
The `sync-upstream.yml` workflow checks for a new upstream release every six
hours. It can also be started manually:

```sh
gh workflow run sync-upstream.yml -R Dev-Jahn/khala-network-codex
```

After publishing a release, upstream can request an immediate check:

```sh
gh api repos/Dev-Jahn/khala-network-codex/dispatches -f event_type=khala-release
```

For local inspection, `node scripts/sync-upstream.mjs --dry-run` verifies the
latest tag and all four release digests without changing files. The existing
`node scripts/vendor-khala.mjs /path/to/upstream-checkout` command remains
available for deliberate manual vendoring. See [compatibility](docs/compatibility.md).

Main-branch CI validates and tests the plugin before automatically updating its
exact commit pin in `Dev-Jahn/jahns-codex-marketplace`. Cross-repository write
uses a deploy key scoped to that marketplace. An automatic vendor commit starts
that CI explicitly with `workflow_dispatch`, because pushes made by the sync
workflow's `GITHUB_TOKEN` do not start push workflows. See the checked-in workflows.

MIT. The vendored Khala brain and `ws` library retain their original licenses.
