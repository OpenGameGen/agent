/** Validate official output embed configuration before collecting its generated bitmap. */
export function perchanceOutput(url: string, prompt: string, dimensions: number[]): 'output' | 'unrelated' | 'invalid' {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://image-generation.perchance.org' || parsed.pathname !== '/embed') return 'unrelated'
    const config: unknown = JSON.parse(decodeURIComponent(parsed.hash.slice(1)))
    if (typeof config !== 'object' || config === null || !('prompt' in config) || typeof config.prompt !== 'string'
      || !('resolution' in config) || typeof config.resolution !== 'string') return 'invalid'
    if (config.prompt === '(syntax error)' || !config.prompt.includes(prompt) || config.resolution !== dimensions.join('x')) return 'invalid'
    return 'output'
  } catch { return 'invalid' }
}
