// dsh-global-search Host 半逻辑验证脚本（独立于 DSH 运行）
import { apply } from './lib/index.js'

const routes = {}
const webServer = {
  register({ path, handler }) {
    routes[path] = handler
  },
}
const ctx = {
  get(name) {
    if (name === 'webServer') return webServer
    if (name === 'timer') return undefined
    return undefined
  },
  on() {},
  effect(fn) { fn() },
}

apply(ctx)

function callRoute(url, req) {
  return new Promise((resolve) => {
    const parsed = new URL(url, 'http://x')
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(body) {
        let parsed = body
        if (typeof body === 'string') {
          try { parsed = JSON.parse(body) } catch (err) { parsed = body }
        }
        resolve({ statusCode: this.statusCode, body: parsed })
      },
    }
    const handler = routes[parsed.pathname]
    if (handler === undefined) {
      resolve({ statusCode: 404, body: { error: 'no route: ' + parsed.pathname } })
      return
    }
    handler(req || { url, method: 'GET' }, res)
  })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 等待扫描完成（轮询 status 直到 ready，最多 30s）
async function waitScan() {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const s = await callRoute('/api/global-search/status')
    if (s.body.phase === 'ready' || (s.body.started && s.body.total > 0 && s.body.scanned >= s.body.total)) {
      return s.body
    }
    await wait(300)
  }
  return (await callRoute('/api/global-search/status')).body
}

console.log('=== 等待扫描完成 ===')
const status = await waitScan()
console.log('status:', JSON.stringify(status, null, 2))

console.log('\n=== 搜索测试 ===')
for (const q of ['你好', '全局搜索', '用量', 'zstd', 'python', '不存在的词xyz']) {
  const r = await callRoute('/api/global-search?q=' + encodeURIComponent(q))
  const b = r.body
  const first = b.items && b.items[0]
  console.log(`\nquery="${q}" → total=${b.total}, items=${b.items ? b.items.length : 0}, truncated=${b.truncated}`)
  if (first) {
    console.log('  首个会话:', first.title, '| ws:', first.workspace)
    if (first.hits && first.hits[0]) {
      const h = first.hits[0]
      console.log('  命中片段:', JSON.stringify(h.snippet.slice(0, 120)), '| match:', h.matchStart, '-', h.matchEnd)
    }
  }
}

console.log('\n=== 空查询 ===')
const empty = await callRoute('/api/global-search?q=')
console.log('empty query → phase:', empty.body.phase, '| sessions:', empty.body.sessions)
