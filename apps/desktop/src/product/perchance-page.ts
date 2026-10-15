/** DOM-only adapter for the official generator; no private API or verification bypass. */
export function perchancePage(action: 'inspect' | 'prepare' | 'submit' | 'collect' | 'verify' | 'style', prompt = '', baseline: string[] = [], dimensions: number[] = [], style = ''): string {
  return `(${pageOperation.toString()})(${JSON.stringify({ action, prompt, baseline, dimensions, style })})`
}

/** Runs in a sandboxed remote frame. Only generated blob/data images are collected. */
function pageOperation(input: { action: string; prompt: string; baseline: string[]; dimensions: number[]; style: string }) {
  // The DOM type assumes a body even while a remote frame is still loading.
  const body = document.querySelector('body')
  if (!body) return { ready: false, pending: true, challenge: false, sources: [] }
  const visible = (element: Element) => element.getClientRects().length > 0
  const images = Array.from(document.querySelectorAll('img')).filter(image => visible(image)
    && image.complete && image.naturalWidth >= 256 && image.naturalHeight >= 256
    && (input.dimensions.length !== 2 || image.naturalWidth === input.dimensions[0] && image.naturalHeight === input.dimensions[1])
    && /^(blob:|data:image\/)/.test(image.currentSrc || image.src))
  const sources = images.map(image => image.currentSrc || image.src)
  const fields = Array.from(document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea,input[type=text],input:not([type])')).filter(visible)
  const label = (field: HTMLTextAreaElement | HTMLInputElement) => [field.id, field.name, field.placeholder,
    field.getAttribute('aria-label'), ...Array.from(field.labels ?? []).map(item => item.textContent)].join(' ').toLowerCase()
  let prompts = fields.filter(field => /prompt|description|describe/.test(label(field))
    && !/negative|anti|exclude|avoid/.test(label(field)))
  // img-generator's Description is the sole visible textarea; its caption
  // is not necessarily a programmatically associated <label>.
  if (prompts.length === 0) prompts = fields.filter(field => field instanceof HTMLTextAreaElement
    && !/negative|anti|exclude|avoid/.test(label(field)))
  const buttons = Array.from(document.querySelectorAll<HTMLElement>('button,input[type=button],input[type=submit]')).filter(visible)
    .filter(button => /^(generate(?: images?)?|create(?: images?)?)$/i.test((button.textContent || (button as HTMLInputElement).value || '').replace(/^[^A-Za-z]+/, '').trim()))
  const renderedText: unknown = Reflect.get(body, 'innerText')
  const bodyText = typeof renderedText === 'string' ? renderedText : body.textContent
  const challenge = /verify (?:you are|that you are)|checking your browser|just a moment|verify.*human|captcha/i.test(document.title + ' ' + bodyText.slice(0, 12000))
  if (input.action === 'verify') {
    const boxes = Array.from(document.querySelectorAll<HTMLElement>('input[type=checkbox],[role=checkbox]')).filter((element) => {
      if (!visible(element) || element.getAttribute('aria-disabled') === 'true') return false
      if (element instanceof HTMLInputElement && (element.disabled || element.checked)) return false
      if (element.getAttribute('aria-checked') === 'true') return false
      const text = [element.getAttribute('aria-label'), element.textContent,
        ...(element instanceof HTMLInputElement ? Array.from(element.labels ?? []).map(item => item.textContent) : [])].join(' ')
      return /verify.*human|i(?: am|'m) (?:a )?human|i(?: am|'m) not a robot|确认.*人类|我不是机器人/i.test(text)
    })
    if (boxes.length !== 1) return { clicked: false }
    boxes[0]?.click()
    return { clicked: true }
  }
  const styleMenus = Array.from(document.querySelectorAll('select')).filter(select =>
    /style/i.test([select.id, select.name, select.getAttribute('data-name'), ...Array.from(select.labels).map(item => item.textContent)].join(' '))
    || Array.from(select.options).some(option => /^no style$/i.test(option.text.normalize('NFKC').trim())))
  const styleMenu = styleMenus.length === 1 ? styleMenus[0] : undefined
  const styleLabel = styleMenu?.selectedOptions[0]?.text.trim() ?? null
  const applyStyle = () => {
    if (input.style && styleMenu) {
      const preferred: Record<string, string[]> = {
        anime: ['painted anime', 'anime', 'cartoon'], realistic: ['professional photo', 'casual photo', 'photographic', 'photorealistic', 'realistic', 'photo'],
        pixel: ['pixel art', 'pixel'], artistic: ['digital painting', 'watercolor', 'watercolour', 'illustration', 'painting'],
        generalist: ['no style', 'none'],
      }
      const names = [...(preferred[input.style] ?? []), 'no style']
      const option = names.map(name => Array.from(styleMenu.options).find(item =>
        item.text.normalize('NFKC').trim().toLowerCase().replace(/\s*\(default\)$/i, '') === name)).find(item => item !== undefined)
      if (option && styleMenu.value !== option.value) {
        styleMenu.value = option.value
        styleMenu.dispatchEvent(new Event('input', { bubbles: true }))
        styleMenu.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }
  }
  if (input.action === 'style') { applyStyle(); return { styleLabel: styleMenu?.selectedOptions[0]?.text.trim() ?? null } }
  if (input.action === 'inspect') {
    const shapes = Array.from(document.querySelectorAll('select')).filter(select => /^\d+x\d+$/.test(select.value))
    const dimensions = shapes.length === 1 ? shapes[0]?.value.split('x').map(Number) : undefined
    return { ready: prompts.length === 1 && buttons.length === 1 && dimensions !== undefined, challenge, sources, dimensions, complete: document.readyState === 'complete',
      pageError: /This page has errors|\(syntax error\)/i.test(bodyText), styleLabel,
      styles: styleMenu ? Array.from(styleMenu.options).map(option => option.text.trim()) : [] }
  }
  if (input.action === 'prepare') {
    if (prompts.length !== 1 || buttons.length !== 1) throw new Error('Perchance controls changed or are ambiguous; inspect the official generator window')
    const field = prompts[0]
    const button = buttons[0]
    if (!field || !button) throw new Error('Perchance controls unavailable')
    applyStyle()
    field.value = input.prompt
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
    // The official How many? menu defaults to six after initialization. A tool
    // returns one file; use the smallest count supported by the actual menu
    // (currently three), without injecting unsupported options.
    const counts = Array.from(document.querySelectorAll('select')).filter((select) => {
      const options = Array.from(select.options)
      return options.length > 1 && options.every(option => /^\d+$/.test(option.text.trim()))
        && options.some(option => Number(option.text.trim()) > 0)
    })
    if (counts.length > 1) throw new Error('Perchance image count controls are ambiguous')
    const count = counts[0]
    const minimum = count && Math.min(...Array.from(count.options).map(option => Number(option.text.normalize('NFKC').trim())))
    const single = count && Array.from(count.options).find(option => Number(option.text.trim()) === minimum)
    if (count && single) {
      count.value = single.value
      count.dispatchEvent(new Event('input', { bubbles: true }))
      count.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return { prepared: true }
  }
  if (input.action === 'submit') {
    const field = prompts[0], button = buttons[0]
    if (prompts.length !== 1 || buttons.length !== 1 || !field || !button || field.value !== input.prompt) throw new Error('Perchance prompt changed during page update; retry')
    if ((button as HTMLButtonElement).disabled) throw new Error('Perchance Generate is disabled; wait for the website')
    button.click()
    return { submitted: true }
  }
  const image = images.find(item => !input.baseline.includes(item.currentSrc || item.src))
  if (!image) return { pending: true, challenge }
  // Drawing only same-frame generated blob/data images avoids arbitrary network downloads.
  // A tainted or unreadable image is a failed call, never a successful screenshot.
  const canvas = document.createElement('canvas')
  if (image.naturalWidth * image.naturalHeight > 16777216) throw new Error('Generated image exceeds pixel limit')
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Cannot encode generated image')
  context.drawImage(image, 0, 0)
  const data = canvas.toDataURL('image/png')
  if (data.length > 24 * 1024 * 1024) throw new Error('Generated image exceeds byte limit')
  return { png: data.slice('data:image/png;base64,'.length), width: canvas.width, height: canvas.height }
}
