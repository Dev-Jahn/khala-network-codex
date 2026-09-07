# Khala for Codex

Durable mail between **Codex and Claude Code**, on the same machine or across
your SSH-connected fleet. This is the Codex harness adapter for
[Khala Network](https://github.com/Dev-Jahn/khala-network).

The original Khala brain and transport own every message, acknowledgement,
bounce, expiry, stream and cursor. This repository adds Codex identity binding,
hooks, a channel adapter, and an App Server launcher. Mail never becomes a
forged user prompt.

## Install

Requires Linux or macOS, Node.js 22+, Codex CLI 0.153.4+, Bash, SSH and rsync.
Native automatic receive requires the shared Khala runtime 0.9.7+.

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
node's existing service manager. `run` checks the running conduit's fresh version
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
khala-codex run
```

`run` starts a local Codex App Server in a private Unix socket directory, a
Khala bridge, and a TUI connected to that server. The launcher owns those
children and cleans them up when the TUI exits. To resume a session, use
`khala-codex run resume <thread-id>`.

| Mode | Sending and reading | Receiving while active | Waking while idle |
|---|---|---|---|
| `khala-codex run` + trusted plugin hooks | Yes | Native tool output | Yes, while launcher is running |
| Existing App Server + explicit bridge | Yes | Native tool output | Yes, while bridge/server are running |
| Standalone Codex + trusted plugin hooks | Yes | Hook reminders at tool/user boundaries | No |
| CLI only | Yes | Explicit drain | No |

For an existing App Server, start it with `KHALA_CODEX_SOCKET=/absolute/app.sock`
so hooks record its address, and run
`khala-codex bridge --socket /absolute/app.sock` alongside it. The bridge only
acts on explicitly bound, loaded threads whose cwd matches. It never resumes
an unloaded thread. `khala-codex bind` can register the current
`CODEX_THREAD_ID`; `session` displays the binding. A stale binding is removed
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
read at the next drain. Hook mode can also remind about joined, non-quiet
streams during a turn. Duplicate channel attempts are coalesced for the same
generation, conduit retry index and drain stamp. Hooks never insert message bodies as developer text,
and the bridge never inserts user messages or types into a terminal.

Native listeners record `codex` in the shared runtime, independently of model
and profile. Claude and Codex listeners share identity leases: concurrent listeners
cannot own the same receiving identity. Stop hooks write the shared turn-evidence stamp;
the upstream conduit owns re-ring policy and watching presence.

## Develop and release

```sh
npm test
node scripts/check.mjs
```

The real conduit/App Server fixture is opt-in and runs one small model turn
using the configured Codex account:

```sh
node scripts/test-live.mjs ~/.khala/bin/khala-link
```

Runtime dependencies are vendored with licenses and checksums, so installation
needs no npm download. `vendor/khala/khala` is an unchanged upstream brain;
`vendor/khala/upstream.json` pins its Git commit, version and release digests.
Update it with `node scripts/vendor-khala.mjs /path/to/upstream-checkout` after
the upstream public release exists. See [compatibility](docs/compatibility.md).

Main-branch CI validates and tests the plugin before automatically updating its
exact commit pin in `Dev-Jahn/jahns-codex-marketplace`. Cross-repository write
uses a deploy key scoped to that marketplace. See the checked-in workflow.

MIT. The vendored Khala brain and `ws` library retain their original licenses.
