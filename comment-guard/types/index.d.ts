export type CommentGuardDenied = { mode: 'edit' | 'heredoc' | 'commit' | 'post'; lines: number; chars: number; t: number; key: string | null }

declare module 'claude-code' {
  interface PluginState {
    'comment-guard': {
      approved: string[]
      denied: Record<string, CommentGuardDenied>
      live: number[]
    }
  }
}
