/** Keyless provider fixture for logical free-auto routing through a shipped headless profile. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

export const inject = ['llm']
class Routes extends LlmAdapter {
  override listModels(provider: string) {
    return Promise.resolve(['first-free', 'second-free'].map(id => ({ provider, id, name: id })))
  }
  override resolveModel(provider: string, id: string) {
    return Promise.resolve({ provider, id, name: id, inputModalities: ['text'] as const,
      context: { contextWindow: 128000 }, defaultMaxTokens: 8192 })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.model === 'first-free') {
      yield { type: 'text-delta', index: 0, text: 'This failed partial answer must stay hidden.' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'Fixture route unavailable' } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'free-auto completed successfully.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'free-auto completed successfully.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
/** Register deterministic anonymous candidates; no network or credentials. @param ctx - Profile-owned context. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter(['snapshot-free'], new Routes()))
}
