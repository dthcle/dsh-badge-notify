// Browser half of dsh-badge-notify.
//
// One surface: a first-class settings page (slot `settings.section`, id
// `badge-notify`) sitting beside General, Models and Built-in plugins rather
// than nested as a tab inside the Built-in plugins page. It shows the overlay
// state, the completed-session count, the pending attention list, and a
// start/stop switch. Loaded through the web plugin loader
// (window.__ModuleLoader__); React comes from the platform module table.
// Talks to the Host half over /api/dsh-badge-notify/*.
//
// Styling uses the host theme tokens (--dsw-alias-*) so the page follows the
// active light/dark theme; literal colours are kept only for artwork.
window.__ModuleLoader__.load({ id: 'dsh-badge-notify', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;

  const React = require('react')
  const { useState, useEffect, useCallback } = React
  const h = React.createElement

  let LOCALE = 'en'
  try {
    const nl = (navigator.language || '').toLowerCase()
    if (nl.startsWith('zh')) LOCALE = 'zh'
  } catch (e) { /* keep en */ }

  const T = {
    zh: {
      title: '任务徽标',
      summary: '在 Windows 任务栏的 DSH 图标上叠画未读完成数与待处理提示点',
      running: '徽标已开启',
      stopped: '徽标已关闭',
      starting: '正在启动…',
      stopping: '正在关闭…',
      clearing: '正在清零…',
      clear: '计数清零',
      completed: '已完成会话',
      pending: '待处理',
      none: '暂无',
      dataDir: '数据目录',
      questions: '待回答',
      approvals: '待批准',
      refresh: '刷新',
      failed: '操作失败',
      loadFail: '状态获取失败',
      hint1: '徽标画在任务栏的 DSH 图标上：右上角是黑底白字的完成计数，左边缘从上到下是提示点。',
      hint2: '黑点＝有提问待回答，黄点＝有权限申请待批准。位置、配色、尺寸改 config.json 后自动生效。',
      hint3: '徽标窗口是鼠标穿透的，不影响点击任务栏图标。关闭后 DSH 重启不会自动拉回（记住你的选择）。',
    },
    en: {
      title: 'Task Badge',
      summary: 'Paints the unread completion count and attention dots on the DSH taskbar button',
      running: 'Badge on',
      stopped: 'Badge off',
      starting: 'Starting…',
      stopping: 'Stopping…',
      clearing: 'Clearing…',
      clear: 'Clear count',
      completed: 'Completed sessions',
      pending: 'Pending',
      none: 'none',
      dataDir: 'Data directory',
      questions: 'questions',
      approvals: 'approvals',
      refresh: 'Refresh',
      failed: 'Operation failed',
      loadFail: 'Failed to load status',
      hint1: 'The badge paints on the DSH taskbar button: completed count top-right, attention dots down the left edge.',
      hint2: 'Black dot = question awaiting reply, yellow dot = permission request pending. Edit config.json to change position, colours and sizes.',
      hint3: 'The overlay is click-through, so the taskbar button keeps working. After a stop, DSH restarts will not bring it back.',
    },
  }
  const t = (k) => T[LOCALE][k] || k

  const API_TIMEOUT_MS = 20000
  async function api(action, body) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS)
    try {
      const init = { method: 'POST', signal: ctrl.signal }
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      const r = await fetch('/api/dsh-badge-notify/' + action, init)
      const data = await r.json()
      if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status))
      return data.result
    } finally {
      clearTimeout(timer)
    }
  }

  // DSH shows a green dot on a session that finished while you were not looking
  // at it, and clears that dot the moment you open the session. The taskbar
  // badge must follow the same rule, or it keeps counting sessions the user has
  // already read.
  //
  // The sessions list snapshot already carries each row's `retainedBy`, and the
  // controller republishes a row whenever its retention changes -- so the list
  // alone is both the presence and the retention authority. (Also watching each
  // session's `retainInfo` made the set flap: a row momentarily missing from the
  // snapshot disposed its watcher and dropped the session from the open set.)
  //
  // `retainedBy.mainView > 0` is exactly "this session is open in the main view",
  // the same fact DSH's own completion dot uses. The whole set is reported on
  // every real change, so a lost report self-heals on the next one.
  function watchReadSessions(ctx) {
    let disposeWatch = null
    let timer = null
    let tries = 0

    const start = (sessions) => {
      let last = null
      let disposed = false

      const sync = () => {
        if (disposed) return
        let snap = {}
        try {
          snap = sessions.list.getSnapshot() || {}
        } catch (e) { return }
        const byId = snap.byId || {}
        const ids = Object.keys(byId)
        const open = []
        for (const id of ids) {
          if ((byId[id]?.retainedBy?.mainView || 0) > 0) open.push(id)
        }
        // `known` tells the Host what this list can actually show: a completion
        // for anything outside it (e.g. a subagent child session) can never be
        // read, so it must not raise the badge. `phase` stops the Host from
        // judging that while the list is still loading.
        const phase = typeof snap.phase === 'string' ? snap.phase : ''
        const key = open.join('\n') + '\u0000' + ids.join('\n') + '\u0000' + phase
        if (key === last) return
        last = key
        api('read', { sessionIds: open, known: ids, phase }).catch(() => {})
      }

      const offList = sessions.list.subscribe(sync)
      sync()
      disposeWatch = () => {
        disposed = true
        try { offList() } catch (e) { /* ignore */ }
      }
    }

    // `sessions` belongs to another Client plugin, so it may not be registered
    // the instant this runs. Retry briefly instead of silently doing nothing.
    const attempt = () => {
      timer = null
      let sessions
      try {
        sessions = ctx.get('sessions')
      } catch (e) {
        sessions = undefined
      }
      const list = sessions && sessions.list
      if (list && typeof list.getSnapshot === 'function' && typeof list.subscribe === 'function') {
        try {
          start(sessions)
        } catch (e) {
          console.error('[badge-notify] read-session watcher failed', e)
        }
        return
      }
      if (++tries < 60) timer = setTimeout(attempt, 500)
    }
    attempt()

    ctx.effect(() => () => {
      if (timer !== null) clearTimeout(timer)
      if (disposeWatch) disposeWatch()
    }, 'badge-notify-read-sessions')
  }

  function BadgeNotifyPanel() {
    const [status, setStatus] = useState(null)
    const [busy, setBusy] = useState(null)
    const [error, setError] = useState(null)

    const load = useCallback(async () => {
      try {
        setStatus(await api('status'))
        setError(null)
      } catch (e) {
        setError(t('loadFail') + ': ' + (e && e.message ? e.message : e))
      }
    }, [])

    useEffect(() => {
      load()
      const timer = setInterval(load, 5000)
      return () => clearInterval(timer)
    }, [load])

    const running = !!(status && status.running && status.pids && status.pids.length > 0)
    const working = busy === 'start' ? t('starting') : busy === 'stop' ? t('stopping') : busy === 'clear' ? t('clearing') : null

    const run = async (action) => {
      if (busy) return
      setBusy(action)
      setError(null)
      try {
        await api(action)
      } catch (e) {
        setError(t('failed') + ': ' + (e && e.message ? e.message : e))
      } finally {
        setBusy(null)
        load()
      }
    }

    const toggle = () => run(running ? 'stop' : 'start')
    // The dot carries its state on `data-state` (the CSS keys off it); the base
    // class only supplies geometry, so no state class is needed here.
    const dotState = busy ? 'busy' : running ? 'on' : 'off'
    const pending = status && status.pending ? status.pending : []

    return h('div', { className: 'dbn-page' },
      h('p', { className: 'dbn-summary' }, t('summary')),
      h('div', { className: 'dbn-status' },
        h('span', { className: 'dbn-dot', 'data-state': dotState }),
        h('span', { className: 'dbn-state' }, working || (running ? t('running') : t('stopped'))),
        h('span', { className: 'dbn-actions' },
          h('button', {
            type: 'button',
            className: 'dbn-switch' + (running || busy === 'start' ? ' dbn-switch-on' : ''),
            onClick: toggle,
            disabled: !!busy,
            role: 'switch',
            'aria-checked': running,
            title: running ? t('stopping') : t('starting'),
            'aria-label': running ? t('stopping') : t('starting'),
          }, h('span', { className: 'dbn-knob' })),
          h('button', { type: 'button', className: 'dbn-btn', onClick: () => run('clear'), disabled: !!busy, title: t('clear') }, t('clear')),
          h('button', { type: 'button', className: 'dbn-refresh', onClick: load, title: t('refresh'), 'aria-label': t('refresh') },
            h('svg', { viewBox: '0 0 24 24', width: '14', height: '14', fill: 'currentColor', 'aria-hidden': 'true' },
              h('path', { d: 'M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z' }))),
        ),
      ),
      status ? h('dl', { className: 'dbn-meta' },
        h('div', { className: 'dbn-meta-row' }, h('dt', null, t('completed')), h('dd', null, String(status.completedCount ?? 0))),
        h('div', { className: 'dbn-meta-row' }, h('dt', null, t('pending')),
          h('dd', null, pending.length
            ? pending.map((p) => (p.kind === 'approval' ? t('approvals') : t('questions')) + (p.text ? ' · ' + p.text : '')).join('  |  ')
            : t('none'))),
        running ? h('div', { className: 'dbn-meta-row' }, h('dt', null, 'PID'), h('dd', null, status.pids.join(', '))) : null,
        h('div', { className: 'dbn-meta-row' }, h('dt', null, t('dataDir')), h('dd', null, status.dataDir)),
      ) : null,
      error ? h('div', { className: 'dbn-error' }, error) : null,
      h('div', { className: 'dbn-hints' },
        h('div', { className: 'dbn-hint' }, t('hint1')),
        h('div', { className: 'dbn-hint' }, t('hint2')),
        h('div', { className: 'dbn-hint' }, t('hint3')),
      ),
    )
  }

  const DBN_CSS = `
.dbn-page, .dbn-page * { box-sizing: border-box; }
.dbn-page { display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 720px; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-primary); }
.dbn-summary { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dbn-status { display: flex; align-items: center; gap: 10px; flex-wrap: nowrap; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.dbn-state { font-weight: 600; flex: 1 1 auto; min-width: 0; }
.dbn-actions { display: inline-flex; align-items: center; gap: 10px; flex: none; margin-left: auto; }
.dbn-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; display: inline-block; background: var(--dsw-alias-state-idle-primary); }
.dbn-dot[data-state="on"] { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 6px var(--dsw-alias-state-success-primary); }
.dbn-dot[data-state="busy"] { background: var(--dsw-alias-state-warn-primary); animation: dbn-pulse 1s ease-in-out infinite; }
@keyframes dbn-pulse { 50% { opacity: .35; } }
.dbn-page .dbn-switch { all: unset; position: relative; display: inline-block; width: 40px; height: 22px; min-width: 40px; max-width: 40px; border-radius: 11px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); cursor: pointer; padding: 0; margin: 0; transition: background .18s ease; flex: none; }
.dbn-switch-on { background: var(--dsw-alias-brand-primary) !important; border-color: var(--dsw-alias-brand-primary) !important; }
.dbn-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .18s ease; box-shadow: 0 1px 3px rgba(0,0,0,.35); display: block; }
.dbn-switch-on .dbn-knob { left: 20px; }
.dbn-page .dbn-switch:disabled { opacity: .55; cursor: default; }
.dbn-page .dbn-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dbn-page .dbn-btn { all: unset; display: inline-flex; align-items: center; justify-content: center; height: 26px; padding: 0 10px; min-width: 26px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); cursor: pointer; font-size: 12px; color: inherit; flex: none; }
.dbn-page .dbn-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.dbn-page .dbn-btn:disabled { opacity: .55; cursor: default; }
.dbn-page .dbn-refresh { all: unset; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; min-width: 26px; border-radius: 8px; cursor: pointer; font-size: 15px; color: inherit; opacity: .6; padding: 0; margin: 0; flex: none; }
.dbn-page .dbn-refresh:hover { opacity: 1; background: var(--dsw-alias-bg-layer-2); }
.dbn-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin: 0; font-size: 12px; }
.dbn-meta-row { display: contents; }
.dbn-meta dt { color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dbn-meta dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dbn-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.dbn-hints { display: grid; gap: 4px; padding-top: 4px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dbn-hint { position: relative; padding-left: 14px; }
.dbn-hint::before { content: '•'; position: absolute; left: 2px; opacity: .8; }
`

  const inject = ['slots']

  function apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    ctx.effect(() => {
      const id = 'dsh-badge-notify-style'
      if (!document.getElementById(id)) {
        const s = document.createElement('style')
        s.id = id
        s.textContent = DBN_CSS
        document.head.appendChild(s)
      }
      return () => { const el = document.getElementById(id); if (el) el.remove() }
    }, 'badge-notify-style')
    watchReadSessions(ctx)
    // A page of its own, beside General, Models and Built-in plugins - not a tab
    // nested inside the Built-in plugins page. `order: 16` keeps it directly
    // after that section (15) and before Agent presets (20).
    // NOTE: keep "register({" adjacent — the injector's skeleton validator
    // requires register\(\{\s*...name: '<known slot>'.
    slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'badge-notify', order: 16, label: () => t('title') }, BadgeNotifyPanel))
  }

  module.exports = { inject, apply }
  return module.exports
} })
