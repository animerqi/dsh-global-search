// dsh-global-search 插件 Client 半（浏览器 bundle）
// 客户端模块工厂格式：window.__ModuleLoader__.load({ id, factory })
// 功能：侧边栏底部「全局搜索」按钮 → 弹出搜索面板 → 消息级命中 + 高亮 + 一键跳转会话
window.__ModuleLoader__.load({
  id: "dsh-global-search",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    // ---------- 工具 ----------
    function pad2(n) { return String(n).padStart(2, '0') }
    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
      const d = new Date(ms)
      const now = new Date()
      const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      const isYesterday = d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()
      const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
      if (sameDay) return hm
      if (isYesterday) return '昨天 ' + hm
      if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
    }
    function roleLabel(role) {
      return role === 'user' ? '问' : '答'
    }
    function roleColor(role) {
      return role === 'user' ? 'var(--dsw-alias-brand-primary)' : 'color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-label-secondary))'
    }
    function workspaceBase(ws) {
      if (typeof ws !== 'string' || ws === '') return '未知工作区'
      const parts = ws.split(/[\\/]/)
      return parts[parts.length - 1] || ws
    }
    // 片段三色高亮：按 [matchStart, matchEnd) 切分
    function highlightParts(snippet, matchStart, matchEnd) {
      const s = typeof snippet === 'string' ? snippet : ''
      const a = Math.max(0, Math.min(s.length, matchStart))
      const b = Math.max(a, Math.min(s.length, matchEnd))
      return { before: s.slice(0, a), match: s.slice(a, b), after: s.slice(b) }
    }
    // 在会话 DOM 中定位并高亮目标消息：按指纹匹配 [data-chat-anchor-key] 消息块
    function revealInConversation(hit) {
      if (hit === null || hit === undefined) return
      const candidates = []
      if (typeof hit.fingerprint === 'string' && hit.fingerprint !== '') candidates.push(hit.fingerprint.replace(/\s+/g, ''))
      if (typeof hit.snippet === 'string' && typeof hit.matchStart === 'number') {
        const kw = hit.snippet.slice(hit.matchStart, hit.matchEnd).replace(/\s+/g, '')
        if (kw !== '') candidates.push(kw)
      }
      if (typeof hit.text === 'string') {
        const head = hit.text.replace(/\s+/g, '').slice(0, 60)
        if (head !== '') candidates.push(head)
      }
      const unique = [...new Set(candidates.filter((c) => c.length >= 2))]
      if (unique.length === 0) return
      const started = Date.now()
      const timer = setInterval(() => {
        try {
          const items = document.querySelectorAll('[data-chat-anchor-key]')
          for (const el of items) {
            const text = (el.textContent || '').replace(/\s+/g, '')
            for (const cand of unique) {
              if (text.indexOf(cand) !== -1) {
                clearInterval(timer)
                try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch (err) { /* ignore */ }
                el.classList.add('gs-reveal-flash')
                setTimeout(() => el.classList.remove('gs-reveal-flash'), 5200)
                return
              }
            }
          }
        } catch (err) { /* ignore */ }
        if (Date.now() - started > 9000) clearInterval(timer)
      }, 150)
    }
    // 全局呼出事件（Ctrl+F 等触发）
    const OPEN_EVENT = 'dsh-global-search:open'

    // ---------- CSS ----------
    const CSS = `
.gs-btn { box-sizing:border-box; display:flex; align-items:center; gap:6px; width:100%; height:28px; padding:0 8px; border:0; border-radius:8px; background:transparent; color:var(--dsw-alias-label-secondary); font-family:inherit; font-size:12px; cursor:pointer; transition:background-color .15s ease, color .15s ease; }
.gs-btn:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
.gs-btn svg { flex:none; }
.gs-btn-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.gs-overlay { position:fixed; inset:0; z-index:2400; background:transparent; display:flex; align-items:flex-start; justify-content:center; padding-top:12vh; animation:gs-fade .16s ease both; }
.gs-panel { width:min(600px, calc(100vw - 48px)); max-height:74vh; display:flex; flex-direction:column; background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2); border-radius:14px; box-shadow:0 18px 48px rgba(0,0,0,.28); overflow:hidden; animation:gs-pop .2s cubic-bezier(.22,.61,.36,1) both; }
.gs-head { display:flex; align-items:center; gap:10px; padding:12px 14px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.gs-search-icon { flex:none; color:var(--dsw-alias-label-tertiary); }
.gs-input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:var(--dsw-alias-label-primary); font-family:inherit; font-size:14px; }
.gs-input::placeholder { color:var(--dsw-alias-label-tertiary); }
.gs-close { flex:none; border:0; background:transparent; color:var(--dsw-alias-label-tertiary); cursor:pointer; padding:4px; border-radius:6px; display:inline-flex; transition:color .15s ease, background-color .15s ease; }
.gs-close:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-interactive-bg-hover); }
.gs-status { padding:8px 14px; font-size:12px; color:var(--dsw-alias-label-secondary); display:flex; align-items:center; gap:8px; }
.gs-bar { flex:1; height:4px; border-radius:2px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; max-width:260px; }
.gs-fill { height:100%; background:var(--dsw-alias-brand-primary); border-radius:2px; transition:width .3s ease; }
.gs-body { overflow-y:auto; padding:6px 8px 12px; min-height:120px; }
.gs-empty { padding:34px 10px; text-align:center; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:1.7; }
.gs-loading { padding:26px 10px; text-align:center; color:var(--dsw-alias-label-secondary); font-size:12px; }
.gs-session { margin:4px 0 2px; border:1px solid transparent; border-radius:10px; padding:6px 8px; cursor:pointer; transition:background-color .14s ease, border-color .14s ease; }
.gs-session:hover { background:var(--dsw-alias-interactive-bg-hover); border-color:var(--dsw-alias-border-l1); }
.gs-session-top { display:flex; align-items:center; gap:8px; min-width:0; }
.gs-session-title { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }
.gs-session-ws { flex:none; max-width:38%; font-size:11px; color:var(--dsw-alias-label-tertiary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gs-session-time { flex:none; font-size:11px; color:var(--dsw-alias-label-tertiary); font-variant-numeric:tabular-nums; }
.gs-hit { margin-top:4px; padding:6px 8px; border-radius:8px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); cursor:pointer; transition:background-color .14s ease, border-color .14s ease, transform .1s ease; }
.gs-hit:hover { background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 60%, var(--dsw-alias-bg-layer-2)); border-color:var(--dsw-alias-border-l2); }
.gs-hit:active { transform:scale(.995); }
.gs-hit-head { display:flex; align-items:center; gap:6px; margin-bottom:3px; }
.gs-role { flex:none; width:18px; height:18px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:11px; color:#fff; }
.gs-hit-time { font-size:11px; color:var(--dsw-alias-label-tertiary); }
.gs-hit-text { font-size:12.5px; line-height:1.65; color:var(--dsw-alias-label-secondary); word-break:break-word; white-space:pre-wrap; }
.gs-mark { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); color:var(--dsw-alias-label-primary); border-radius:3px; padding:0 1px; font-weight:600; }
.gs-foot { padding:7px 14px; border-top:1px solid var(--dsw-alias-border-l1); font-size:11px; color:var(--dsw-alias-label-tertiary); display:flex; align-items:center; justify-content:space-between; gap:8px; }
.gs-foot b { color:var(--dsw-alias-label-secondary); font-weight:600; }
@keyframes gs-fade { from { opacity:0; } to { opacity:1; } }
@keyframes gs-pop { from { opacity:0; transform:translateY(-10px) scale(.98); } to { opacity:1; transform:translateY(0) scale(1); } }
.gs-reveal-flash { animation:gs-flash 2.4s ease 2; border-radius:10px; }
@keyframes gs-flash { 0%, 100% { box-shadow:0 0 0 0 rgba(0,0,0,0); background-color:transparent; } 18%, 60% { box-shadow:0 0 0 2px var(--dsw-alias-brand-primary), 0 0 18px color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); background-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); } }
@media (prefers-reduced-motion: reduce) { .gs-overlay, .gs-panel, .gs-reveal-flash { animation:none !important; } }
`
    const cssTagId = "dsh-global-search/styles.css"
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(cssTagId) + "]") === null) {
      const tag = document.createElement("style")
      tag.dataset.plugin = "dsh-global-search"
      tag.dataset.pluginCss = cssTagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---------- RPC ----------
    const statusRpc = () => fetch('/api/global-search/status', { headers: { accept: 'application/json' } }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
    const searchRpc = (q, signal) => fetch('/api/global-search?q=' + encodeURIComponent(q) + '&limit=50', { headers: { accept: 'application/json' }, signal }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })

    // ---------- 搜索图标（内联 SVG） ----------
    function SearchGlyph({ size }) {
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        React.createElement('circle', { cx: 7, cy: 7, r: 4.5 }),
        React.createElement('line', { x1: 10.5, y1: 10.5, x2: 13.5, y2: 13.5 }),
      )
    }

    // ---------- 搜索面板 ----------
    function GlobalSearchPanel({ ctx, onClose }) {
      const [query, setQuery] = React.useState('')
      const [status, setStatus] = React.useState(null)
      const [data, setData] = React.useState(null) // {items,total,truncated}
      const [searching, setSearching] = React.useState(false)
      const [error, setError] = React.useState(null)
      const inputRef = React.useRef(null)
      const seqRef = React.useRef(0)

      // 打开时拉取索引状态 + 聚焦；面板挂载期间 Ctrl+F 再次聚焦输入框
      React.useEffect(() => {
        let alive = true
        statusRpc().then((s) => { if (alive) setStatus(s) }, () => {})
        const t = setTimeout(() => { inputRef.current && inputRef.current.focus() }, 60)
        const onOpenEvent = () => { inputRef.current && inputRef.current.focus() }
        window.addEventListener(OPEN_EVENT, onOpenEvent)
        return () => { alive = false; clearTimeout(t); window.removeEventListener(OPEN_EVENT, onOpenEvent) }
      }, [])

      // 输入防抖搜索
      React.useEffect(() => {
        const q = query.trim()
        const mySeq = ++seqRef.current
        if (q === '') {
          setData(null)
          setSearching(false)
          setError(null)
          return undefined
        }
        setSearching(true)
        setError(null)
        const controller = new AbortController()
        const timer = setTimeout(() => {
          searchRpc(q, controller.signal).then((res) => {
            if (seqRef.current !== mySeq) return
            setData({ items: res.items || [], total: res.total || 0, truncated: !!res.truncated })
            setSearching(false)
            if (res && res.phase) setStatus((prev) => Object.assign({}, prev, { phase: res.phase, scanned: res.scanned, total: res.total, sessions: res.sessions }))
          }, (err) => {
            if (seqRef.current !== mySeq) return
            if (err && err.name === 'AbortError') return
            setSearching(false)
            setError(String(err && err.message ? err.message : err))
          })
        }, 220)
        return () => { clearTimeout(timer); controller.abort() }
      }, [query])

      const onKeyDown = (e) => {
        if (e.key === 'Escape') onClose()
      }

      // 打开会话后在 DOM 中定位到具体消息：按指纹（去空白文本前缀）匹配消息块，
      // 滚动到该块并闪烁高亮。历史消息若尚未渲染则轮询等待。
      const openSession = (sessionId, hit) => {
        try {
          const sessions = ctx.get('sessions')
          if (sessions !== undefined && sessions !== null && typeof sessions.open === 'function') sessions.open(sessionId)
        } catch (err) { /* ignore */ }
        if (hit !== null && hit !== undefined) revealInConversation(hit)
        onClose()
      }

      const q = query.trim()
      const scanning = status !== null && status.phase === 'scanning'
      const scanPct = status && status.total > 0 ? Math.min(100, Math.round((status.scanned / status.total) * 100)) : 0

      let body = null
      if (error !== null) {
        body = React.createElement('div', { className: 'gs-empty' }, '搜索出错了：' + error)
      } else if (q === '') {
        body = React.createElement('div', { className: 'gs-empty' },
          '输入关键词，搜索全部会话内容喵～',
          React.createElement('br'),
          scanning ? '首次使用正在建立索引（' + (status.scanned || 0) + ' / ' + (status.total || 0) + '）…' : '已索引 ' + (status ? status.sessions : 0) + ' 个会话',
        )
      } else if (searching && data === null) {
        body = React.createElement('div', { className: 'gs-loading' }, '正在搜索…')
      } else if (data === null || data.items.length === 0) {
        body = React.createElement('div', { className: 'gs-empty' }, '没有找到包含「' + q + '」的对话内容')
      } else {
        body = data.items.map((session) => {
          const hits = session.hits.map((hit) => {
            const parts = highlightParts(hit.snippet, hit.matchStart, hit.matchEnd)
            return React.createElement('div', {
              key: hit.seq + '-' + hit.time,
              className: 'gs-hit',
              onClick: (e) => { e.stopPropagation(); openSession(session.sessionId, hit) },
              title: '跳转到这条消息',
            },
              React.createElement('div', { className: 'gs-hit-head' },
                React.createElement('span', { className: 'gs-role', style: { background: roleColor(hit.role) } }, roleLabel(hit.role)),
                React.createElement('span', { className: 'gs-hit-time' }, formatTime(hit.time)),
              ),
              React.createElement('div', { className: 'gs-hit-text' },
                parts.before,
                parts.match !== '' ? React.createElement('mark', { className: 'gs-mark' }, parts.match) : null,
                parts.after,
              ),
            )
          })
          return React.createElement('div', {
            key: session.sessionId,
            className: 'gs-session',
            onClick: () => openSession(session.sessionId, session.hits[0]),
            title: '打开会话',
          },
            React.createElement('div', { className: 'gs-session-top' },
              React.createElement('span', { className: 'gs-session-title' }, session.title),
              React.createElement('span', { className: 'gs-session-ws' }, workspaceBase(session.workspace)),
              React.createElement('span', { className: 'gs-session-time' }, formatTime(session.updatedAt)),
            ),
            hits,
          )
        })
      }

      return React.createElement('div', { className: 'gs-overlay', onClick: onClose },
        React.createElement('div', {
          className: 'gs-panel',
          onClick: (e) => e.stopPropagation(),
          onKeyDown: onKeyDown,
          role: 'dialog',
          'aria-label': '全局搜索',
        },
          React.createElement('div', { className: 'gs-head' },
            React.createElement('span', { className: 'gs-search-icon' }, React.createElement(SearchGlyph, { size: 16 })),
            React.createElement('input', {
              ref: inputRef,
              className: 'gs-input',
              value: query,
              placeholder: '搜索全部会话的内容…',
              onChange: (e) => setQuery(e.target.value),
              spellCheck: false,
            }),
            React.createElement('button', { className: 'gs-close', onClick: onClose, 'aria-label': '关闭' },
              React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' },
                React.createElement('line', { x1: 4, y1: 4, x2: 12, y2: 12 }),
                React.createElement('line', { x1: 12, y1: 4, x2: 4, y2: 12 }),
              ),
            ),
          ),
          scanning ? React.createElement('div', { className: 'gs-status' },
            React.createElement('span', {}, '正在索引历史会话 ' + (status.scanned || 0) + ' / ' + (status.total || 0) + (status.failed > 0 ? '（' + status.failed + ' 个失败）' : '')),
            React.createElement('div', { className: 'gs-bar' }, React.createElement('div', { className: 'gs-fill', style: { width: scanPct + '%' } })),
          ) : null,
          React.createElement('div', { className: 'gs-body' }, body),
          React.createElement('div', { className: 'gs-foot' },
            React.createElement('span', {}, data !== null && data.total > 0
              ? React.createElement(React.Fragment, null, '共 ', React.createElement('b', {}, data.total), ' 处命中', data.truncated ? '，仅显示前 ' + data.items.length + ' 条' : '')
              : '全局搜索插件 · 跨工作区全文检索'),
            React.createElement('span', {}, 'Enter 搜索 · Esc 关闭'),
          ),
        ),
      )
    }

    // ---------- 侧边栏按钮 ----------
    function GlobalSearchButton(props) {
      const [open, setOpen] = React.useState(false)
      const wide = props.wide === true
      // 监听全局呼出事件（Ctrl+F 快捷键触发）
      React.useEffect(() => {
        const onOpen = () => setOpen(true)
        window.addEventListener(OPEN_EVENT, onOpen)
        return () => window.removeEventListener(OPEN_EVENT, onOpen)
      }, [])
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          type: 'button',
          className: 'gs-btn',
          'aria-label': '全局搜索',
          title: '全局搜索（Ctrl+F）',
          onClick: () => setOpen(true),
        },
          React.createElement(SearchGlyph, { size: wide ? 14 : 18 }),
          wide ? React.createElement('span', { className: 'gs-btn-label' }, '全局搜索') : null,
        ),
        open ? React.createElement(GlobalSearchPanel, { ctx: props.ctx, onClose: () => setOpen(false) }) : null,
      )
    }

    // ---------- 插件入口 ----------
    // 声明 timer 依赖以延迟 apply 到运行时服务就绪（与 usage-stats 同款模式）；
    // slots 与 sessions 通过 ctx.get() 获取（无需声明）。
    exports.inject = ['timer']
    exports.apply = (ctx) => {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('sidebar.footer.action', () => slots.register(
        {
          name: 'sidebar.footer.action',
          id: 'global-search',
        },
        (props) => React.createElement(GlobalSearchButton, Object.assign({}, props, { ctx })),
      ))
      // Ctrl/Cmd+F 全局呼出搜索面板（阻止浏览器默认查找）
      ctx.effect(() => {
        const handler = (e) => {
          if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
            e.preventDefault()
            e.stopPropagation()
            window.dispatchEvent(new Event(OPEN_EVENT))
          }
        }
        window.addEventListener('keydown', handler, true)
        return () => window.removeEventListener('keydown', handler, true)
      }, 'dsh-global-search: hotkey')
    }
    return module.exports;
  }
});
