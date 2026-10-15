/** Live installer progress through the public, session-owned jobs surface. */
import type { JobHandle, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { 'godot-prepare': 'godot-prepare' } }

/** Observe bounded installer stderr; quick cache hits never create a visible job. */
export function observeGodotPreparation(
  handle: SubprocessHandle, jobs: JobRegistry | undefined, owner: SessionId | undefined, cancel: () => void,
): (outcome: JobOutcome) => void {
  if (jobs === undefined || owner === undefined) return () => {}
  let job: JobHandle | undefined, offset = 0, pending = '', latest = 'Preparing Godot 4.6…'
  let settle!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolve) => { settle = resolve })
  const poll = (): void => {
    const chunk = handle.collected.stderr?.readFrom(offset)
    if (chunk === undefined) return
    offset = chunk.nextOffset
    pending = (pending + chunk.text).slice(-8192)
    const lines = pending.split(/\r?\n/u); pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('Godot: ')) continue
      latest = line.slice(0, 512)
      job?.append(latest + '\n', { channel: 'log' })
      job?.updateProgress(latest)
    }
  }
  const timer = setInterval(poll, 500)
  const start = setTimeout(() => {
    poll()
    try { jobs.start({ kind: 'godot-prepare', label: 'Prepare Godot 4.6', owner, outputLimitBytes: 8192,
      run: (progress) => { job = progress; progress.updateProgress(latest); return { cancel, done } },
    }) } catch (error) { console.warn('Godot progress job unavailable', error) }
  }, 1500)
  return (outcome) => { clearTimeout(start); clearInterval(timer); poll(); settle(outcome) }
}
