/** Test-only simulated upstream for the fixed external provider patch. No external requests. */
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

let requests = [], scenario = 'reasoning'
const server = createServer(async (request, response) => {
  let source = ''
  for await (const chunk of request) source += chunk
  requests.push(JSON.parse(source))
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  let choice = { delta: { reasoning_content: 'I need to use a tool next.' }, finish_reason: 'stop' }
  if (scenario.startsWith('whitespace-')) choice = { delta: { reasoning_content: 'Need tools.', content: ' \n\t' }, finish_reason: scenario.slice('whitespace-'.length) }
  else if (scenario.startsWith('reasoning-')) choice.finish_reason = scenario.slice('reasoning-'.length)
  else if (scenario === 'partial-tool') choice = { delta: { reasoning_content: 'Using tool.', tool_calls: [{ index: 0, id: 'call_partial', function: { name: 'probe_sum', arguments: '{"a":' } }] }, finish_reason: 'length' }
  else if (scenario === 'unnamed-tool') choice = { delta: { reasoning_content: 'Using tool.', tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] }, finish_reason: 'max_tokens' }
  else if (scenario === 'cut') choice = { delta: { reasoning_content: 'I need to use a tool next.' } }
  else if (scenario === 'text-cut') choice = { delta: { content: 'Partial answer requiring more work.' } }
  else if (scenario === 'text-length' && requests.length === 1) choice = { delta: { content: 'Partial answer requiring more work.' }, finish_reason: 'length' }
  else if (scenario === 'tool') choice = { delta: { tool_calls: [{ index: 0, id: 'call_real', type: 'function', function: { name: 'probe_sum', arguments: '{"a":19,"b":23}' } }] }, finish_reason: 'tool_calls' }
  else if (scenario === 'text' || requests.length === 2) choice = { delta: { content: 'A final answer.' }, finish_reason: 'stop' }
  response.end('data: ' + JSON.stringify({ model: 'fixture', choices: [{ index: 0, ...choice }], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } }) + '\n\ndata: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
process.env.OUR_FREE_MODEL_KILO_BASE = 'http://127.0.0.1:' + server.address().port
try {
  const { FreeModelAdapter } = await import(pathToFileURL(join(process.argv[2], 'src/adapter.js')))
  const entry = { id: 'openrouter/free', name: 'Kilo free', channel: 'kilo', wire: 'chat', vision: true, reasoning: true, contextWindow: 131072, maxOutput: 8192 }
  const declared = [{ name: 'probe_sum', description: 'Add.', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } }]
  async function run(kind, tools, recovery) {
    scenario = kind; requests = []
    const adapter = new FreeModelAdapter({ state: () => ({ catalog: [entry], membership: { 'our-free-model': ['openrouter/free'] }, settings: { enabled: true, defaultMaxTokens: 8192, streamRecovery: recovery, tokenSaver: { enabled: false } }, attributionUserAgent: 'audit' }), recordUsage: () => {} })
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'our-free-model', model: 'openrouter/free', messages: [{ role: 'user', content: [{ type: 'text', text: 'Add 19 and 23.' }] }], tools, maxTokens: 2048, signal: AbortSignal.timeout(10000) })) chunks.push(chunk)
    return chunks
  }
  for (const recovery of [true, false]) {
    for (const kind of ['reasoning', 'cut', 'reasoning-length', 'reasoning-max_tokens', 'reasoning-max_output_tokens', 'reasoning-incomplete', 'whitespace-length', 'whitespace-stop']) {
      const chunks = await run(kind, declared, recovery)
      assert.equal(requests.length, 1)
      assert.deepEqual(requests[0].tools[0].function.parameters.required, ['a', 'b'])
      assert.equal(chunks.at(-1).reason.kind, 'error')
      assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
      assert.equal(chunks.some(chunk => chunk.block?.type === 'tool-call'), false)
    }
  }
  for (const kind of ['partial-tool', 'unnamed-tool']) {
    const result = await run(kind, declared, true)
    assert.equal(requests.length, 1)
    assert.equal(result.at(-1).reason.kind, 'max-tokens')
  }
  let chunks = await run('reasoning', [], true)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].tool_choice, 'none')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  chunks = await run('tool', declared, true)
  assert.equal(requests.length, 1)
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.equal(chunks.find(chunk => chunk.block?.type === 'tool-call').block.name, 'probe_sum')
  chunks = await run('text', declared, true)
  assert.equal(requests.length, 1)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  chunks = await run('text-length', declared, true)
  assert.equal(requests.length, 1)
  assert.equal(chunks.at(-1).reason.kind, 'max-tokens')
  chunks = await run('text-cut', declared, true)
  assert.equal(requests.length, 1)
  assert.equal(chunks.at(-1).reason.failure.code, 'STREAM_CUT')
  chunks = await run('text-length', [], true)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].tool_choice, 'none')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  console.log('PASS: 24 adapter cases; tool-task retry preserves tools; chat recovery unchanged')
} finally { await new Promise(resolve => server.close(resolve)); server.closeAllConnections() }
