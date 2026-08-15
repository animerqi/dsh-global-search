// dsh-global-search 插件 Host 半
// 跨所有工作区扫描会话内容（多帧 zstd 事件日志），建立内存全文索引，
// 通过 webServer 提供全局搜索 API，并随实时会话事件增量更新。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const name = 'dsh-global-search'
// 声明 webServer 依赖：cordis 会等该服务就绪后再调用 apply，
// 避免过早执行时 ctx.get('webServer') 拿到 undefined 导致路由注册被跳过。
const inject = ['webServer']

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528（小端 28 B5 2F FD）
const LOG_FILE = 'session.jsonl.zstd'
const LOG_FILE_PLAIN = 'session.jsonl'
const MAX_FILE_BYTES = 64 * 1024 * 1024 // 单会话日志上限 64MB
const MAX_MESSAGE_CHARS = 20000 // 单条消息索引文本上限
const TITLE_MAX_CHARS = 60
const SNIPPET_RADIUS = 70 // 匹配上下文半径（字符）
const SNIPPET_MAX = 260
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

// ---------- zstd 多帧容器解码 ----------
// 会话日志是「多个独立 zstd 帧首尾拼接」的容器（追加写入），不能整体解压。
// 按 zstd 帧格式解析出每个完整帧的边界，再逐帧解压拼接。
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) break // 保留位
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, complete: false }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, complete: false }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, complete: false }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, complete: false }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, complete: true }
}

function decodeLogBytes(buffer) {
  // 明文日志（compression: none）以 JSON 或 BOM 开头
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) {
    return buffer.toString('utf8').replace(/^\uFEFF/, '')
  }
  const { frames } = scanZstdFrames(buffer)
  let out = ''
  for (const frame of frames) {
    try {
      out += zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    } catch (err) {
      // 单帧损坏不影响其他帧
    }
  }
  return out
}

// ---------- 事件 → 索引 ----------
function textOfMessage(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    } else if (block.type === 'tool-result') {
      // 工具结果里也常有模型可见文本，但噪音较大，不索引正文，仅索引其文本子块
      const inner = Array.isArray(block.content) ? block.content : []
      for (const item of inner) {
        if (item !== null && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
          parts.push(item.text)
        }
      }
    }
  }
  return parts.join('\n')
}

function isSystemInjected(source) {
  if (source === null || typeof source !== 'object') return false
  return source.kind === 'plugin' || source.kind === 'system' || source.kind === 'tool'
}

/**
 * 解析一段 JSONL 事件文本，提取可搜索消息。
 * @returns {{ messages: Array<{seq:number,time:number,role:string,text:string}>, title?:string, sessionId?:string, cwd?:string, updatedAt?:number }}
 */
function parseEventLines(text, sessionIdHint) {
  const messages = []
  let title = undefined
  let sessionId = sessionIdHint
  let cwd = undefined
  let updatedAt = 0
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch (err) {
      continue
    }
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    const time = typeof event.time === 'number' ? event.time : 0
    if (time > updatedAt) updatedAt = time
    if (event.type === 'session') {
      const data = event.data && typeof event.data === 'object' ? event.data : event
      if (typeof data.id === 'string' && data.id !== '') sessionId = data.id
      if (typeof data.cwd === 'string' && data.cwd !== '') cwd = data.cwd
      continue
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const message = event.type === 'user/message' ? data : (data.message && typeof data.message === 'object' ? data.message : null)
    if (message === null) continue
    const text = textOfMessage(message)
    if (text === '') continue
    const role = event.type === 'user/message' ? 'user' : 'assistant'
    const seq = typeof event.seq === 'number' ? event.seq : 0
    messages.push({
      seq,
      time,
      role,
      text: text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text,
    })
    if (title === undefined && role === 'user' && !isSystemInjected(message.source)) {
      title = text.split('\n')[0].trim().slice(0, TITLE_MAX_CHARS)
    }
  }
  return { messages, title, sessionId, cwd, updatedAt }
}

