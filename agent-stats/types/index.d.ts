/** One local calendar day: sessions started and subagents launched, by type. */
export type DayStats = { sessions: number; subagents: number; types: Record<string, number> }

/** Every day seen so far, keyed `YYYY-MM-DD`, and when the transcripts were last read. */
export type History = { days: Record<string, DayStats>; scannedAt: number; error?: string }

/** How many days the charts show; 0 is all of them. */
export type Range = 14 | 30 | 0

declare module 'claude-code' {
  interface PluginState {
    'agent-stats': {
      history: Shaped<History | null>
      range: Range
    }
  }
}
