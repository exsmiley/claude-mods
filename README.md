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