// ---------- 搜索 ----------
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildSnippet(text, matchStart, matchEnd) {
  // 计算 [matchStart, matchEnd) 并向外扩展上下文
  let start = Math.max(0, matchStart - SNIPPET_RADIUS)
  let end = Math.min(text.length, matchEnd + SNIPPET_RADIUS)
  let prefix = ''
  let suffix = ''
  if (start > 0) {
    // 尽量从换行/空格后开始，避免截断单词
    const nl = text.lastIndexOf('\n', start)
    if (nl >= 0 && start - nl < SNIPPET_RADIUS) start = nl + 1
    prefix = '…'
  }
  if (end < text.length) {
    const nl = text.indexOf('\n', end)
    if (nl >= 0 && nl - end < SNIPPET_RADIUS) end = nl
    suffix = '…'
  }
  if (end - start > SNIPPET_MAX) {
    // 超长时以匹配为中心收紧
    start = Math.max(0, matchStart - Math.floor(SNIPPET_MAX / 2))
    end = Math.min(text.length, matchEnd + Math.ceil(SNIPPET_MAX / 2))
    if (start > 0) prefix = '…'
    if (end < text.length) suffix = '…'
  }
  return {
    text: text.slice(start, end),
    matchStart: matchStart - start,
    matchEnd: matchEnd - start,
  }
}

