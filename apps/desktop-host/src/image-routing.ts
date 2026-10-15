/** Deterministic style selection over live workers and official Horde model metadata. */
import type { HordeModel } from './aihorde-api.ts'

/** Public model facts used for text-to-image selection. */
export interface ModelReference { style: string; description: string; inpainting: boolean }
/** Official metadata indexed by exact model name. */
export type ModelReferences = Record<string, ModelReference>

/**
 * Read official metadata through the Host's installed proxy policy, with bounded fallback.
 * @param signal - Caller cancellation.
 * @param networkMs - Per-source deadline.
 * @param request - Replaceable fetch transport.
 * @returns Validated routing facts without download URLs or private fields.
 */
export async function fetchModelReferences(signal: AbortSignal, networkMs: number,
  request: typeof fetch = fetch): Promise<ModelReferences> {
  for (const url of ['https://models.aihorde.net/api/model_references/v2/image_generation',
    'https://raw.githubusercontent.com/Haidra-Org/AI-Horde-image-model-reference/main/stable_diffusion.json']) {
    signal.throwIfAborted()
    try {
      const response = await request(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(networkMs)]), redirect: 'error' })
      if (!response.ok || response.body === null) throw new Error('Model metadata unavailable')
      const reader = response.body.getReader(), parts: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.length
          if (bytes > 16 * 1024 * 1024) throw new Error('Model metadata exceeds limit')
          parts.push(chunk.value)
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      const data: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
      if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('Invalid model metadata')
      const models: ModelReferences = {}
      for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null || !('style' in value) || typeof value.style !== 'string') continue
        models[name] = { style: value.style.toLowerCase(), description: 'description' in value && typeof value.description === 'string'
          ? value.description.slice(0, 4000) : '', inpainting: 'inpainting' in value && value.inpainting === true }
      }
      if (Object.keys(models).length === 0) throw new Error('Model metadata contains no styles')
      return models
    } catch { signal.throwIfAborted() }
  }
  throw new Error('Official model metadata unreachable or invalid')
}

/**
 * Rank online text-to-image models by requested style, then queue estimate and worker count.
 * @param prompt - Content description.
 * @param style - Optional natural-language aesthetic; never a channel/model override.
 * @param models - Fresh official availability snapshot.
 * @param references - Official style and capability metadata.
 * @returns Ranked candidates and the inferred style; queue estimates remain estimates.
 */
export function rankImageModels(prompt: string, style: string | undefined, models: HordeModel[], references: ModelReferences) {
  const text = (style?.trim() || prompt).toLowerCase()
  const target = /pixel|像素/.test(text) ? 'pixel' : /anime|cartoon|漫画|动漫|二次元|卡通/.test(text) ? 'anime'
    : /photo|realistic|photoreal|摄影|照片|写实/.test(text) ? 'realistic'
      : /paint|watercolou?r|illustration|concept art|油画|水彩|插画|概念/.test(text) ? 'artistic' : 'generalist'
  const candidates = models.flatMap((model) => {
    const reference = references[model.name]
    if (model.workers <= 0 || !reference || reference.inpainting || /inpainting/i.test(model.name)) return []
    const pixel = /pixel|像素/i.test(model.name + ' ' + reference.description)
    const score = target === 'pixel' && pixel ? 10 : target === reference.style ? 10
      : reference.style === 'generalist' ? 2 : target === 'generalist' && reference.style === 'artistic' ? 1 : 0
    return score > 0 ? [{ ...model, styleScore: score, matchedStyle: reference.style }] : []
  }).sort((a, b) => b.styleScore - a.styleScore
    || (a.queueClearEstimateSeconds ?? Infinity) - (b.queueClearEstimateSeconds ?? Infinity)
    || b.workers - a.workers || a.name.localeCompare(b.name))
  return { targetStyle: target, candidates }
}
