export type Todo = { text: string; isDone: boolean; day: string }
export type Mail = { from: string; subject: string; note?: string }
export type Project = { name: string; progress: number; next?: string }
export type Board = { todos: Todo[]; mail: Mail[]; projects: Project[]; updatedAt?: string }

declare module 'claude-code' {
  interface PluginState {
    morning: { board: Shaped<Board> }
  }
}