// ---------- 插件主体 ----------
function apply(ctx) {
  const webServer = ctx.get('webServer')
  const state = {
    phase: 'idle', // idle | scanning | ready
    started: false,
    scanned: 0,
    total: 0,
    failed: 0,
    sessions: new Map(), // sessionId -> { id, workspace, title, updatedAt, messages: [] }
    workspaceOf: new Map(), // sessionId -> workspace 名
    errors: [],
    scanPromise: null,
  }

  function sendJson(res, code, value) {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(value))
  }

  // ---------- 定位 sessions 根目录 ----------
  function locateSessionsRoot() {
    const candidates = []
    const envHome = process.env.DSH_HOME
    if (typeof envHome === 'string' && envHome.trim() !== '') candidates.push(join(envHome.trim(), 'sessions'))
    candidates.push(join(homedir(), '.dsh', 'sessions'))
    const appData = process.env.APPDATA
    if (typeof appData === 'string' && appData !== '') {
      candidates.push(join(appData, 'DeepWharf', 'harness', 'sessions'))
      candidates.push(join(appData, 'deepwharf', 'harness', 'sessions'))
    }
    for (const candidate of candidates) {
      try {
        const st = statSyncSafe(candidate)
        if (st !== null && st.isDirectory()) return candidate
      } catch (err) { /* next */ }
    }
    return candidates[0]
  }

  function statSyncSafe(p) {
    try {
      return statSync(p)
    } catch (err) {
      return null
    }
  }

  function workspaceLabel(dirName) {
    // 目录名形如 "--E-Documents-DeepSeeK--"（工作区路径的编码形式）
    const inner = dirName.replace(/^-+/, '').replace(/-+$/, '')
    if (inner === '') return dirName
    // 还原为可读路径：-- 分隔的段 → 路径分隔符
    const parts = inner.split('--')
    if (parts.length > 1) {
      const joined = parts.join('\\')
      if (joined.includes('\\') || joined.includes(':')) return joined
    }
    return inner
  }

  function workspaceTitle(wsName) {
    const base = wsName.split(/[\\/]/).pop() || wsName
    return base
  }

  // ---------- 扫描单个会话文件 ----------
  function indexSessionFile(sessionDir, wsName, sidFromDir) {
    let file = join(sessionDir, LOG_FILE)
    let plain = false
    let st = statSyncSafe(file)
    if (st === null || !st.isFile()) {
      file = join(sessionDir, LOG_FILE_PLAIN)
      plain = true
      st = statSyncSafe(file)
    }
    if (st === null || !st.isFile()) return null
    if (st.size > MAX_FILE_BYTES) {
      state.errors.push(`${sidFromDir}: 文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB，跳过`)
      return null
    }
    let buffer
    try {
      buffer = readFileSync(file)
    } catch (err) {
      state.errors.push(`${sidFromDir}: 读取失败 ${String(err)}`)
      return null
    }
    let text
    try {
      text = decodeLogBytes(buffer)
    } catch (err) {
      state.errors.push(`${sidFromDir}: 解码失败 ${String(err)}`)
      return null
    }
    const parsed = parseEventLines(text, sidFromDir)
    if (parsed.messages.length === 0 && parsed.title === undefined) return null
    const sessionId = parsed.sessionId || sidFromDir
    const existing = state.sessions.get(sessionId)
    const record = {
      id: sessionId,
      workspace: wsName,
      title: parsed.title || (existing ? existing.title : '（无标题会话）'),
      updatedAt: parsed.updatedAt || 0,
      messages: parsed.messages,
    }
    state.sessions.set(sessionId, record)
    state.workspaceOf.set(sessionId, wsName)
    return record
  }

  // ---------- 全量扫描 ----------
  async function runBaseline() {
    if (state.started) return state.scanPromise
    state.started = true
    state.phase = 'scanning'
    const root = locateSessionsRoot()
    let workspaces = []
    try {
      workspaces = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
    } catch (err) {
      state.errors.push(`无法读取会话目录 ${root}: ${String(err)}`)
      state.phase = 'ready'
      return
    }
    let totalFiles = 0
    const tasks = []
    for (const ws of workspaces) {
      const wsDir = join(root, ws.name)
      let sessionDirs = []
      try {
        sessionDirs = readdirSync(wsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
      } catch (err) {
        state.errors.push(`无法读取工作区目录 ${ws.name}: ${String(err)}`)
        continue
      }
      for (const sd of sessionDirs) {
        totalFiles += 1
        tasks.push({ sessionDir: join(wsDir, sd.name), wsName: workspaceLabel(ws.name), sid: sd.name })
      }
    }
    state.total = totalFiles
    // 逐个处理（避免一次占满内存），分片让出事件循环
    const BATCH = 8
    for (let i = 0; i < tasks.length; i += BATCH) {
      const batch = tasks.slice(i, i + BATCH)
      for (const task of batch) {
        try {
          indexSessionFile(task.sessionDir, task.wsName, task.sid)
        } catch (err) {
          state.failed += 1
          state.errors.push(`${task.sid}: 索引失败 ${String(err)}`)
        }
        state.scanned += 1
      }
      await ctxTimeout(ctx, 0)
    }
    state.phase = 'ready'
  }

  function ctxTimeout(ctx, ms) {
    const timer = ctx.get('timer')
    if (timer !== undefined && timer !== null && typeof timer.sleep === 'function') return timer.sleep(ms)
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function startScan() {
    if (state.scanPromise === null || state.scanPromise === undefined) {
      state.scanPromise = runBaseline().catch((err) => {
        state.errors.push(`扫描失败 ${String(err)}`)
        state.phase = 'ready'
      })
    }
    return state.scanPromise
  }

  // ---------- 实时增量 ----------
  ctx.on('session/event', (session, event) => {
    if (event === null || typeof event !== 'object') return
    const type = event.type
    if (type !== 'user/message' && type !== 'assistant/message' && type !== 'session') return
    const sid = session !== null && typeof session === 'object' && typeof session.id === 'string' ? session.id : undefined
    if (sid === undefined) return
    let record = state.sessions.get(sid)
    if (record === undefined && type !== 'session') {
      // 新会话尚未入索引：先建一个空记录，标题/工作区随后补
      const header = session.header
      const cwd = header !== null && typeof header === 'object' && typeof header.cwd === 'string' ? header.cwd : ''
      record = {
        id: sid,
        workspace: cwd !== '' ? cwd : '未知工作区',
        title: '（无标题会话）',
        updatedAt: 0,
        messages: [],
      }
      state.sessions.set(sid, record)
      state.workspaceOf.set(sid, record.workspace)
    }
    if (type === 'session') {
      const data = event.data && typeof event.data === 'object' ? event.data : event
      if (typeof data.cwd === 'string' && data.cwd !== '') {
        record.workspace = data.cwd
        state.workspaceOf.set(sid, data.cwd)
      }
      return
    }
    const data = event.data
    if (data === null || typeof data !== 'object') return
    const message = type === 'user/message' ? data : (data.message && typeof data.message === 'object' ? data.message : null)
    if (message === null) return
    const text = textOfMessage(message)
    if (text === '') return
    const time = typeof event.time === 'number' ? event.time : Date.now()
    const role = type === 'user/message' ? 'user' : 'assistant'
    record.messages.push({
      seq: typeof event.seq === 'number' ? event.seq : 0,
      time,
      role,
      text: text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text,
    })
    if (time > record.updatedAt) record.updatedAt = time
    if (record.title === '（无标题会话）' && role === 'user' && !isSystemInjected(message.source)) {
      const firstLine = text.split('\n')[0].trim()
      if (firstLine !== '') record.title = firstLine.slice(0, TITLE_MAX_CHARS)
    }
  })

  // ---------- 搜索 ----------
  // 生成用于客户端 DOM 定位的指纹：剥离 markdown 符号与空白后的连续文本前缀。
  // 会话渲染后的 textContent（同样去空白）应包含该指纹，从而定位到具体消息。
  function cleanText(text) {
    return String(text)
      .replace(/```([\s\S]*?)```/g, '$1') // 代码块：保留内容（<pre> 的 textContent 与之一致）
      .replace(/`([^`]*)`/g, '$1') // 行内代码
      .replace(/\*\*([^*]*)\*\*/g, '$1') // 粗体
      .replace(/__([^_]*)__/g, '$1') // 下划线粗体
      .replace(/~~([^~]*)~~/g, '$1') // 删除线
      .replace(/\*([^*]*)\*/g, '$1') // 斜体
      .replace(/^#{1,6}\s*/gm, '') // 标题
      .replace(/^\s*[-*+]\s+/gm, '') // 列表项
      .replace(/^\s*>\s?/gm, '') // 引用
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片（img 无文本）
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接
      .replace(/<[^>]+>/g, ' ') // HTML 标签
      .replace(/\s+/g, '')
  }
  function doSearch(query, limit) {
    const needle = query.toLowerCase()
    const results = []
    let total = 0
    for (const record of state.sessions.values()) {
      let sessionHits = []
      for (const msg of record.messages) {
        const hay = msg.text.toLowerCase()
        let idx = hay.indexOf(needle)
        if (idx === -1) continue
        const snippet = buildSnippet(msg.text, idx, idx + query.length)
        sessionHits.push({
          role: msg.role,
          time: msg.time,
          text: msg.text,
          snippet: snippet.text,
          matchStart: snippet.matchStart,
          matchEnd: snippet.matchEnd,
          seq: msg.seq,
          fingerprint: cleanText(msg.text).slice(0, 80),
        })
        if (sessionHits.length >= 5) break // 每会话最多 5 条命中
      }
      if (sessionHits.length === 0) continue
      total += sessionHits.length
      results.push({
        sessionId: record.id,
        title: record.title,
        workspace: record.workspace,
        updatedAt: record.updatedAt,
        hits: sessionHits,
      })
    }
    // 排序：会话按最近活动时间倒序
    results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    const truncated = results.length > limit
    const page = truncated ? results.slice(0, limit) : results
    return { items: page, total, truncated }
  }

  function statusPayload() {
    return {
      phase: state.phase,
      started: state.started,
      scanned: state.scanned,
      total: state.total,
      failed: state.failed,
      sessions: state.sessions.size,
      errors: state.errors.slice(-20),
    }
  }

  // ---------- HTTP 路由 ----------
  if (webServer !== undefined && webServer !== null) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/global-search',
      handler: (req, res) => {
        if (!state.started) void startScan()
        const url = new URL(req.url ?? '/', 'http://x')
        const raw = url.searchParams.get('q') ?? ''
        const query = raw.trim().slice(0, 200)
        if (query === '') {
          sendJson(res, 200, Object.assign({ query: '' }, statusPayload()))
          return
        }
        let limit = DEFAULT_LIMIT
        const rawLimit = Number(url.searchParams.get('limit'))
        if (Number.isInteger(rawLimit) && rawLimit > 0) limit = Math.min(rawLimit, MAX_LIMIT)
        const result = doSearch(query, limit)
        sendJson(res, 200, Object.assign({ query, limit }, statusPayload(), result))
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/global-search/status',
      handler: (req, res) => {
        if (!state.started) void startScan()
        sendJson(res, 200, statusPayload())
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/global-search/rescan',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        state.phase = 'scanning'
        state.scanned = 0
        state.total = 0
        state.failed = 0
        state.sessions.clear()
        state.workspaceOf.clear()
        state.errors = []
        state.scanPromise = null
        void startScan()
        sendJson(res, 200, statusPayload())
      },
    }))
  }

  // ---------- 启动 ----------
  void startScan()
}

export { name, inject, apply }
export default { name, inject, apply }
