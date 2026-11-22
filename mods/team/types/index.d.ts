export type TeamMessage = { at: number; from: string; to: string; text: string }
export type Stage = {
  role: 'search' | 'write' | 'review'
  title: string
  agentId?: string
  status: 'waiting' | 'running' | 'done' | 'failed'
  result?: string
}
export type Pipeline = { query: string; stages: Stage[] } | null

declare module 'claude-code' {
  interface PluginState {
    team: {
      messages: Shaped<TeamMessage[]>
      pipeline: Shaped<Pipeline>
    }
  }
}
