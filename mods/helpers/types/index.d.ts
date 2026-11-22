export type Spend = { day: string; usd: number }

declare module 'claude-code' {
  interface PluginState {
    helpers: {
      spend: Shaped<Spend | null>
      hasAnswer: boolean
    }
  }
}
