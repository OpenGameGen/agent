import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import { perchancePage } from '../src/product/perchance-page.ts'

function page(html: string) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' })
  dom.window.Element.prototype.getClientRects = () => [{ width: 10 }] as unknown as DOMRectList
  return dom
}
function evaluate(dom: JSDOM, script: string): Record<string, unknown> {
  const value: unknown = dom.window.eval(script)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid generator page result')
  return value as Record<string, unknown>
}
it('submits only an unambiguous positive prompt and Generate button', () => {
  const dom = page('<textarea placeholder="Description"></textarea><textarea placeholder="Negative prompt"></textarea><select><option value="512x768">Portrait</option></select><button>✨ generate</button>')
  let clicks = 0
  dom.window.document.querySelector('button')!.addEventListener('click', () => clicks++)
  expect(evaluate(dom, perchancePage('inspect')).ready).toBe(true)
  dom.window.eval(perchancePage('prepare', 'a blue robot'))
  expect(dom.window.document.querySelector('textarea')!.value).toBe('a blue robot')
  expect(clicks).toBe(0)
  dom.window.eval(perchancePage('submit', 'a blue robot'))
  expect(clicks).toBe(1)
  expect(evaluate(dom, perchancePage('collect')).pending).toBe(true)
  dom.window.close()
})
it('refuses ambiguous controls and reports verification', () => {
  const dom = page('<textarea placeholder="Prompt"></textarea><textarea placeholder="Description"></textarea><select><option value="512x768">Portrait</option></select><button>✨ generate</button>')
  expect(evaluate(dom, perchancePage('inspect')).ready).toBe(false)
  expect(() => dom.window.eval(perchancePage('prepare', 'x'))).toThrow('ambiguous')
  dom.window.document.title = 'Just a moment...'
  expect(evaluate(dom, perchancePage('inspect')).challenge).toBe(true)
  dom.window.close()
})

it('accepts the official unlabelled Description textarea and rejects prior images', () => {
  const dom = page('<div>Description</div><textarea></textarea><input placeholder="things you do not want"><select><option>6</option><option>9</option><option>12</option><option>3</option></select><select><option value="512x768">Portrait</option></select><button>✨ generate</button>')
  expect(evaluate(dom, perchancePage('inspect')).ready).toBe(true)
  dom.window.eval(perchancePage('prepare', 'robot'))
  expect(dom.window.document.querySelector('textarea')!.value).toBe('robot')
  expect(Array.from(dom.window.document.querySelectorAll('select')).some(select => select.value === '3')).toBe(true)
  const image = dom.window.document.createElement('img')
  image.src = 'blob:old'; dom.window.document.body.append(image)
  for (const [key, value] of Object.entries({ complete: true, naturalWidth: 512, naturalHeight: 768 })) {
    Object.defineProperty(image, key, { value })
  }
  expect(evaluate(dom, perchancePage('collect', '', ['blob:old'], [512, 768])).pending).toBe(true)
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { value: () => ({ drawImage() {} }) })
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'toDataURL', { value: () => 'data:image/png;base64,Zml4dHVyZQ==' })
  image.src = 'blob:new'
  expect(dom.window.eval(perchancePage('collect', '', ['blob:old'], [512, 768]))).toMatchObject({ png: 'Zml4dHVyZQ==', width: 512, height: 768 })
  dom.window.close()
})

it('excludes auxiliary 512x512 wrong-size or initialization-error images when the generator selected Portrait', () => {
  const dom = page('<img src="blob:verification">')
  const image = dom.window.document.querySelector('img')!
  for (const [key, value] of Object.entries({ complete: true, naturalWidth: 512, naturalHeight: 512 })) {
    Object.defineProperty(image, key, { value })
  }
  expect(evaluate(dom, perchancePage('collect', '', [], [512, 768])).pending).toBe(true)
  dom.window.close()
})

it('validates the actual prepared prompt and size of the official output frame', async () => {
  const { perchanceOutput } = await import('../src/product/perchance-output.ts')
  const embed = (prompt: string, resolution: string) => 'https://image-generation.perchance.org/embed#' + encodeURIComponent(JSON.stringify({ prompt, resolution }))
  expect(perchanceOutput(embed('Painted anime, blue robot', '512x768'), 'blue robot', [512,768])).toBe('output')
  expect(perchanceOutput(embed('(syntax error)', '512x512'), 'blue robot', [512,768])).toBe('invalid')
  expect(perchanceOutput(embed('red dog', '512x768'), 'blue robot', [512,768])).toBe('invalid')
  expect(perchanceOutput('https://perchance.org/img-generator', 'blue robot', [512,768])).toBe('unrelated')
})


it('clicks only one labelled unchecked human-verification checkbox', () => {
  const dom = page('<label><input type="checkbox">I am not a robot</label><label><input type="checkbox">Subscribe</label>')
  expect(evaluate(dom, perchancePage('verify')).clicked).toBe(true)
  expect(Array.from(dom.window.document.querySelectorAll('input')).map(item => item.checked)).toEqual([true, false])
  expect(evaluate(dom, perchancePage('verify')).clicked).toBe(false)
  dom.window.close()
})
it('leaves ambiguous verification and image challenges for the user', () => {
  const dom = page('<label><input type="checkbox">Verify you are human</label><label><input type="checkbox">I am human</label><button>Select all buses</button>')
  expect(evaluate(dom, perchancePage('verify')).clicked).toBe(false)
  expect(Array.from(dom.window.document.querySelectorAll('input')).every(item => !item.checked)).toBe(true)
  dom.window.close()
})

it('selects supported official styles for the unified router and leaves unsupported preferences unchanged', () => {
  const dom = page('<label>Description<textarea></textarea></label><select id="shape"><option>512x768</option></select>' +
    '<select data-name="artStyle"><option value="anime">Painted Anime</option><option value="photo">Photographic (Default)</option>' +
    '<option value="pixel">Pixel Art</option><option value="none">𝗡𝗼 𝘀𝘁𝘆𝗹𝗲</option></select><button>Generate</button>')
  dom.window.eval(perchancePage('prepare', 'robot', [], [], 'realistic'))
  expect(dom.window.document.querySelector<HTMLSelectElement>('select[data-name=artStyle]')?.value).toBe('photo')
  dom.window.eval(perchancePage('prepare', 'robot', [], [], 'pixel'))
  expect(dom.window.document.querySelector<HTMLSelectElement>('select[data-name=artStyle]')?.value).toBe('pixel')
  expect(evaluate(dom, perchancePage('inspect')).styleLabel).toBe('Pixel Art')
  dom.window.eval(perchancePage('style', '', [], [], 'generalist'))
  expect(dom.window.document.querySelector<HTMLSelectElement>('select[data-name=artStyle]')?.value).toBe('none')
  dom.window.close()
})
