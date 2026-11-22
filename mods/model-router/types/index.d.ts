export type Tier = 'haiku' | 'sonnet' | 'opus'
export type Choice = { tier: Tier; reason: string; prompt: string }

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      choice: Shaped<Choice | null>
      isOn: boolean
    }
  }
}
