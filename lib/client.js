// Browser half of dsh-badge-notify.
//
// One surface: an informational panel on the plugin's own page in the Plugins
// settings section (slot `plugins.bundle.config`, keyed by the package name).
// It has no controls - the plugin has no on/off switch of its own any more:
// enabling the bundle shows the badge, disabling it removes the overlay. This
// panel only explains what the marks mean and shows the live state.
//
// It deliberately does NOT register a `settings.section` page: the settings
// list is already crowded, and a badge that needs no configuration does not
// deserve a row there.
//
// Loaded through the web plugin loader (window.__ModuleLoader__); React comes
// from the platform module table. Talks to the Host half over
// /api/dsh-badge-notify/*.
//
// Styling uses the host theme tokens (--dsw-alias-*) so the panel follows the
// active light/dark theme; literal colours are kept only for artwork.

// Is the DSH window actually in front of the user right now?
//
// A failure here must never make the badge stop counting, so anything
// unexpected is reported as "in the foreground".
function isForeground() {
  try {
    if (typeof document === 'undefined') return true
    if (document.visibilityState === 'hidden') return false
    if (typeof document.hasFocus === 'function') return document.hasFocus()
    return true
  } catch (e) {
    return true
  }
}

// Which sessions may be treated as READ.
//
// DSH's own completion dot treats a session as read whenever it is open in the
// main view, and this plugin mirrored that rule. But "open in the main view" is
// not the same as "the user is looking at it": covering the DSH window with
// another window leaves the session open while the user has walked away, and
// then a completion raised nothing at all - neither DSH's dot nor this badge.
//
// So an open session only counts as read while the page is in the foreground.
// Out of the foreground we report NO open sessions, and the Host counts the
// completion. Coming back to the foreground re-reports the open set, which
// retires that completion under the same "you are looking at it now" rule DSH
// applies to its dot.
//
// `known` and `phase` are unaffected: they describe what the list can show, not
// what the user has seen.
function deriveReadState(snapshot, foreground) {
  const byId = (snapshot && snapshot.byId) || {}
  const known = Object.keys(byId)
  const open = []
  if (foreground) {
    for (const id of known) {
      if ((byId[id]?.retainedBy?.mainView || 0) > 0) open.push(id)
    }
  }
  const phase = typeof snapshot?.phase === 'string' ? snapshot.phase : ''
  return { open, known, phase }
}

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
      active: '徽标显示中',
      inactive: '徽标未显示',
      loadFail: '状态获取失败',
      marksTitle: '图标上的标记',
      markBadge: '右上角数字',
      markBadgeDesc: '未读的已完成会话数。与侧边栏绿点同义：跑完时你在看它就不计数，之后打开即清除。',
      markQuestion: '左边缘黑点',
      markQuestionDesc: '有提问待你回答，需要人工介入。',
      markApproval: '左边缘黄点',
      markApprovalDesc: '有权限申请待你批准。',
      markError: '左上角红点',
      markErrorDesc: '上次运行失败。不进角标数字；打开该会话或它下次成功完成才清除，不会自动过期。',
      markNone: '当前没有标记',
      completed: '已完成',
      pending: '待处理',
      failed: '失败',
      behaviorTitle: '行为',
      behaviorOn: '启用这个插件就会显示，禁用即消失——没有单独的开关。',
      behaviorFullscreen: '只在任务栏可见时显示：被全屏应用或窗口盖住时自动隐藏。',
      behaviorClick: '浮层鼠标穿透，不影响点击任务栏图标。',
      customizeTitle: '自定义',
      customizeDesc: '位置、颜色、尺寸都在 config.json 里，改完约 2 秒生效。',
      dataDir: '数据目录',
    },
    en: {
      title: 'Task Badge',
      summary: 'Paints the unread completion count and attention dots on the DSH taskbar button',
      active: 'Badge visible',
      inactive: 'Badge not visible',
      loadFail: 'Failed to load status',
      marksTitle: 'Marks on the icon',
      markBadge: 'Top-right number',
      markBadgeDesc: 'Unread completed sessions. Same rule as the sidebar dot: finishing while you watch it does not count, and opening it clears it.',
      markQuestion: 'Black dot, left edge',
      markQuestionDesc: 'A question is waiting for your answer.',
      markApproval: 'Yellow dot, left edge',
      markApprovalDesc: 'A permission request is waiting for approval.',
      markError: 'Red dot, top-left',
      markErrorDesc: 'The last run failed. It never joins the number; it clears when you open the session or it later completes successfully, and it does not expire.',
      markNone: 'No marks right now',
      completed: 'Completed',
      pending: 'Pending',
      failed: 'Failed',
      behaviorTitle: 'Behaviour',
      behaviorOn: 'Enabling this plugin shows the badge, disabling it removes it - there is no separate switch.',
      behaviorFullscreen: 'Only shown while the taskbar is visible: it hides when a fullscreen app or window covers the taskbar.',
      behaviorClick: 'The overlay is click-through, so the taskbar button keeps working.',
      customizeTitle: 'Customising',
      customizeDesc: 'Position, colours and sizes live in config.json; edits apply in about 2 seconds.',
      dataDir: 'Data directory',
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
        const { open, known, phase } = deriveReadState(snap, isForeground())
        // `known` tells the Host what this list can actually show: a completion
        // for anything outside it (e.g. a subagent child session) can never be
        // read, so it must not raise the badge. `phase` stops the Host from
        // judging that while the list is still loading.
        const key = open.join('\n') + '\u0000' + known.join('\n') + '\u0000' + phase
        if (key === last) return
        last = key
        api('read', { sessionIds: open, known, phase }).catch(() => {})
      }

      // The list only republishes when its contents change, so a plain
      // focus change would never be reported on its own - and that is exactly
      // the moment the Host needs to know it may start counting.
      const onFocusChange = () => sync()
      const offList = sessions.list.subscribe(sync)
      try {
        window.addEventListener('focus', onFocusChange)
        window.addEventListener('blur', onFocusChange)
        document.addEventListener('visibilitychange', onFocusChange)
      } catch (e) { /* keep the badge working without these */ }
      sync()
      disposeWatch = () => {
        disposed = true
        try { offList() } catch (e) { /* ignore */ }
        try {
          window.removeEventListener('focus', onFocusChange)
          window.removeEventListener('blur', onFocusChange)
          document.removeEventListener('visibilitychange', onFocusChange)
        } catch (e) { /* ignore */ }
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

  // Informational only: no switches, no buttons. Enabling/disabling the bundle
  // is the on/off control, so a second one here would only be a way to get them
  // out of sync.
  //
  // The owner asks for `view: 'summary'` when it only wants a one-liner (e.g. in
  // a collapsed list) and `view: 'page'` for the full panel; both are supported
  // so the plugin never renders a half-empty summary row.
  function BadgeNotifyPanel(props) {
    const view = props && props.view === 'summary' ? 'summary' : 'page'
    const [status, setStatus] = useState(null)
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

    if (view === 'summary') {
      return h('span', null, t('summary') + (status ? ' · ' + (running ? t('active') : t('inactive')) : ''))
    }

    const pending = status && status.pending ? status.pending : []
    const failedCount = status && typeof status.failedCount === 'number' ? status.failedCount : 0
    const hasMarks = !!(status && ((status.completedCount ?? 0) > 0 || pending.length > 0 || failedCount > 0))

    const row = (key, desc, dotState) => h('div', { className: 'dbn-mark' },
      h('span', { className: 'dbn-dot', 'data-state': dotState }),
      h('span', { className: 'dbn-mark-text' },
        h('span', { className: 'dbn-mark-name' }, t(key)),
        h('span', { className: 'dbn-mark-desc' }, t(key + 'Desc')),
      ),
    )

    return h('div', { className: 'dbn-page' },
      h('div', { className: 'dbn-status' },
        h('span', { className: 'dbn-dot', 'data-state': running ? 'on' : 'off' }),
        h('span', { className: 'dbn-state' }, running ? t('active') : t('inactive')),
      ),
      error ? h('div', { className: 'dbn-error' }, error) : null,

      h('h4', { className: 'dbn-h' }, t('marksTitle')),
      h('div', { className: 'dbn-marks' },
        row('markBadge', null, 'badge'),
        row('markQuestion', null, 'question'),
        row('markApproval', null, 'approval'),
        row('markError', null, 'error'),
      ),
      status ? h('p', { className: 'dbn-now' }, hasMarks
        ? [t('completed') + ' ' + (status.completedCount ?? 0),
           t('pending') + ' ' + pending.length,
           t('failed') + ' ' + failedCount].join(' · ')
        : t('markNone')) : null,

      h('h4', { className: 'dbn-h' }, t('behaviorTitle')),
      h('ul', { className: 'dbn-list' },
        h('li', null, t('behaviorOn')),
        h('li', null, t('behaviorFullscreen')),
        h('li', null, t('behaviorClick')),
      ),

      h('h4', { className: 'dbn-h' }, t('customizeTitle')),
      h('p', { className: 'dbn-p' }, t('customizeDesc')),
      status ? h('p', { className: 'dbn-path' }, status.dataDir) : null,
    )
  }

  const DBN_CSS = `
.dbn-page, .dbn-page * { box-sizing: border-box; }
.dbn-page { display: flex; flex-direction: column; gap: 12px; width: 100%; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-primary); }
.dbn-status { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.dbn-state { font-weight: 600; }
.dbn-h { margin: 6px 0 0; font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); }
.dbn-marks { display: flex; flex-direction: column; gap: 8px; }
.dbn-mark { display: flex; align-items: flex-start; gap: 9px; }
.dbn-mark-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dbn-mark-name { font-weight: 600; font-size: 12px; }
.dbn-mark-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dbn-now { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dbn-list { margin: 0; padding-left: 18px; font-size: 12px; color: var(--dsw-alias-label-secondary); display: flex; flex-direction: column; gap: 4px; }
.dbn-p { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dbn-path { margin: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); opacity: .75; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dbn-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; display: inline-block; margin-top: 5px; background: var(--dsw-alias-state-idle-primary); }
.dbn-dot[data-state="on"] { background: var(--dsw-alias-state-success-primary); }
.dbn-dot[data-state="badge"] { border-radius: 3px; background: var(--dsw-alias-label-primary); }
.dbn-dot[data-state="question"] { background: var(--dsw-alias-label-primary); }
.dbn-dot[data-state="approval"] { background: var(--dsw-alias-state-warn-primary); }
.dbn-dot[data-state="error"] { background: var(--dsw-alias-state-error-primary); }
.dbn-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
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
    // On the plugin's OWN page in the Plugins section, keyed by the package name
    // (that is how the plugin manager dispatches this slot), and rendered only
    // for `view: 'page'`. No `settings.section` registration any more: the
    // settings list is crowded and this plugin needs no configuration of its own.
    // NOTE: keep "register({" adjacent — the injector's skeleton validator
    // requires register\(\{\s*...name: '<known slot>'.
    slots.inject('plugins.bundle.config', () => slots.register({ name: 'plugins.bundle.config', key: 'dsh-badge-notify' }, BadgeNotifyPanel))
  }

  module.exports = { inject, apply }
  return module.exports
} })
