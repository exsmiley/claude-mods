# claude-mods

Mods for Claude Code.

## agent-stats

Charts how many Claude Code sessions and subagents you start each day, in a pane beside the chat. Open it with `/agent-stats`.

### Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-stats --marketplace exsmiley/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.

## actions-report

A fun monthly report of a repo's GitHub Actions usage, in a pane beside the chat: billable minutes per person, runs, pass rate, a month-end projection, minutes per day, the hungriest workflows, and awards (Minute Muncher, The Red Button, Groundhog Day, Night Owl, Robot Overlord and more), with a sportscaster recap written by Haiku.

```
/actions-report                      # the repo you're in, this month
/actions-report owner/repo 2026-10   # any repo you can read, any month
```

It reads runs through `gh` (signed in with access to the repo) and `python3`. Minutes are an estimate of what GitHub bills: each job rounded up to the minute, × the runner's rate (Linux 1, Windows 2, macOS 10, self-hosted free), credited to whoever triggered the run. A busy month takes about a minute the first time; finished days are cached, so a refresh fetches only the last few.

### Install

```
/plugin install actions-report --marketplace exsmiley/claude-mods
```

## job-status

A live pane for long-running background runs (test sweeps, screenshot comparisons, benchmarks): for each run, newest first, its state, a progress bar, counts by status (ok / skip / diff / fail), elapsed time and ETA, the jobs in flight with how long each has run (slow ones flagged), the latest results with diffs and failures highlighted, and the CPU and memory the run uses right now, including Docker containers it declares (a local Supabase stack, say), with the peak and a machine-wide line for scale. A run whose process is gone, or that stopped writing, is marked stale; finished runs older than a day fold away. Open it with `/job-status`; it also opens by itself when a new run starts.

Any script can feed it: write one JSON file per run to `~/.claude/job-status/<run-id>.json` (format in [job-status/helper/PROTOCOL.md](job-status/helper/PROTOCOL.md)), or from Node use the helper:

```bash
mkdir -p ~/.claude/job-status
curl -fsSL https://raw.githubusercontent.com/exsmiley/claude-mods/main/job-status/helper/status.cjs -o ~/.claude/job-status/status.cjs
```

```js
const { createStatus } = require(require('os').homedir() + '/.claude/job-status/status.cjs')
const st = createStatus({ id: 'nightly-e2e', title: 'Nightly e2e', total: 640 })
st.start('login@chrome', { pid: child.pid }) // pid optional: per-job CPU / RAM
st.finish('login@chrome', 'diff', '412 px differ')
st.end('done')
```

`helper/demo.cjs` fakes a 30-job run to try it. CPU and memory come from `ps` (macOS and Linux); the machine's total RAM is shown on macOS.

### Install

```
/plugin install job-status --marketplace exsmiley/claude-mods
```
