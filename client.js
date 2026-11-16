/**
 * Client half: the DSH备份与同步 settings page.
 *
 * Layout follows the user's workflow: connection details live behind a 设置
 * dialog, and every scope row carries its own direction, its comparison with
 * the server, and a button that syncs just that scope.
 */
window.__ModuleLoader__.load({
  id: '@stone-yu/dsh-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API = '/api/dsh-nas-sync'
    const SECTION_ID = 'dsh-backup-sync'
    /** Short label for the sidebar icon row. */
    const MENU_LABEL = '备份与同步'
    /** Title shown inside the panel. */
    const PANEL_TITLE = 'DSH备份与同步'
    const VIEWS = [
      { key: 'home', label: '首页' },
      { key: 'items', label: '同步内容配置' },
      { key: 'connection', label: '连接配置' },
    ]

    /** Rows whose scope is a user-editable path list. */
    const PATH_ROWS = ['extraPaths', 'memory']

    /**
     * Last full comparison payload, kept outside React state so switching panels
     * repaints the numbers instantly instead of re-enumerating the remote tree.
     */
    let cachedStatus = null
    /** When `cachedStatus` was taken, so a background refresh can be throttled. */
    let cachedStatusAt = 0
    /**
     * Do not re-enumerate the remote more often than this after a remount. The
     * cached numbers stay valid indefinitely; this only limits how eagerly a
     * background refresh runs.
     */
    const AUTO_REFRESH_MS = 30000

    const DIRECTION_LABEL = {
      off: '关闭',
      push: '上传备份',
      'two-way': '双向同步',
    }

    /** Legacy pull is now a one-time action, never a saved sync direction. */
    function syncDirection(row, value) {
      return value === 'two-way' && row.allowed?.includes('two-way') ? 'two-way' : 'push'
    }

    const ACTION_LABEL = {
      off: '已关闭',
      push: '上传',
      'two-way': '对账同步',
    }

    const STATUS_TEXT = {
      synced: ['已同步', 'ok'],
      pending: ['待上传', 'warn'],
      'pull-ready': ['可还原', 'idle'],
      loading: ['读取中', 'idle'],
      unknown: ['无法比对', 'idle'],
      off: ['已关闭', 'idle'],
    }

    /**
     * Resolve an app path against the document base, the way the shipped
     * plugins do. When the page is served under a mount prefix, a root-relative
     * path would drop that prefix and miss the route.
     */
    function resolveUrl(path) {
      if (typeof document === 'undefined') return path
      const base = document.baseURI
      if (typeof base !== 'string' || base === '') return path
      try {
        const url = new URL(base)
        if (!url.pathname.endsWith('/')) url.pathname += '/'
        return new URL(path.replace(/^\//, ''), url.href).href
      } catch {
        return path
      }
    }

    /**
     * Fetch JSON from one of our routes.
     *
     * Tries the mount-aware URL first and falls back to the root-relative one,
     * because only one of them is correct depending on how this deployment
     * mounts the Web application. A 404 is the only status that retries: it
     * means the route was not reached, so nothing ran.
     */
    async function request(path, init) {
      const candidates = [resolveUrl(path), path]
      let last = null
      for (const url of candidates) {
        let response
        try {
          response = await fetch(url, init)
        } catch (error) {
          if (init?.signal?.aborted) throw error
          last = new Error(`无法连接 ${url}：${error.message}`)
          // A failed mutation may already have reached Host. Never replay it.
          if (init?.method && init.method !== 'GET' && init.method !== 'HEAD') throw last
          continue
        }
        const body = await response.json().catch(() => null)
        if (response.status === 404 && url !== candidates[candidates.length - 1]) {
          last = new Error(`HTTP 404（${url}）`)
          continue
        }
        if (!response.ok || (body && body.ok === false)) {
          throw new Error((body && body.error) || `HTTP ${response.status}（${url}）`)
        }
        return body
      }
      throw last ?? new Error('请求失败')
    }

    function post(path, payload) {
      return request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    /** Turn a session project directory into its readable tail, e.g. `…/m-workspace`. */
    function shortProject(project) {
      const cleaned = String(project || '').replace(/^-+|-+$/g, '').replace(/--/g, '/')
      const parts = cleaned.split('/').filter(Boolean)
      return parts.length === 0 ? String(project || '') : parts[parts.length - 1]
    }

    /** File count plus size, or a placeholder while the comparison has not run. */
    function countText(files, bytes) {
      if (files === null || files === undefined) return '…'
      return `${files} 个 / ${formatBytes(bytes ?? 0)}`
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
    }

    const css = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', color: 'var(--dsw-alias-label-primary)' },
      panelHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
      panelTitle: { margin: 0, fontSize: '18px', fontWeight: 600, letterSpacing: '0.2px' },
      // A segmented control: the selected tab is marked by its background, so no
      // border or underline can leak into the unselected ones.
      tabs: {
        display: 'inline-flex', alignItems: 'center', gap: '4px', alignSelf: 'flex-start',
        padding: '4px', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
      },
      tab: {
        font: 'inherit', fontSize: '13px', padding: '6px 14px', cursor: 'pointer',
        background: 'transparent', border: 'none', outline: 'none',
        borderRadius: '7px', color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap', lineHeight: 1.4,
      },
      tabActive: {
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
        boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
      },
      viewBody: { display: 'flex', flexDirection: 'column', gap: '12px' },
      infoGrid: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: '10px 20px', marginTop: '10px', fontSize: '12px',
      },
      infoItem: { display: 'flex', flexDirection: 'column', gap: '2px' },
      infoLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      infoValue: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px',
        wordBreak: 'break-all',
      },
      rules: {
        display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px',
        marginTop: '10px', padding: '12px 14px', borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
        fontSize: '12px', lineHeight: 1.6,
      },
      rulesTerm: { fontWeight: 600, whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)' },
      rulesText: { color: 'var(--dsw-alias-label-secondary)' },
      statGrid: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))', gap: '12px',
      },
      statCard: {
        display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-1)', minWidth: 0,
      },
      statHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      dot: { width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto' },
      statTitle: { fontSize: '14px', fontWeight: 600, flex: '1 1 auto', minWidth: 0 },
      statState: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      statNumbers: { display: 'flex', alignItems: 'baseline', gap: '6px' },
      statBig: { fontSize: '26px', fontWeight: 600, lineHeight: 1.1 },
      statUnit: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      statSize: { marginLeft: 'auto', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      statLine: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' },
      statFooter: {
        display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '10px',
        borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: 'auto',
      },
      statPath: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)', flex: '1 1 auto', minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)', padding: '16px',
      },
      headRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
      headText: { minWidth: 0, flex: '1 1 auto' },
      title: { margin: 0, fontSize: '14px', fontWeight: 600 },
      sub: { margin: '4px 0 0', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      conn: { display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: '10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      button: {
        font: 'inherit', fontSize: '12px', padding: '5px 12px', borderRadius: '6px', cursor: 'pointer',
        whiteSpace: 'nowrap', flex: '0 0 auto',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      primary: { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' },
      small: { fontSize: '11px', padding: '3px 10px' },
      select: {
        font: 'inherit', fontSize: '12px', padding: '3px 6px', borderRadius: '5px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      input: {
        font: 'inherit', fontSize: '13px', padding: '6px 8px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)', width: '100%', boxSizing: 'border-box',
      },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      panelScroll: {
        height: '100%', overflow: 'auto', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      panelInner: { maxWidth: '960px', margin: '0 auto', padding: '24px 24px 40px' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' },
      note: { margin: '10px 0 0', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      list: { display: 'flex', flexDirection: 'column', marginTop: '12px' },
      item: {
        display: 'flex', flexDirection: 'column', gap: '4px',
        padding: '10px 2px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      itemHead: { display: 'flex', alignItems: 'center', gap: '10px', justifyContent: 'space-between' },
      itemTitleWrap: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0, flexWrap: 'wrap' },
      itemTitle: { fontSize: '13px', fontWeight: 500 },
      chip: { fontSize: '11px' },
      dirtyChip: {
        fontSize: '11px', fontWeight: 600, color: 'var(--dsw-alias-state-warn-primary)',
        border: '1px solid var(--dsw-alias-state-warn-primary)', borderRadius: '999px',
        padding: '1px 8px', whiteSpace: 'nowrap', flex: '0 0 auto',
      },
      itemDesc: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      itemRemotePath: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11.5px',
        color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all',
      },
      itemMeta: {
        display: 'grid', gridTemplateColumns: 'auto minmax(132px, auto) minmax(96px, auto) minmax(104px, auto)',
        alignItems: 'center', gap: '6px 16px', fontSize: '12px', marginTop: '2px',
      },
      metaItem: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, whiteSpace: 'nowrap' },
      actionButton: { minWidth: '78px', whiteSpace: 'nowrap', flex: '0 0 auto' },
      parts: {
        display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '2px',
        paddingLeft: '10px', borderLeft: '2px solid var(--dsw-alias-border-l1)',
      },
      part: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
      picker: {
        display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px', marginLeft: '10px',
        paddingLeft: '10px', borderLeft: '2px solid var(--dsw-alias-border-l1)',
      },
      pickerBar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      sessionList: {
        display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '240px', overflow: 'auto',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px', padding: '6px',
        background: 'var(--dsw-alias-bg-base)',
      },
      sessionRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0', cursor: 'pointer' },
      sessionMeta: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      sessionId: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11.5px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto',
      },
      dirs: {
        display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px',
        paddingLeft: '10px', borderLeft: '2px solid var(--dsw-alias-border-l1)',
      },
      dirRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      dirPath: { flex: '1 1 auto', fontSize: '12px', wordBreak: 'break-all' },
      dirAdd: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' },
      pre: {
        margin: '12px 0 0', padding: '10px', borderRadius: '8px', whiteSpace: 'pre-wrap',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
        fontSize: '12px', lineHeight: 1.5, maxHeight: '260px', overflow: 'auto',
      },
    }

    const TONE = {
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    /** Inline WebDAV form: the panel has real navigation, so nothing needs a dialog. */
    function ConnectionForm(props) {
      const { draft, onChange, onSave, busy, hasPassword } = props
      const bind = key => ({
        value: draft[key],
        onChange: event => onChange(key, event.target.value),
        style: css.input,
      })

      return h('section', { style: css.card },
        h('h2', { style: css.title }, '连接配置'),
        h('p', { style: css.sub }, 'WebDAV 目标与传输策略。保存后立即生效，不需要重启。'),
        h('div', { style: css.grid },
          h('label', { style: css.field },
            h('span', { style: css.label }, '设备名称'),
            h('input', { ...bind('machineName'), placeholder: 'macbook-office' }),
            h('span', { style: { ...css.label, opacity: 0.85 } },
              '纯英文，决定远端 machines/ 下的目录名。留空则自动生成。')),
          h('label', { style: css.field }, h('span', { style: css.label }, 'WebDAV 地址'),
            h('input', { ...bind('url'), placeholder: 'https://nas.example.com/dav/dsh' })),
          h('label', { style: css.field }, h('span', { style: css.label }, '用户名'),
            h('input', { ...bind('username'), autoComplete: 'off' })),
          h('label', { style: css.field }, h('span', { style: css.label }, hasPassword ? '密码（留空不修改）' : '密码'),
            h('input', { ...bind('password'), type: 'password', placeholder: '••••••' })),
          h('label', { style: css.field }, h('span', { style: css.label }, '远端子目录'),
            h('input', bind('remoteDir'))),
          h('label', { style: css.field }, h('span', { style: css.label }, '双向冲突策略'),
            h('select', { value: draft.conflict, style: css.input, onChange: e => onChange('conflict', e.target.value) },
              h('option', { value: 'both' }, 'both ｜ 保留双方副本'),
              h('option', { value: 'newer' }, 'newer ｜ 取较新'),
              h('option', { value: 'local' }, 'local ｜ 保本地'),
              h('option', { value: 'remote' }, 'remote ｜ 保远端'))),
          h('label', { style: css.field }, h('span', { style: css.label }, '单文件上限 (MB)'),
            h('input', { ...bind('maxFileMB'), inputMode: 'numeric' }))),
        h('p', { style: css.note }, '账号密码保存在本机 profile 配置里。若地址用 http://，口令与内容在链路上都是明文。'),
        h('div', { style: { ...css.actions, marginTop: '14px' } },
          h('button', {
            type: 'button', style: { ...css.button, ...css.primary },
            disabled: busy !== '', onClick: onSave,
          }, busy === 'conn' ? '保存中…' : '保存连接')))
    }

    function Switch(props) {
      const on = props.checked === true
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': props.label,
        title: props.label,
        disabled: props.disabled === true,
        onClick: () => props.onChange(!on),
        style: {
          flex: '0 0 auto', width: '32px', height: '18px', borderRadius: '999px', padding: '2px',
          cursor: props.disabled === true ? 'not-allowed' : 'pointer',
          opacity: props.disabled === true ? 0.5 : 1,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
          display: 'flex', alignItems: 'center',
          justifyContent: on ? 'flex-end' : 'flex-start',
          transition: 'background 120ms ease',
        },
      }, h('span', {
        style: {
          width: '12px', height: '12px', borderRadius: '50%',
          background: 'var(--dsw-alias-bg-base)', display: 'block',
        },
      }))
    }

    /** One enabled scope as a status card, in the style of the memory panel's cards. */
    function StatusCard(props) {
      const { row, direction, enabled, busy, configured, onSync } = props
      const [text, tone] = STATUS_TEXT[row.status] || ['—', 'idle']
      const running = busy === `item:${row.key}`
      const disabled = busy !== '' || !configured || enabled !== true

      return h('div', { style: css.statCard },
        h('div', { style: css.statHead },
          h('span', { style: { ...css.dot, background: TONE[tone] } }),
          h('span', { style: css.statTitle, title: row.title }, row.title),
          h('span', { style: css.statState }, text)),
        h('div', { style: css.statNumbers },
          h('span', { style: css.statBig }, row.localFiles === null ? '…' : String(row.localFiles)),
          h('span', { style: css.statUnit }, '项'),
          h('span', { style: css.statSize }, formatBytes(row.localBytes ?? 0))),
        h('div', { style: css.statLine },
          `远端 ${row.remoteFiles === null ? '—' : row.remoteFiles} 项 · 待上传 ${
            row.pending === null ? '—' : row.pending} 项 · ${row.message || '方向：' + (DIRECTION_LABEL[direction] || direction)}`),
        h('div', { style: css.statFooter },
          h('span', { style: css.statPath, title: row.remotePath }, row.remotePath || '—'),
          h('button', {
            type: 'button', style: { ...css.button, ...css.small },
            disabled,
            title: enabled !== true ? '该项已关闭' : `按「${DIRECTION_LABEL[direction]}」立即处理这一项`,
            onClick: () => onSync(row.key),
          }, running ? '执行中…' : (enabled === true ? ACTION_LABEL[direction] : '已关闭'))))
    }

    /** Destructive restore stays inline, separate from the saved direction. */
    function RestoreConfirmation({ row, state, blocked, onSource, onCancel, onConfirm }) {
      const loading = state.phase === 'loading'
      const running = state.phase === 'running'
      return h('section', {
        style: { ...css.card, marginTop: '8px', background: 'var(--dsw-alias-bg-layer-2)' },
        'aria-label': `${row.title}下载还原确认`, 'aria-busy': loading || running,
      },
      h('h3', { style: css.title }, `下载还原：${row.title}`),
      h('p', { style: { ...css.note, color: TONE.warn } },
        '将使用远端内容覆盖本地同名文件，未备份的本地修改会丢失。本地未匹配的文件不会删除。'),
      h('p', { style: css.note }, '此次操作使用已保存的配置，不采用未保存的方向或目录改动，也不会更改同步方向。'),
      row.key === 'extraPaths'
        ? h('p', { style: css.note }, '自定义远端目录始终从已保存的独立远端位置读取，不随设备备份来源切换。')
        : null,
      row.key === 'baseConfig'
        ? h('p', { style: css.note }, '配置文件还原后可能需要重启 DSH 才会生效。')
        : null,
      row.key === 'pluginInventory'
        ? h('p', { style: css.note }, '仅还原插件清单与锁文件，不会自动安装插件依赖；还原后需重新安装依赖。')
        : null,
      loading ? h('p', { style: css.note, role: 'status' }, '正在读取远端备份来源…') : null,
      !loading && state.sources.length > 0
        ? h('label', { style: { ...css.field, marginTop: '10px' } },
          h('span', { style: css.label }, '选择备份来源'),
          h('select', {
            style: css.input,
            value: state.source === null ? '@choose' : state.source,
            disabled: running,
            onChange: event => onSource(event.target.value),
          },
          h('option', { value: '@choose', disabled: true }, '请选择一份备份'),
          state.sources.map(source => h('option', { key: source.id, value: source.id }, source.label))))
        : null,
      !loading && !state.error && state.sources.length === 0
        ? h('p', { style: css.note }, '远端暂无可用备份来源。请先在其他设备上传备份。')
        : null,
      state.error ? h('p', { style: { ...css.note, color: TONE.bad }, role: 'alert' }, state.error) : null,
      h('div', { style: { ...css.actions, marginTop: '12px' } },
        h('button', { type: 'button', style: css.button, disabled: running, onClick: onCancel }, '取消'),
        h('button', {
          type: 'button', style: { ...css.button, ...css.primary },
          disabled: loading || running || blocked || state.source === null || state.sources.length === 0,
          onClick: onConfirm,
        }, running ? '正在覆盖并还原…' : '确认覆盖并还原')))
    }

    function ItemRow(props) {
      const { row, direction, enabled, busy, dirty, onEnabled, onDirection, dirList, dirDraft, onDirDraft, onAddDir, onRemoveDir, onEditRemote, remoteDraft, onRemoteDraft, restore, onRestore, onRestoreSource, onRestoreCancel, onRestoreConfirm } = props
      const [text, tone] = STATUS_TEXT[row.status] || ['—', 'idle']
      const statusLabel = row.message ? `${text} · ${row.message}` : text
      const generated = row.key === 'modelConfig' || row.key === 'mcpServers'
      const restoreSupported = !generated && row.restoreSupported !== false
      const restoreNote = row.restoreNote || (generated
        ? '模型配置与 MCP 的脱敏导出 JSON 不能直接写回运行配置，请随基础配置还原，或手动导入对应配置。'
        : '当前项目不支持下载还原。')

      return h('div', { style: css.item },
        h('div', { style: css.itemHead },
          h('div', { style: css.itemTitleWrap },
            h(Switch, {
              checked: enabled === true,
              label: `${row.title}：${enabled === true ? '参与同步' : '不参与同步'}`,
              onChange: onEnabled,
            }),
            h('span', { style: css.itemTitle }, row.title),
            h('span', { style: css.itemRemotePath, title: '远端目录（相对远端子目录）' }, row.remotePath || '—'),
            h('span', { style: { ...css.chip, color: TONE[tone] } }, statusLabel)),
          h('div', { style: { ...css.actions, alignItems: 'center', justifyContent: 'flex-end' } },
            dirty === true
              ? h('span', { style: css.dirtyChip, title: '这一项有未保存的改动' }, '已修改')
              : null,
            h('button', {
              type: 'button', style: { ...css.button, ...css.small },
              disabled: busy !== '' || !restoreSupported,
              title: restoreSupported ? `从远端备份覆盖还原${row.title}，与参与同步开关无关` : restoreNote,
              onClick: onRestore,
            }, '下载还原'))),

        h('div', { style: css.itemDesc }, row.note),
        !restoreSupported ? h('div', { style: css.itemDesc }, restoreNote) : null,
        restore ? h(RestoreConfirmation, {
          row, state: restore, blocked: busy !== '', onSource: onRestoreSource,
          onCancel: onRestoreCancel, onConfirm: onRestoreConfirm,
        }) : null,

        h('div', { style: css.itemMeta },
          h('label', { style: css.metaItem },
            h('span', { style: css.label }, '方向'),
            h('select', {
              style: { ...css.select, opacity: enabled === true ? 1 : 0.55 },
              value: direction,
              disabled: enabled !== true,
              'aria-label': `${row.title} 的同步方向`,
              onChange: event => onDirection(event.target.value),
            }, row.allowed.filter(value => value === 'push' || value === 'two-way').map(value => h('option', { key: value, value },
              DIRECTION_LABEL[value] || value)))),
          h('span', { style: css.metaItem },
            h('span', { style: css.label }, '本地'),
            h('span', { style: css.mono }, countText(row.localFiles, row.localBytes))),
          h('span', { style: css.metaItem },
            h('span', { style: css.label }, '远端'),
            h('span', { style: css.mono }, row.remoteFiles === null ? '—' : `${row.remoteFiles} 个`)),
          h('span', { style: css.metaItem },
            h('span', { style: css.label }, '待上传'),
            h('span', { style: css.mono }, row.pending === null ? '—' : `${row.pending} 个`))),

        Array.isArray(dirList)
          ? h('div', { style: css.dirs },
            dirList.length === 0
              ? h('span', { style: { ...css.label, ...css.dirPath } },
                row.key === 'extraPaths'
                  ? '还没有添加目录。在下面填本地路径；如果这份内容要在别处也能读到，再把远端路径填上。'
                  : '还没有添加目录。')
              : dirList.map(raw => {
                const entry = typeof raw === 'string' ? { path: raw, remote: '' } : raw
                return h('div', { key: entry.path, style: css.dirRow },
                  h('span', { style: { ...css.mono, ...css.dirPath } }, entry.path),
                  row.key === 'extraPaths'
                    ? h('input', {
                      style: { ...css.input, flex: '0 1 220px', fontSize: '12px' },
                      value: entry.remote,
                      placeholder: '远端路径，如 share/ai-out（留空=本机槽位）',
                      onChange: event => onEditRemote(entry.path, event.target.value),
                    })
                    : null,
                  h('button', {
                    type: 'button', style: { ...css.button, ...css.small },
                    disabled: busy !== '',
                    onClick: () => onRemoveDir(entry.path),
                  }, '移除'))
              }),
            h('div', { style: css.dirAdd },
              h('input', {
                style: { ...css.input, flex: '1 1 220px', fontSize: '12px' },
                value: dirDraft,
                placeholder: row.key === 'memory'
                  ? '例如 ~/.dsh/mnemon 或 ~/Library/Application Support/mnemon'
                  : '例如 ~/Documents/notes 或 /Volumes/disk/exports',
                onChange: event => onDirDraft(event.target.value),
                onKeyDown: event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onAddDir()
                  }
                },
              }),
              row.key === 'extraPaths'
                ? h('input', {
                  style: { ...css.input, flex: '0 1 220px', fontSize: '12px' },
                  value: remoteDraft,
                  placeholder: '远端路径，如 sata1-xxx/ai-public（可选）',
                  onChange: event => onRemoteDraft(event.target.value),
                  onKeyDown: event => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      onAddDir()
                    }
                  },
                })
                : null,
              h('button', {
                type: 'button', style: { ...css.button, ...css.small },
                disabled: busy !== '' || dirDraft.trim() === '',
                onClick: onAddDir,
              }, '添加')),
            h('span', { style: css.label }, row.key === 'memory'
              ? '留空则自动在 DSH 主目录下探测；填入 mnemon 的自定义 dataDir 可精确指定。'
              : '本地路径支持 ~ 表示用户主目录。第二个框是远端路径，相对 WebDAV 根目录，填了就直接写到那里（不进 DSH 目录），留空则写进本机槽位。每条可不同，最多 50 条。'))
          : null)
    }

    function SettingsPage() {
      const [status, setStatus] = useState(null)
      const [items, setItems] = useState({})
      const [enabled, setEnabled] = useState({})
      const [dirLists, setDirLists] = useState({ extraPaths: [], memory: [] })
      const [dirDrafts, setDirDrafts] = useState({ extraPaths: '', memory: '' })
      const [remoteDraft, setRemoteDraft] = useState('')
      const [conn, setConn] = useState(null)
      const [view, setView] = useState('home')
      const [busy, setBusy] = useState('')
      const [syncing, setSyncing] = useState(false)
      const [message, setMessage] = useState(null)
      const [restore, setRestore] = useState(null)
      const restoreEpoch = useRef(0)
      const restoreAbort = useRef(null)
      const restoreRunning = useRef(false)

      useEffect(() => () => {
        restoreEpoch.current += 1
        restoreAbort.current?.abort()
      }, [])

      const adopt = useCallback((next, syncDrafts = true) => {
        setStatus(next)
        if (syncDrafts === false) return
        const directions = {}
        const switches = {}
        for (const row of next.rows) {
          switches[row.key] = row.direction !== 'off'
          directions[row.key] = syncDirection(row, row.configuredDirection)
        }
        setItems(directions)
        setEnabled(switches)
        setDirLists({
          extraPaths: Array.isArray(next.extraDirs) ? next.extraDirs : [],
          memory: Array.isArray(next.memoryDirs) ? next.memoryDirs : [],
        })
        setConn({
          machineName: next.connection.machineName,
          url: next.connection.url,
          username: next.connection.username,
          password: '',
          remoteDir: next.base,
          pullFrom: next.pullFrom,
          overwrite: next.connection.overwrite,
          conflict: next.connection.conflict,
          maxFileMB: String(next.connection.maxFileMB),
        })
      }, [])

      /**
       * Load the comparison numbers. `fresh` drops the server-side listing cache,
       * which is what a manual refresh should do; the first paint does not pay for it.
       */
      const load = useCallback(async (label, fresh = false, silent = false) => {
        if (!silent) setBusy(label)
        else setSyncing(true)
        try {
          const next = await request(`${API}/status${fresh ? '?fresh=1' : ''}`)
          cachedStatus = next
          cachedStatusAt = Date.now()
          // A silent refresh must not overwrite edits the user already started.
          adopt(next, !silent)
          return next
        } catch (error) {
          if (!silent) setMessage({ tone: 'bad', text: `读取状态失败：${error.message}` })
          return null
        } finally {
          if (!silent) setBusy('')
          else setSyncing(false)
        }
      }, [adopt])

      /**
       * First paint never waits on the network when a previous comparison exists:
       * the cached payload renders at once and a silent refresh updates it behind
       * the user's back.
       */
      useEffect(() => {
        let cancelled = false
        const bootstrap = async () => {
          if (cachedStatus !== null) {
            // Cached numbers first, then a real re-read — not another cache hit.
            adopt(cachedStatus)
            if (!cancelled && Date.now() - cachedStatusAt > AUTO_REFRESH_MS) {
              await load('initial', true, true)
            }
            return
          }
          try {
            const overview = await request(`${API}/overview`)
            if (!cancelled) adopt(overview)
          } catch (error) {
            if (!cancelled) setMessage({ tone: 'bad', text: `读取配置失败：${error.message}` })
          }
          if (!cancelled) await load('initial', true, true)
        }
        bootstrap()
        return () => { cancelled = true }
      }, [adopt, load])

      const changeDirection = useCallback((key, direction) => {
        setItems(current => ({ ...current, [key]: direction }))
      }, [])

      const toggleEnabled = useCallback((key, next) => {
        setEnabled(current => ({ ...current, [key]: next }))
      }, [])

      const pathOf = entry => (typeof entry === 'string' ? entry : entry.path)

      const addDir = useCallback(key => {
        const value = (dirDrafts[key] || '').trim()
        if (value === '') return
        const remote = key === 'extraPaths' ? remoteDraft.trim().replace(/^\/+|\/+$/g, '') : ''
        setDirLists(current => {
          const list = current[key]
          if (list.some(entry => pathOf(entry) === value)) return current
          // Only the extra-directories scope carries a remote target.
          const added = key === 'extraPaths' ? { path: value, remote } : value
          return { ...current, [key]: [...list, added] }
        })
        setDirDrafts(current => ({ ...current, [key]: '' }))
        if (key === 'extraPaths') setRemoteDraft('')
      }, [dirDrafts, remoteDraft])

      const removeDir = useCallback((key, path) => {
        setDirLists(current => ({
          ...current,
          [key]: current[key].filter(entry => pathOf(entry) !== path),
        }))
      }, [])

      const editRemote = useCallback((path, remote) => {
        setDirLists(current => ({
          ...current,
          extraPaths: current.extraPaths.map(entry => (
            (typeof entry === 'string' ? entry : entry.path) === path
              ? { path, remote }
              : entry
          )),
        }))
      }, [])

      const saveDirections = useCallback(async () => {
        setBusy('save')
        setMessage(null)
        try {
          await post(`${API}/config`, {
            items, enabled,
            extraDirs: dirLists.extraPaths, memoryDirs: dirLists.memory,
          })
          setMessage({ tone: 'ok', text: '同步内容已保存。' })
        } catch (error) {
          setMessage({ tone: 'bad', text: `保存失败：${error.message}` })
        }
        await load('refresh', true)
      }, [dirLists, enabled, items, load])

      const saveConnection = useCallback(async () => {
        setBusy('conn')
        try {
          const { pullFrom: _pullFrom, overwrite: _overwrite, ...settings } = conn
          if (settings.password === '') delete settings.password
          await post(`${API}/config`, { settings })
          setMessage({ tone: 'ok', text: '连接设置已保存。' })
        } catch (error) {
          setMessage({ tone: 'bad', text: `连接设置保存失败：${error.message}` })
        } finally {
          setBusy('')
        }
        await load('refresh', true)
      }, [conn, load])

      const runScopes = useCallback(async (keys, dryRun, label) => {
        setBusy(label)
        setMessage(null)
        try {
          const result = await post(`${API}/run`, { items: keys, dryRun })
          setMessage({ tone: 'ok', text: result.text || '完成。' })
        } catch (error) {
          setMessage({ tone: 'bad', text: `执行失败：${error.message}` })
        } finally {
          setBusy('')
        }
        await load('refresh')
      }, [load])

      const cancelRestore = useCallback(() => {
        // Once submitted, a restore is not safely cancellable. Keep its progress
        // visible; cancellation here only dismisses the preflight confirmation.
        if (restoreRunning.current) return
        restoreEpoch.current += 1
        restoreAbort.current?.abort()
        restoreAbort.current = null
        setRestore(null)
      }, [])

      const openRestore = useCallback(async row => {
        if (restoreRunning.current || busy !== '') return
        restoreAbort.current?.abort()
        const controller = new AbortController()
        restoreAbort.current = controller
        const epoch = ++restoreEpoch.current
        setMessage(null)
        setRestore({ key: row.key, sources: [], source: null, phase: 'loading', error: '' })
        try {
          const result = await request(`${API}/restore-sources`, { signal: controller.signal })
          if (epoch !== restoreEpoch.current || controller.signal.aborted) return
          if (!Array.isArray(result?.sources)) throw new Error('远端备份来源返回格式不正确')
          const sources = result.sources.filter(source => typeof source?.id === 'string' && typeof source?.label === 'string')
          // Prefer this machine's backup, then another machine. The shared tree
          // is only selected explicitly, never silently used as the default.
          const preferred = sources.find(source => source.id !== '' && source.id === status?.machine)
            || sources.find(source => source.id !== '')
          setRestore({ key: row.key, sources, source: preferred?.id ?? null, phase: 'ready', error: '' })
        } catch (error) {
          if (epoch !== restoreEpoch.current || controller.signal.aborted) return
          setRestore({ key: row.key, sources: [], source: null, phase: 'ready', error: `读取备份来源失败：${error.message}` })
        }
      }, [busy, status?.machine])

      const confirmRestore = useCallback(async () => {
        if (!restore || restore.phase !== 'ready' || restoreRunning.current || busy !== ''
          || restore.source === null || !restore.sources.some(source => source.id === restore.source)) return
        const epoch = restoreEpoch.current
        const { key, source } = restore
        restoreRunning.current = true
        setBusy(`restore:${key}`)
        setMessage(null)
        setRestore(current => current ? { ...current, phase: 'running', error: '' } : current)
        try {
          // Only item identity and source are sent: the server applies saved
          // configuration, never this page's unsaved direction/path drafts.
          const result = await post(`${API}/restore`, { item: key, source, confirmed: true })
          if (epoch !== restoreEpoch.current) return
          const successText = result.text || '下载还原完成。'
          setMessage({ tone: 'ok', text: successText })
          setRestore(null)
          const refreshed = await load('refresh', true, true)
          if (epoch === restoreEpoch.current && refreshed === null) {
            setMessage({
              tone: 'warn',
              text: `${successText}\n还原已完成，但刷新比对失败；当前仍显示上次比对结果，请手动刷新。`,
            })
          }
        } catch (error) {
          if (epoch !== restoreEpoch.current) return
          const text = `下载还原失败：${error.message}`
          setMessage({ tone: 'bad', text })
          setRestore(current => current ? { ...current, phase: 'ready', error: text } : current)
        } finally {
          restoreRunning.current = false
          if (epoch === restoreEpoch.current) setBusy('')
        }
      }, [restore, busy, load])

      const rows = status === null ? [] : status.rows
      const totals = status === null ? null : status.totals
      // Execution follows what is SAVED, never the unsaved draft: a switch flipped
      // on the config page must not affect a run until 保存修改 is pressed.
      const activeKeys = rows.filter(row => row.direction !== 'off').map(row => row.key)
      // Which rows differ from what is saved, so each row can mark itself.
      const dirtyKeys = new Set()
      if (status !== null) {
        for (const row of rows) {
          if (enabled[row.key] !== (row.direction !== 'off')
            || items[row.key] !== syncDirection(row, row.configuredDirection)) {
            dirtyKeys.add(row.key)
          }
        }
        if (JSON.stringify(dirLists.extraPaths) !== JSON.stringify(status.extraDirs || [])) {
          dirtyKeys.add('extraPaths')
        }
        if (JSON.stringify(dirLists.memory) !== JSON.stringify(status.memoryDirs || [])) {
          dirtyKeys.add('memory')
        }
      }
      const pendingChanges = dirtyKeys.size > 0


      const nav = h('nav', { style: css.tabs, role: 'tablist' },
        VIEWS.map(entry => h('button', {
          key: entry.key,
          type: 'button',
          role: 'tab',
          'aria-selected': view === entry.key ? 'true' : 'false',
          disabled: busy.startsWith('restore:'),
          onClick: () => { cancelRestore(); setView(entry.key) },
          style: { ...css.tab, ...(view === entry.key ? css.tabActive : {}) },
        }, entry.label)))

      const header = h('header', { style: css.panelHead },
        h('div', { style: css.headText },
          h('h1', { style: css.panelTitle }, PANEL_TITLE),
          h('p', { style: css.sub }, '把 DSH 的内容备份与同步到远程存储，支持多端共享与还原。')))

      const rowProps = row => ({
        key: row.key,
        row,
        direction: syncDirection(row, items[row.key] || row.configuredDirection),
        enabled: enabled[row.key] === true,
        busy,
        configured: Boolean(status && status.configured),
        onEnabled: value => toggleEnabled(row.key, value),
        onDirection: value => changeDirection(row.key, value),
        onSync: key => runScopes([key], false, `item:${key}`),
        dirty: dirtyKeys.has(row.key),
        restore: restore?.key === row.key ? restore : null,
        onRestore: () => openRestore(row),
        onRestoreSource: source => setRestore(current => current && current.phase !== 'running'
          && current.sources.some(entry => entry.id === source)
          ? { ...current, source, error: '' } : current),
        onRestoreCancel: cancelRestore,
        onRestoreConfirm: confirmRestore,
        dirList: PATH_ROWS.includes(row.key) ? dirLists[row.key] : undefined,
        dirDraft: dirDrafts[row.key] || '',
        onDirDraft: value => setDirDrafts(current => ({ ...current, [row.key]: value })),
        onAddDir: () => addDir(row.key),
        onRemoveDir: entry => removeDir(row.key, entry),
        onEditRemote: editRemote,
        remoteDraft,
        onRemoteDraft: setRemoteDraft,
      })

      const enabledRows = rows.filter(row => enabled[row.key] === true)

      const infoCard = h('section', { style: css.card },
        h('div', { style: css.headRow },
          h('div', { style: css.headText },
            h('h2', { style: css.title }, '连接与状态'),
            h('p', { style: css.sub }, status === null
              ? '正在读取配置……'
              : (status.configured
                ? `比对于 ${status.refreshedAt ? new Date(status.refreshedAt).toLocaleString() : '—'}`
                  + (syncing ? ' · 正在后台更新…' : '')
                : '尚未配置 WebDAV 地址，只显示本地清点结果。'))),
          h('div', { style: css.actions },
            h('button', {
              type: 'button', style: css.button, disabled: busy !== '',
              onClick: () => load('refresh', true),
            }, busy === 'refresh' ? '刷新中…' : '刷新比对'),
            h('button', {
              type: 'button', style: { ...css.button, ...css.primary },
              disabled: busy !== '' || !status || !status.configured,
              onClick: () => runScopes(activeKeys, false, 'all'),
            }, busy === 'all' ? '执行中…' : '按方向全部执行'))),
        status === null
          ? null
          : h('div', { style: css.infoGrid },
            h('div', { style: css.infoItem },
              h('span', { style: css.infoLabel }, '地址'),
              h('span', { style: css.infoValue }, status.configured ? status.connection.url : '未配置')),
            h('div', { style: css.infoItem },
              h('span', { style: css.infoLabel }, '远端子目录'),
              h('span', { style: css.infoValue }, status.base)),
            h('div', { style: css.infoItem },
              h('span', { style: css.infoLabel }, '本机槽位'),
              h('span', { style: css.infoValue }, status.machine)),
            h('div', { style: css.infoItem },
              h('span', { style: css.infoLabel }, '启用 / 本地 / 待上传'),
              h('span', { style: css.infoValue }, totals === null
                ? '—'
                : `${totals.enabledItems} 项 · ${totals.localFiles} 个文件 · ${totals.pending} 项待传`))),
        status !== null && status.remoteError
          ? h('p', { style: { ...css.note, color: TONE.warn } }, status.remoteError)
          : null,
        pendingChanges
          ? h('p', { style: { ...css.note, color: TONE.warn } },
            '同步内容配置里有未保存的改动，保存后才会生效。')
          : null)

      const homeBody = h('div', { style: css.viewBody },
        infoCard,
        enabledRows.length === 0
          ? h('p', { style: css.note }, '还没有启用任何同步内容。到「同步内容配置」打开要备份的项。')
          : h('div', { style: css.statGrid },
            enabledRows.map(row => h(StatusCard, {
              ...rowProps(row),
              key: row.key,
              enabled: row.direction !== 'off',
            }))))

      const itemsBody = h('div', { style: css.viewBody },
        h('section', { style: css.card },
          h('div', { style: css.headRow },
            h('div', { style: css.headText },
              h('h2', { style: css.title }, '同步内容配置'),
              h('p', { style: css.sub },
                '每项独立设置：左侧开关决定参不参与，右侧方向决定怎么同步。')),
            h('div', { style: css.actions },
              h('button', {
                type: 'button', style: { ...css.button, ...(pendingChanges ? css.primary : {}) },
                disabled: busy !== '' || !pendingChanges, onClick: saveDirections,
              }, busy === 'save' ? '保存中…' : '保存修改'))),
          h('div', { style: css.rules },
            h('span', { style: css.rulesTerm }, '关闭'),
            h('span', { style: css.rulesText },
              '不参与任何同步，本地和远端都不动。开关关掉即为此状态。'),
            h('span', { style: css.rulesTerm }, '上传备份'),
            h('span', { style: css.rulesText },
              '只把本地写进远端的本机槽位 machines/<本机槽位>/。按文件内容哈希增量上传，'
              + '本地删掉的文件不会从远端删除，远端也从不回写本地。'),
            h('span', { style: css.rulesTerm }, '下载还原'),
            h('span', { style: css.rulesText },
              '每项右上角的独立一次性操作，不属于同步方向。选择备份来源并确认后，'
              + '远端文件会覆盖本地同名文件；本地未匹配的文件不删除。使用已保存的配置，不采用未保存的改动。'),
            h('span', { style: css.rulesTerm }, '双向同步'),
            h('span', { style: css.rulesText },
              '与共享区 shared/ 对账，两边都会写。靠基线区分「只有我改了」和「只有别人改了」；'
              + '双方都改时按冲突策略保留双方副本。删除同样不传播。'),
            h('span', { style: css.rulesTerm }, '注意'),
            h('span', { style: css.rulesText },
              '模型配置、MCP、已安装插件这类从实时服务导出或含本机路径的项，'
              + '方向只可选上传备份，参与开关独立控制。模型配置与 MCP 的导出文件不能直接还原，请随基础配置恢复。')),
          h('div', { style: css.list },
            rows.map(row => h(ItemRow, rowProps(row)))),
          pendingChanges
            ? h('p', { style: { ...css.note, color: TONE.warn } },
              '改动还没保存，点右上角「保存修改」后才会生效。')
            : null))

      const connectionBody = conn === null
        ? h('div', { style: css.viewBody }, h('p', { style: css.sub }, '正在读取配置……'))
        : h('div', { style: css.viewBody }, h(ConnectionForm, {
          draft: conn,
          hasPassword: Boolean(status && status.configured),
          busy,
          onChange: (key, value) => setConn(current => ({ ...current, [key]: value })),
          onSave: saveConnection,
        }))

      return h('div', { style: css.page },
        header,
        nav,
        view === 'home' ? homeBody : view === 'items' ? itemsBody : connectionBody,
        message === null ? null : h('pre', { style: { ...css.pre, color: TONE[message.tone] || undefined } }, message.text))
    }

    function SectionIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block' },
      },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 4, rx: 1, fill: 'currentColor', opacity: 0.85 }),
        h('rect', { x: 1.5, y: 9.5, width: 13, height: 4, rx: 1, fill: 'currentColor', opacity: 0.45 }),
        h('circle', { cx: 3.8, cy: 4.5, r: 0.9, fill: 'var(--dsw-alias-bg-base)' }),
        h('circle', { cx: 3.8, cy: 11.5, r: 0.9, fill: 'var(--dsw-alias-bg-base)' }))
    }

    /** The panel rendered in the main column when the sidebar icon is chosen. */
    function MainPanel() {
      return h('div', { style: css.panelScroll },
        h('div', { style: css.panelInner }, h(SettingsPage)))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // A first-class panel beside Plugins / Schedules / Mnemon: the sidebar list
        // only renders its icon, so the main panel is registered with the same key.
        ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
          const stopPanel = ctx.slots.register({ name: 'main', key: SECTION_ID }, MainPanel)
          let stopIcon
          try {
            stopIcon = ctx.slots.register({
              name: 'sidebar.panellist', id: SECTION_ID, order: 20, label: MENU_LABEL,
            }, SectionIcon)
          } catch (error) {
            stopPanel?.()
            throw error
          }
          return () => {
            stopIcon?.()
            stopPanel?.()
          }
        }))
      },
    }
  },
})
