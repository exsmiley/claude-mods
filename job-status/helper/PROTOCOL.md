# job-status: live status for long-running runs

Any script can show its progress in Claude's **Job status** pane (the `job-status`
mod; open it with `/job-status`). The pane polls this folder every ~2.5 s.

## Protocol

One JSON file per run: `~/.claude/job-status/<run-id>.json`.
Rewrite it **atomically** on every change: write `.<run-id>.<pid>.tmp` in this
folder, then `rename` it over the real file. Files starting with `.` are ignored.

```jsonc
{
  "version": 1,
  "id": "shots-2026-11-18",          // filename-safe: [A-Za-z0-9._-]
  "title": "Screenshot compare",
  "startedAt": "2026-11-18T20:00:00Z", // ISO string or epoch ms
  "updatedAt": "2026-11-18T20:41:12Z", // bump at least every 60 s while running (heartbeat)
  "endedAt": "…",                       // optional, set when state leaves "running"
  "state": "running",                   // running | done | failed | stopped
  "total": 640,                         // optional; enables the progress bar and ETA
  "counts": { "ok": 400, "skip": 5, "diff": 6, "fail": 1 }, // any extra keys are shown too
  "running": [{ "label": "group/scenario@site", "startedAt": "…", "pid": 12399 }], // pid optional: per-job CPU/RAM
  "recent":  [{ "label": "…", "status": "diff", "detail": "412 px differ", "at": "…", "ms": 84000 }], // last ~20, oldest first
  "notes":   ["20:40:01 lane 3 restarted"],  // last ~10
  "pid": 12345,                         // the writer's pid; the pane marks the run stale when it is gone
  "lanes": 8,                           // optional: parallelism, used for early ETA
  "finishedJobs": 410, "totalJobMs": 34440000, // optional: for the average job time (skips excluded)
  "cwd": "…", "logFile": "…",           // optional, informational
  "watch": {                            // optional: what else this run's CPU / RAM includes
    "docker": ["supabase_*_my-stack"],  //   containers by name; `*` wildcard, no `*` = substring
    "pids": [23456],                    //   other process roots (a dev server started elsewhere)
    "names": ["postgres"]               //   processes whose executable path contains this
  }
}
```

Done = sum of `counts`. Status strings are free-form, lowercase; `ok`, `skip`,
`diff`, `fail` are coloured (diff = warning, fail/error = red).

The pane marks a `running` run **stale** when its `pid` no longer exists or
`updatedAt` is more than 90 s old. Finished runs older than a day collapse into
one line. Delete a run's file to remove it from the pane.

CPU and memory: each poll the pane runs one `ps -A` and sums CPU% and RSS over
the run's `pid` and every process under it (so child browsers, servers and
workers count), shows that against the machine's RAM (amber over 50%, red over
75%), keeps the peak, and the process count. A running job that carries its own
`pid` gets its own CPU / RAM beside its row. CPU% is `ps`'s (100% = one core).

Things a run uses that aren't its child processes, above all **Docker
containers** (a local Supabase stack runs inside Docker's VM, not under the
run's pid), are counted only when the run lists them under `watch`. The pane
then shows three lines: **Run** (the process trees), **Docker** (matching
containers, from `docker stats` every ~10 s) and **Total**, with the peak. If
containers are running that the run doesn't list, it says so instead of
quietly leaving them out. A **Machine** line at the top shows the whole
machine (CPU across all cores, RAM in use) and all of Docker, for scale.

## Node helper

```js
const { createStatus } = require(require('os').homedir() + '/.claude/job-status/status.cjs')
const st = createStatus({ id: 'shots-2026-11-18', title: 'Screenshot compare', total: 640, lanes: 8,
  watch: { docker: ['supabase_*_my-stack'] } })  // optional: count these containers too
st.watch({ pids: [devServer.pid] })             // add more later (merges)
st.start('group/scenario@site')                 // job began
st.start('group/scenario@site', { pid: child.pid }) // …or with the job's own process
st.pid('group/scenario@site', child.pid)        // set it later, once spawned
st.finish('group/scenario@site', 'diff', '412 px differ') // ok | skip | diff | fail | anything
st.note('lane 3 restarted')
st.set({ total: 650 })                          // merge any top-level fields
st.end('done')                                  // done | failed | stopped
st.remove()                                     // optional: delete the file
```

The helper writes atomically, heartbeats every 15 s (unref'd timer), never
throws on write errors, and on process `exit` without `end()` marks the run
`stopped`. `JOB_STATUS_DIR` overrides the folder. Other languages: just write
the JSON above with temp-file + rename.
