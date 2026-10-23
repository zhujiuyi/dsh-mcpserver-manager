/**
 * @zhujiuyi/dsh-mcpserver-manager — browser half (DSH web client).
 *
 * Loaded as a classic script through `window.__ModuleLoader__.load()`, exactly
 * like every other client bundle. Conventions this file keeps:
 *   - `id` equals the package name, because that identity is how the loader and
 *     the Plugins page address this bundle;
 *   - only the platform-seed specifier `react` is required — no Harness client
 *     package is imported as a module;
 *   - styles are self-contained: no @import, no remote URL, and every colour
 *     comes from a `--dsw-*` token, so a theme swap degrades appearance rather
 *     than rendering;
 *   - nothing writes host DOM outside this plugin's own slot.
 *
 * Two extension points are registered:
 *   - `main` (key `mcp-manager`) — the manager page itself.
 *   - `sidebar.panellist` (id `mcp-manager`, order 6) — the sidebar row, which
 *     opens that main panel by id.
 *
 * Data comes from the host half's `/api/mcp-manager/*` routes.
 */

window.__ModuleLoader__.load({
  id: '@zhujiuyi/dsh-mcpserver-manager',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Locale namespace this browser half owns. */
    const NS = 'mcpManager'
    /** Route prefix the host half registers. */
    const API = '/api/mcp-manager'
    /** Re-read cadence while the page is visible. */
    const POLL_MS = 15000

    // ── dictionaries ────────────────────────────────────────────────────────
    const zh = {
      lang: 'zh',
      nav: 'MCP 服务',
      title: 'MCP 管理',
      lede: '查看已配置的 MCP 服务、它们提供的工具与连接状态；新增、编辑或删除单个服务，其他服务的配置不受影响。',
      refresh: '刷新',
      refreshing: '刷新中…',
      loading: '正在读取配置…',
      lastUpdated: '最后更新',
      never: '尚未读取',
      count: '{n} 个服务',
      summary: '{c} 个已连接 · {t} 个工具',
      summaryIssue: '{c} 个已连接 · {e} 个异常 · {t} 个工具',
      emptyTitle: '还没有配置任何 MCP 服务',
      emptyBody: '接入一个服务，即可在这里查看连接状态、可用工具与配置。',
      emptyAdd: '新增服务',
      searchPlaceholder: '搜索服务或工具',
      searchClear: '清除搜索',
      noMatch: '没有匹配 “{q}” 的服务',
      addServer: '新增服务',
      sectionTools: '可用工具',
      sectionConfig: '配置文件',
      toolsEmptyConnected: '该服务已连接，但没有声明任何工具。',
      toolsEmptyInactive: '该服务当前未启用，启用后会重新获取工具列表。',
      toolsEmptyError: '连接失败，暂时无法获取工具列表。',
      toolsEmptyUnknown: '尚未获取到工具列表。',
      schema: 'Input schema',
      stateConnected: '已连接',
      stateInactive: '未启用',
      stateError: '连接异常',
      stateUnknown: '状态未知',
      metaTransport: '传输方式',
      metaTools: '工具数量',
      toolsUnit: '个工具',
      tabConfig: '配置文本',
      editConfigHint: '直接修改下面的配置（两种格式都支持）；保存时会重新解析并检查',
      editOneOnly: '编辑只能对应一个服务',
      editReady: '{n} 个服务，可以保存',
      metaPrefix: '工具前缀',
      metaRowId: '条目 ID',
      edit: '编辑',
      remove: '删除',
      enable: '启用',
      disable: '停用',
      retry: '重试',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败',
      removeTitle: '删除 {name}？',
      removeBody: '该服务的配置条目将从 cordis.patch.yml 中移除，连接会立即断开。其他服务不受影响。',
      removeConfirm: '删除服务',
      cancel: '取消',
      // add dialog
      addTitle: '新增 MCP 服务',
      addEyebrow: '接入新服务',
      tabImport: '粘贴配置',
      tabManual: '手动填写',
      importHintDsh: '支持 dsh 的 - insert: 片段、@mcp 简写，或 Claude Code 的 mcpServers JSON — 自动识别。',
      importLabel: '配置内容',
      importPlaceholder: '粘贴 dsh 片段、@mcp 简写，或 {"mcpServers": {...}} JSON',
      fillSample: '填入示例',
      parseEmpty: '粘贴配置后自动解析，并在这里预览将被添加的服务。',
      parseError: '解析失败',
      parsedCount: '{n} 个服务待添加',
      parsedDialect: '识别为 {d} 格式',
      dialectDsh: 'dsh',
      dialectJson: 'Claude Code JSON',
      duplicate: '已存在',
      duplicateInInput: '输入内重复',
      submitAdd: '添加服务',
      submitting: '写入中…',
      // manual form
      fName: 'serverName',
      fNameHint: '命名空间，工具名会变成 mcp__<名称>__<工具>',
      fTransport: '传输方式',
      fCommand: '启动命令',
      fArgs: '命令参数',
      fArgsHint: '每行一个',
      fEnv: '环境变量',
      fEnvHint: 'KEY=VALUE，每行一个',
      fCwd: '工作目录',
      fCwdHint: '留空则继承 dsh 进程目录',
      fUrl: '服务 URL',
      fHeaders: '请求头',
      fHeadersHint: 'KEY=VALUE，每行一个',
      fTimeout: '调用超时（毫秒）',
      fFailStartup: '启动时连接失败则拒绝加载',
      required: '必填',
      // edit dialog
      editTitle: '编辑 {name}',
      editEyebrow: '编辑服务配置',
      editHint: '只修改这一个服务的配置，其他服务保持原样。保存后立即生效。',
      submitEdit: '保存配置',
      // results
      addedToast: '已添加 {n} 个服务，配置已生效',
      updatedToast: '已保存 {name} 的配置',
      removedToast: '已删除 {name}',
      toggledOnToast: '已启用 {name}',
      toggledOffToast: '已停用 {name}',
      backupNote: '已备份原配置',
      errName: '请填写服务名称',
      errNamePattern: '只允许字母、数字、下划线和短横线，1–32 个字符',
      errCommand: 'stdio 需要启动命令',
      errUrl: 'streamable-http 需要服务地址',
      errUrlInvalid: '地址格式不正确',
      errEnv: '环境变量需要 KEY=VALUE 格式',
      errHeaders: '请求头需要 KEY=VALUE 格式',
      errGeneric: '操作失败',
      warnings: '注意',
      ignorePreflight: '仍然保存',
      ignorePreflightHint: '跳过这些检查继续保存；仅当你确定这些提示在本机不成立时使用',
      level_error: '错误',
      level_warning: '警告',
      level_info: '提示',
      patchPath: '配置文件',
    }

    const en = {
      lang: 'en',
      nav: 'MCP servers',
      title: 'MCP manager',
      lede: 'Inspect every configured MCP server, the tools it provides and its connection state; add, edit or remove one server at a time without touching the others.',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      loading: 'Reading configuration…',
      lastUpdated: 'Last updated',
      never: 'Never',
      count: '{n} servers',
      summary: '{c} connected · {t} tools',
      summaryIssue: '{c} connected · {e} issues · {t} tools',
      emptyTitle: 'No MCP servers configured',
      emptyBody: 'Add a server to inspect its connection state, tools and configuration here.',
      emptyAdd: 'Add server',
      searchPlaceholder: 'Search servers or tools',
      searchClear: 'Clear search',
      noMatch: 'No server matches “{q}”',
      addServer: 'Add server',
      sectionTools: 'Available tools',
      sectionConfig: 'Configuration',
      toolsEmptyConnected: 'Connected, but the server declares no tools.',
      toolsEmptyInactive: 'This server is not enabled; enabling it re-fetches the tool list.',
      toolsEmptyError: 'The connection failed, so no tool list is available.',
      toolsEmptyUnknown: 'No tool list has been observed yet.',
      schema: 'Input schema',
      stateConnected: 'Connected',
      stateInactive: 'Not enabled',
      stateError: 'Connection error',
      stateUnknown: 'Unknown state',
      metaTransport: 'Transport',
      metaTools: 'Tools',
      toolsUnit: 'tools',
      tabConfig: 'Config text',
      editConfigHint: 'Edit the configuration below directly; either dialect works, and saving re-parses and checks it',
      editOneOnly: 'An edit must describe exactly one server',
      editReady: '{n} server, ready to save',
      metaPrefix: 'Tool prefix',
      metaRowId: 'Row id',
      edit: 'Edit',
      remove: 'Remove',
      enable: 'Enable',
      disable: 'Disable',
      retry: 'Retry',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      removeTitle: 'Remove {name}?',
      removeBody: 'Its configuration row is removed from cordis.patch.yml and the connection closes immediately. Other servers are unaffected.',
      removeConfirm: 'Remove server',
      cancel: 'Cancel',
      addTitle: 'Add an MCP server',
      addEyebrow: 'Connect a server',
      tabImport: 'Paste configuration',
      tabManual: 'Fill in manually',
      importHintDsh: 'Accepts a dsh - insert: fragment, the @mcp shorthand, or a Claude Code mcpServers JSON block — detected automatically.',
      importLabel: 'Configuration',
      importPlaceholder: 'Paste a dsh fragment, @mcp shorthand, or {"mcpServers": {...}} JSON',
      fillSample: 'Fill sample',
      parseEmpty: 'Paste a configuration to preview the servers that will be added.',
      parseError: 'Parse failed',
      parsedCount: '{n} servers ready',
      parsedDialect: 'Detected {d}',
      dialectDsh: 'dsh',
      dialectJson: 'Claude Code JSON',
      duplicate: 'exists',
      duplicateInInput: 'duplicated',
      submitAdd: 'Add server',
      submitting: 'Writing…',
      fName: 'serverName',
      fNameHint: 'Namespace; tools become mcp__<name>__<tool>',
      fTransport: 'Transport',
      fCommand: 'Command',
      fArgs: 'Arguments',
      fArgsHint: 'One per line',
      fEnv: 'Environment',
      fEnvHint: 'KEY=VALUE, one per line',
      fCwd: 'Working directory',
      fCwdHint: 'Empty inherits the dsh process directory',
      fUrl: 'Server URL',
      fHeaders: 'Headers',
      fHeadersHint: 'KEY=VALUE, one per line',
      fTimeout: 'Call timeout (ms)',
      fFailStartup: 'Refuse to load when the first connection fails',
      required: 'required',
      editTitle: 'Edit {name}',
      editEyebrow: 'Edit server configuration',
      editHint: 'Only this server changes; the rest keep their configuration. Applied immediately on save.',
      submitEdit: 'Save configuration',
      addedToast: 'Added {n} server(s); configuration is live',
      updatedToast: 'Saved the configuration for {name}',
      removedToast: 'Removed {name}',
      toggledOnToast: 'Enabled {name}',
      toggledOffToast: 'Disabled {name}',
      backupNote: 'Previous configuration backed up',
      errName: 'A server name is required',
      errNamePattern: 'Use letters, digits, underscores or dashes, 1–32 characters',
      errCommand: 'stdio needs a command',
      errUrl: 'streamable-http needs a URL',
      errUrlInvalid: 'That URL is not valid',
      errEnv: 'Environment needs KEY=VALUE lines',
      errHeaders: 'Headers need KEY=VALUE lines',
      errGeneric: 'The operation failed',
      warnings: 'Note',
      ignorePreflight: 'Save anyway',
      ignorePreflightHint: 'Skip these checks and save; use only when you know they do not apply here',
      level_error: 'Error',
      level_warning: 'Warning',
      level_info: 'Info',
      patchPath: 'Configuration file',
    }

    // ── styles ──────────────────────────────────────────────────────────────
    const CSS = `
.mcpm {
  --mcpm-gap: 8px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, system-ui, sans-serif);
}
.mcpm * { box-sizing: border-box; }
.mcpm-top {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 20px; border-bottom: 1px solid var(--dsw-alias-border-l2);
  flex-wrap: wrap;
}
.mcpm-title { margin: 0; font-size: 16px; font-weight: 600; }
.mcpm-lede {
  margin: 0; font-size: 12.5px; color: var(--dsw-alias-label-tertiary);
  max-width: 62ch; line-height: 1.6; flex: 1 1 240px; min-width: 0;
}
.mcpm-top-actions { display: flex; gap: 8px; margin-left: auto; flex-wrap: wrap; }

.mcpm-body { display: grid; grid-template-columns: 268px minmax(0, 1fr); min-height: 0; flex: 1; }
.mcpm-rail {
  display: flex; flex-direction: column; min-height: 0;
  border-right: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.mcpm-search { padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.mcpm-search input {
  width: 100%; height: 32px; padding: 0 10px; font: inherit; font-size: 13px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm, 6px);
}
.mcpm-search input:focus {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color);
  outline-offset: 1px;
}
.mcpm-list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; }
.mcpm-item {
  display: flex; align-items: center; gap: 9px; width: 100%;
  padding: 9px 10px; margin-bottom: 2px; text-align: left;
  border: 1px solid transparent; border-radius: var(--dsw-radius-md, 8px);
  background: transparent; color: inherit; cursor: pointer; font: inherit;
}
.mcpm-item:hover { background: var(--dsw-alias-bg-layer-2); }
.mcpm-item[aria-current="true"] {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-border-l3);
}
.mcpm-item-main { display: grid; gap: 2px; flex: 1; min-width: 0; }
.mcpm-item-name {
  font-size: 13px; font-weight: 600; font-family: ui-monospace, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mcpm-item-sub {
  font-size: 11.5px; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mcpm-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary); }
.mcpm-dot.connected { background: var(--dsw-alias-state-success-primary); }
.mcpm-dot.error { background: var(--dsw-alias-state-error-primary); }
.mcpm-dot.unknown { background: var(--dsw-alias-state-warn-primary); }
.mcpm-empty-rail { padding: 24px 12px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary); }

.mcpm-detail { min-height: 0; overflow-y: auto; padding: 20px 24px 48px; }
.mcpm-detail-inner { max-width: 900px; }
.mcpm-h1 { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 21px; font-weight: 600; font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
.mcpm-pill {
  display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px;
  border-radius: 999px; font-size: 11.5px; font-weight: 500;
  border: 1px solid var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-secondary);
}
.mcpm-pill.connected { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.mcpm-pill.error { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.mcpm-pill.unknown { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.mcpm-endpoint {
  margin: 7px 0 0; font-size: 12.5px; font-family: ui-monospace, monospace;
  color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; line-height: 1.6;
}
.mcpm-detail-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }

.mcpm-meta {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1px;
  margin-top: 18px; background: var(--dsw-alias-border-l2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md, 8px); overflow: hidden;
}
.mcpm-meta-cell { padding: 10px 13px; background: var(--dsw-alias-bg-layer-1); min-width: 0; }
.mcpm-meta-label {
  display: block; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary); margin-bottom: 4px;
}
.mcpm-meta-value {
  display: block; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mcpm-meta-value.mono { font-family: ui-monospace, monospace; font-size: 12px; }

.mcpm-section { margin-top: 26px; }
.mcpm-section-head { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; flex-wrap: wrap; }
.mcpm-section-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
.mcpm-count {
  display: inline-flex; align-items: center; height: 18px; padding: 0 6px;
  border-radius: 4px; font-size: 11px; font-family: ui-monospace, monospace;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}

.mcpm-tools { border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); overflow: hidden; }
.mcpm-tool + .mcpm-tool { border-top: 1px solid var(--dsw-alias-border-l2); }
.mcpm-tool-head {
  display: flex; align-items: center; gap: 12px; width: 100%;
  padding: 10px 13px; text-align: left; background: none; border: 0;
  color: inherit; cursor: pointer; font: inherit;
}
.mcpm-tool-head:hover { background: var(--dsw-alias-bg-layer-2); }
.mcpm-tool-id { display: grid; gap: 2px; flex: 1; min-width: 0; }
.mcpm-tool-name { font-size: 12.5px; font-weight: 600; font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
.mcpm-tool-desc {
  font-size: 12px; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mcpm-chev { flex: none; transition: transform .16s ease-out; color: var(--dsw-alias-label-tertiary); }
.mcpm-tool-head[aria-expanded="true"] .mcpm-chev { transform: rotate(180deg); }
.mcpm-tool-body {
  padding: 2px 13px 13px; border-top: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}
.mcpm-tool-body-desc { margin: 11px 0 10px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); max-width: 72ch; line-height: 1.6; }
.mcpm-schema-label {
  margin: 0 0 6px; font-size: 10px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}
.mcpm-code {
  margin: 0; padding: 11px 13px; overflow: auto; max-height: 300px;
  background: var(--dsw-alias-bg-layer-3);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm, 6px);
  font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.65;
  color: var(--dsw-alias-label-secondary); white-space: pre;
}
.mcpm-empty {
  padding: 18px 14px; font-size: 12.5px; line-height: 1.6;
  color: var(--dsw-alias-label-tertiary);
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md, 8px);
}
.mcpm-warn {
  margin: 12px 0 0; padding: 9px 12px; font-size: 12px; line-height: 1.6;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-label);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent);
}

/* buttons */
.mcpm-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px;
  border-radius: var(--dsw-radius-sm, 6px); font: inherit; font-size: 12.5px; font-weight: 500;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; white-space: nowrap;
}
.mcpm-btn:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.mcpm-btn:disabled { opacity: .5; cursor: not-allowed; }
.mcpm-btn.primary {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
  border-color: transparent;
}
.mcpm-btn.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 88%, var(--dsw-alias-bg-layer-1));
}
.mcpm-btn.danger { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.mcpm-btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
}
.mcpm-btn.link { border-color: transparent; color: var(--dsw-alias-state-business-primary); text-decoration: underline; text-underline-offset: 3px; padding: 0 4px; height: auto; }

/* dialog */
.mcpm-overlay {
  position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 20px;
  background: rgba(0,0,0,.62);
}
.mcpm-dialog {
  display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto;
  width: min(760px, 100%); max-height: min(88vh, 880px);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg, 10px);
  box-shadow: var(--dsw-shadow-lv2);
  overflow: hidden;
}
.mcpm-dialog.small { width: min(430px, 100%); grid-template-rows: auto minmax(0,1fr) auto; }
.mcpm-dlg-head { display: flex; align-items: flex-start; gap: 14px; padding: 18px 20px 14px; }
.mcpm-eyebrow { margin: 0 0 5px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.mcpm-dlg-head h2 { margin: 0; font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
.mcpm-tabs { display: flex; gap: 4px; padding: 0 20px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.mcpm-tab {
  padding: 9px 10px; margin-bottom: -1px; font: inherit; font-size: 12.5px;
  background: none; border: 0; border-bottom: 2px solid transparent;
  color: var(--dsw-alias-label-tertiary); cursor: pointer;
}
.mcpm-tab[aria-selected="true"] {
  color: var(--dsw-alias-label-primary);
  border-bottom-color: var(--dsw-alias-state-business-primary);
}
.mcpm-dlg-body { padding: 16px 20px; overflow-y: auto; min-height: 0; }
.mcpm-dlg-foot {
  display: flex; align-items: center; gap: 12px; padding: 12px 20px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); flex-wrap: wrap;
}
.mcpm-foot-status { margin: 0; flex: 1 1 200px; font-size: 12px; color: var(--dsw-alias-label-tertiary); line-height: 1.5; }
.mcpm-foot-status.err { color: var(--dsw-alias-state-error-primary); }
.mcpm-foot-actions { display: flex; gap: 8px; margin-left: auto; }

.mcpm-field { display: grid; gap: 5px; margin-bottom: 13px; min-width: 0; }
.mcpm-field label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.mcpm-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.mcpm-field input, .mcpm-field select, .mcpm-field textarea {
  width: 100%; padding: 8px 10px; font: inherit; font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm, 6px);
}
.mcpm-field input, .mcpm-field select { height: 34px; padding-top: 0; padding-bottom: 0; }
.mcpm-field textarea { font-family: ui-monospace, monospace; line-height: 1.6; resize: vertical; min-height: 70px; }
.mcpm-field input:focus, .mcpm-field select:focus, .mcpm-field textarea:focus {
  outline: none; border-color: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
}
.mcpm-field input[aria-invalid="true"], .mcpm-field textarea[aria-invalid="true"] {
  border-color: var(--dsw-alias-state-error-primary);
}
.mcpm-field .mono { font-family: ui-monospace, monospace; }
.mcpm-err { margin: 0; font-size: 11.5px; color: var(--dsw-alias-state-error-primary); }
.mcpm-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.mcpm-switch { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.mcpm-switch input { width: 15px; height: 15px; accent-color: var(--dsw-alias-state-business-primary); }

.mcpm-preview { margin-top: 10px; }
.mcpm-preview-idle { margin: 0; padding: 12px; font-size: 12px; color: var(--dsw-alias-label-tertiary); border: 1px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); }
.mcpm-preview-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.mcpm-preview-list { display: grid; gap: 1px; background: var(--dsw-alias-border-l2); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); overflow: hidden; }
.mcpm-preview-item { display: flex; align-items: center; gap: 9px; padding: 9px 11px; background: var(--dsw-alias-bg-layer-1); min-width: 0; }
.mcpm-preview-main { display: grid; gap: 2px; flex: 1; min-width: 0; }
.mcpm-preview-name { font-size: 12.5px; font-weight: 600; font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
.mcpm-preview-meta { font-size: 11px; font-family: ui-monospace, monospace; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcpm-tag { flex: none; font-size: 10.5px; padding: 2px 6px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); }
.mcpm-tag.bad { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.mcpm-inline-error {
  display: flex; gap: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.6;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  overflow-wrap: anywhere;
}
.mcpm-confirm-body { padding: 0 20px 16px; font-size: 13px; line-height: 1.7; color: var(--dsw-alias-label-tertiary); }

/* preflight findings: one row per reason, coloured by severity */
.mcpm-findings {
  margin: 10px 0 0; padding: 0; list-style: none; display: grid; gap: 6px;
}
.mcpm-finding {
  display: flex; gap: 8px; align-items: baseline;
  padding: 7px 10px; border-radius: var(--dsw-radius-sm, 6px);
  font-size: 12px; line-height: 1.55; overflow-wrap: anywhere;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
.mcpm-finding-level {
  flex: none; font-size: 10px; font-weight: 600; letter-spacing: .06em;
  text-transform: uppercase;
}
.mcpm-finding.error {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.mcpm-finding.warning {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);
  color: var(--dsw-alias-state-warn-label);
}
.mcpm-finding.info { color: var(--dsw-alias-label-tertiary); }

/* toast
   Sits at 35% of the viewport height rather than the bottom edge: a result
   message below the fold competes with the user's own status bar and is easy
   to miss, while the upper-middle area is already where the eye lands after an
   action. The layer is fixed, so it stays put while either pane scrolls. */
.mcpm-toast-root {
  position: fixed; left: 50%; top: 35%; transform: translate(-50%, -50%);
  z-index: 90; pointer-events: none; display: flex; flex-direction: column; gap: 7px; align-items: center;
}
.mcpm-toast {
  padding: 10px 16px; border-radius: var(--dsw-radius-md, 8px); font-size: 13px;
  font-weight: 500; line-height: 1.5;
  background: #fff;
  color: var(--dsw-static-green-500);
  border: 1px solid color-mix(in srgb, var(--dsw-static-green-500) 45%, transparent);
  box-shadow: 0 6px 24px rgba(0, 0, 0, .28);
  max-width: min(90vw, 520px);
  animation: mcpm-toast-in .18s ease-out;
}
/* A removal reads as a removal: same white card, the other signal colour. */
.mcpm-toast.danger {
  color: var(--dsw-static-red-500);
  border-color: color-mix(in srgb, var(--dsw-static-red-500) 45%, transparent);
}
@keyframes mcpm-toast-in {
  from { opacity: 0; transform: translateY(6px) scale(.98); }
  to { opacity: 1; transform: none; }
}

@media (max-width: 820px) {
  .mcpm-body { grid-template-columns: minmax(0, 1fr); }
  .mcpm-rail { border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); max-height: 42vh; }
  .mcpm-detail { padding: 16px 16px 40px; }
  .mcpm-row2 { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .mcpm-chev { transition: none; }
}
`

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * Fill a `{name}` template.
     * @param {string} template
     * @param {Record<string, string | number>} values
     * @returns {string}
     */
    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.hasOwn(values, key) ? String(values[key]) : match,
      )
    }

    /**
     * Read one field out of a JSON response, tolerating a non-JSON body.
     * @param {Response} response
     * @returns {Promise<any>}
     */
    async function readBody(response) {
      let text = ''
      try {
        text = await response.text()
      } catch {
        return { ok: false, error: `HTTP ${response.status}` }
      }
      try {
        return JSON.parse(text)
      } catch {
        return { ok: false, error: text.slice(0, 400) || `HTTP ${response.status}` }
      }
    }

    /**
     * Resolve a Host route against the page's own base.
     *
     * `document.baseURI` keeps whatever mount prefix this deployment uses (a
     * reverse proxy or a subdirectory both work); the fallback covers a
     * non-DOM context. The Host serves the client from `/plugins/...`, so a
     * bare relative path would resolve against the wrong segment.
     * @param {string} suffix
     * @returns {string}
     */
    function apiUrl(suffix) {
      try {
        const url = new URL(`${API}/${suffix}`, document.baseURI)
        // `.pathname` alone discards the query string, so a route that carries
        // its parameter there (`server?id=…`) would arrive without it and be
        // answered with a 404 for a missing id.
        return `${url.pathname}${url.search}`
      } catch {
        return `${API}/${suffix}`
      }
    }

    /**
     * Call one host route.
     *
     * `credentials: 'same-origin'` is what carries the Host's signed session
     * cookie; without it every request would be answered with 401.
     * @param {string} suffix
     * @param {object} [options]
     * @returns {Promise<any>}
     */
    async function api(suffix, options) {
      const init = {
        method: options?.method ?? 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      }
      if (options?.body !== undefined) {
        init.headers = { ...init.headers, 'content-type': 'application/json' }
        init.body = JSON.stringify(options.body)
      }
      const response = await fetch(apiUrl(suffix), init)
      const payload = await readBody(response)
      if (payload.ok !== true) {
        const reason = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
        const error = new Error(reason)
        // Keep the structured findings so the dialog can offer "save anyway"
        // with the exact reasons, instead of a bare sentence.
        if (Array.isArray(payload.findings)) error.findings = payload.findings
        if (payload.canIgnore === true) error.canIgnore = true
        throw error
      }
      return payload
    }

    /**
     * Parse `KEY=VALUE` lines, ignoring blanks and comments.
     * @param {string} text
     * @returns {{ pairs: Record<string,string>, error: string }}
     */
    function parsePairs(text) {
      const pairs = {}
      const lines = String(text ?? '').split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim()
        if (line === '' || line.startsWith('#')) continue
        const at = line.indexOf('=')
        if (at < 1) return { pairs, error: `L${index + 1}: KEY=VALUE` }
        pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim()
      }
      return { pairs, error: '' }
    }

    /**
     * Render `Record<string,string>` as `KEY=VALUE` lines.
     * @param {Record<string,string>} map
     * @returns {string}
     */
    function pairsToText(map) {
      return Object.entries(map ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    }

    /**
     * Build the request draft from the form state.
     * @param {object} form
     * @returns {object}
     */
    function draftFromForm(form) {
      const stdio = form.transport === 'stdio'
      return {
        serverName: String(form.serverName ?? '').trim(),
        transport: form.transport,
        command: stdio ? String(form.command ?? '').trim() : '',
        args: stdio
          ? String(form.args ?? '')
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
          : [],
        env: stdio ? parsePairs(form.env).pairs : {},
        cwd: stdio ? String(form.cwd ?? '').trim() : '',
        url: stdio ? '' : String(form.url ?? '').trim(),
        headers: stdio ? {} : parsePairs(form.headers).pairs,
        // An empty box means "leave the field alone": the client's own default
        // applies and no new key is written into the row.
        ...(String(form.timeout ?? '').trim() !== '' && Number(form.timeout) > 0
          ? { toolCallTimeoutMs: Number(form.timeout) }
          : {}),
        failOnStartupError: form.failOnStartupError === true,
      }
    }

    /**
     * Build the editable form state from a server draft.
     * @param {object} draft
     * @returns {object}
     */
    /**
     * Render a draft as editable dsh shorthand when the host preview is missing.
     *
     * The host normally supplies `preview.dsh`; this is the fallback so the edit
     * buffer is never empty for a server that loaded successfully. It only knows
     * the fields the form knows, which is why the host's preview is preferred.
     *
     * @param {Record<string, any>} draft
     * @returns {string}
     */
    function toDraftText(draft) {
      const base = draft ?? {}
      const show = (value) => {
        if (value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string') {
          return `!!js ${value.__jsExpr}`
        }
        return String(value ?? '')
      }
      const lines = [`@mcp ${String(base.serverName ?? '')}`, `transport: ${base.transport ?? 'stdio'}`]
      if (base.transport === 'streamable-http') {
        lines.push(`url: ${show(base.url)}`)
        const headers = Object.entries(base.headers ?? {})
        if (headers.length > 0) lines.push(`headers: ${headers.map(([k, v]) => `${k}=${show(v)}`).join(', ')}`)
      } else {
        lines.push(`command: ${show(base.command)}`)
        const args = Array.isArray(base.args) ? base.args : []
        if (args.length > 0) lines.push(`args: ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')}`)
        const env = Object.entries(base.env ?? {})
        if (env.length > 0) lines.push(`env: ${env.map(([k, v]) => `${k}=${show(v)}`).join(', ')}`)
        if (base.cwd !== undefined && base.cwd !== '') lines.push(`cwd: ${show(base.cwd)}`)
      }
      if (typeof base.toolCallTimeoutMs === 'number') lines.push(`toolCallTimeoutMs: ${base.toolCallTimeoutMs}`)
      if (base.failOnStartupError === true) lines.push('failOnStartupError: true')
      return lines.join('\n')
    }

    function formFromDraft(draft) {
      const base = draft ?? {}
      return {
        serverName: String(base.serverName ?? ''),
        transport: base.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
        command: String(base.command ?? ''),
        args: Array.isArray(base.args) ? base.args.join('\n') : '',
        env: pairsToText(base.env),
        cwd: String(base.cwd ?? ''),
        url: String(base.url ?? ''),
        headers: pairsToText(base.headers),
        timeout: typeof base.toolCallTimeoutMs === 'number' ? String(base.toolCallTimeoutMs) : '',
        failOnStartupError: base.failOnStartupError === true,
      }
    }

    /**
     * Validate a form, returning field-keyed messages.
     * @param {object} form
     * @param {(key: string) => string} t
     * @returns {Record<string, string>}
     */
    function validateForm(form, t) {
      const errors = {}
      const serverName = String(form.serverName ?? '').trim()
      if (serverName === '') errors.serverName = t('errName')
      else if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) errors.serverName = t('errNamePattern')

      if (form.transport === 'stdio') {
        if (String(form.command ?? '').trim() === '') errors.command = t('errCommand')
        if (parsePairs(form.env).error !== '') errors.env = t('errEnv')
      } else {
        const url = String(form.url ?? '').trim()
        if (url === '') errors.url = t('errUrl')
        else {
          try {
            const parsed = new URL(url)
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') errors.url = t('errUrlInvalid')
          } catch {
            errors.url = t('errUrlInvalid')
          }
        }
        if (parsePairs(form.headers).error !== '') errors.headers = t('errHeaders')
      }
      return errors
    }

    /**
     * Copy text to the clipboard, with a legacy fallback.
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // fall through to the textarea path
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    // ── icons ───────────────────────────────────────────────────────────────

    /**
     * @param {string} path
     * @param {number} [size]
     * @returns {object}
     */
    function icon(path, size) {
      return h(
        'svg',
        {
          width: size ?? 14,
          height: size ?? 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { flex: 'none' },
        },
        h('path', { d: path }),
      )
    }

    const ICON = {
      refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
      plus: 'M12 5v14M5 12h14',
      chevron: 'm6 9 6 6 6-6',
      close: 'M6 6l12 12M18 6 6 18',
      copy: 'M9 9h11v11H9zM5 15V5a2 2 0 0 1 2-2h9',
      pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
      trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
      power: 'M12 3v9M6.6 6.6a8 8 0 1 0 10.8 0',
      alert: 'M12 4 2.8 20h18.4L12 4zM12 10v4.5M12 17.6v.1',
      arrowLeft: 'M19 12H5m7 7-7-7 7-7',
    }

    // ── small components ────────────────────────────────────────────────────

    /**
     * The one-line explanation under the metadata grid.
     *
     * A connected server's detail is just "registered N tools", which the grid
     * already shows as a number — repeating it as a sentence adds nothing. The
     * line earns its place when it says something the grid cannot: why a server
     * failed, that it is inactive, or that it connected without declaring any
     * tools.
     *
     * @param {{ state: string, detail: string }} server
     * @returns {string}
     */
    function serverDetailText(server) {
      const detail = typeof server.detail === 'string' ? server.detail : ''
      if (server.state !== 'connected') return detail
      // Drop the plain tool count; keep anything else the host had to say.
      if (/^已注册 \d+ 个工具$/.test(detail)) return ''
      return detail
    }

    /**
     * @param {{ state: string, t: (key: string) => string }} props
     * @returns {object}
     */
    function StatePill(props) {
      const { state, t } = props
      const label =
        state === 'connected'
          ? t('stateConnected')
          : state === 'error'
            ? t('stateError')
            : state === 'inactive'
              ? t('stateInactive')
              : t('stateUnknown')
      const cls = state === 'connected' ? 'connected' : state === 'error' ? 'error' : state === 'unknown' ? 'unknown' : ''
      return h(
        'span',
        { className: `mcpm-pill ${cls}` },
        h('span', { className: `mcpm-dot ${cls}` }),
        label,
      )
    }

    /**
     * @param {{ label: string, value: string, mono?: boolean }} props
     * @returns {object}
     */
    function MetaCell(props) {
      return h(
        'div',
        { className: 'mcpm-meta-cell' },
        h('span', { className: 'mcpm-meta-label' }, props.label),
        h(
          'span',
          { className: `mcpm-meta-value${props.mono === true ? ' mono' : ''}`, title: props.value },
          props.value,
        ),
      )
    }

    /**
     * One expandable tool row.
     * @param {{ tool: object, t: (key: string) => string }} props
     * @returns {object}
     */
    function ToolRow(props) {
      const { tool, t } = props
      const [open, setOpen] = useState(false)
      const schema = useMemo(() => {
        try {
          return JSON.stringify(tool.schema ?? {}, null, 2)
        } catch {
          return ''
        }
      }, [tool.schema])

      return h(
        'div',
        { className: 'mcpm-tool' },
        h(
          'button',
          {
            type: 'button',
            className: 'mcpm-tool-head',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpen((value) => !value),
          },
          h(
            'span',
            { className: 'mcpm-tool-id' },
            h('span', { className: 'mcpm-tool-name' }, tool.rawName),
            h('span', { className: 'mcpm-tool-desc', title: tool.description }, tool.description || '—'),
          ),
          h('span', { className: 'mcpm-chev' }, icon(ICON.chevron, 14)),
        ),
        open
          ? h(
              'div',
              { className: 'mcpm-tool-body' },
              tool.description
                ? h('p', { className: 'mcpm-tool-body-desc' }, tool.description)
                : null,
              h('p', { className: 'mcpm-schema-label' }, t('schema')),
              h('pre', { className: 'mcpm-code' }, h('code', null, schema)),
            )
          : null,
      )
    }

    /**
     * The shared form used by both "add manually" and "edit".
     * @param {{ form: object, errors: Record<string,string>, onChange: Function, t: Function, disabled: boolean }} props
     * @returns {object}
     */
    function ServerForm(props) {
      const { form, errors, onChange, t, disabled } = props
      const stdio = form.transport === 'stdio'

      /**
       * @param {string} key
       * @returns {Function}
       */
      const field = (key) => (event) => onChange(key, event.target.value)

      /**
       * @param {string} key
       * @param {string} id
       * @returns {object}
       */
      const label = (key, id) =>
        h(
          'label',
          { htmlFor: id },
          t(key),
          key === 'fName' ? h('span', { className: 'mcpm-hint' }, ` · ${t('required')}`) : null,
        )

      /**
       * @param {string} key
       * @param {string} id
       * @returns {object | null}
       */
      const error = (key, id) =>
        errors[key] ? h('p', { className: 'mcpm-err', id: `${id}-err` }, errors[key]) : null

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'mcpm-row2' },
          h(
            'div',
            { className: 'mcpm-field' },
            label('fName', 'f-name'),
            h('input', {
              id: 'f-name',
              className: 'mono',
              value: form.serverName,
              onChange: field('serverName'),
              placeholder: 'dbx',
              spellCheck: false,
              autoComplete: 'off',
              disabled,
              'aria-invalid': errors.serverName ? 'true' : 'false',
            }),
            h('span', { className: 'mcpm-hint' }, t('fNameHint')),
            error('serverName', 'f-name'),
          ),
          h(
            'div',
            { className: 'mcpm-field' },
            label('fTransport', 'f-transport'),
            h(
              'select',
              {
                id: 'f-transport',
                value: form.transport,
                onChange: field('transport'),
                disabled,
              },
              h('option', { value: 'stdio' }, 'stdio · local process'),
              h('option', { value: 'streamable-http' }, 'streamable-http · remote'),
            ),
          ),
        ),

        stdio
          ? h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'mcpm-field' },
                label('fCommand', 'f-command'),
                h('input', {
                  id: 'f-command',
                  className: 'mono',
                  value: form.command,
                  onChange: field('command'),
                  placeholder: 'C:/Users/me/.dbx/bin/dbx-mcp.exe',
                  spellCheck: false,
                  autoComplete: 'off',
                  disabled,
                  'aria-invalid': errors.command ? 'true' : 'false',
                }),
                error('command', 'f-command'),
              ),
              h(
                'div',
                { className: 'mcpm-row2' },
                h(
                  'div',
                  { className: 'mcpm-field' },
                  label('fArgs', 'f-args'),
                  h('span', { className: 'mcpm-hint' }, t('fArgsHint')),
                  h('textarea', {
                    id: 'f-args',
                    className: 'mono',
                    value: form.args,
                    onChange: field('args'),
                    rows: 3,
                    spellCheck: false,
                    placeholder: '-y\n@scope/server',
                    disabled,
                  }),
                ),
                h(
                  'div',
                  { className: 'mcpm-field' },
                  label('fEnv', 'f-env'),
                  h('span', { className: 'mcpm-hint' }, t('fEnvHint')),
                  h('textarea', {
                    id: 'f-env',
                    className: 'mono',
                    value: form.env,
                    onChange: field('env'),
                    rows: 3,
                    spellCheck: false,
                    placeholder: 'LOG_LEVEL=info',
                    disabled,
                    'aria-invalid': errors.env ? 'true' : 'false',
                  }),
                  error('env', 'f-env'),
                ),
              ),
              h(
                'div',
                { className: 'mcpm-field' },
                label('fCwd', 'f-cwd'),
                h('input', {
                  id: 'f-cwd',
                  className: 'mono',
                  value: form.cwd,
                  onChange: field('cwd'),
                  placeholder: '',
                  spellCheck: false,
                  disabled,
                }),
                h('span', { className: 'mcpm-hint' }, t('fCwdHint')),
              ),
            )
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'mcpm-field' },
                label('fUrl', 'f-url'),
                h('input', {
                  id: 'f-url',
                  className: 'mono',
                  value: form.url,
                  onChange: field('url'),
                  placeholder: 'https://mcp.example.com/mcp',
                  spellCheck: false,
                  autoComplete: 'off',
                  disabled,
                  'aria-invalid': errors.url ? 'true' : 'false',
                }),
                error('url', 'f-url'),
              ),
              h(
                'div',
                { className: 'mcpm-field' },
                label('fHeaders', 'f-headers'),
                h('span', { className: 'mcpm-hint' }, t('fHeadersHint')),
                h('textarea', {
                  id: 'f-headers',
                  className: 'mono',
                  value: form.headers,
                  onChange: field('headers'),
                  rows: 3,
                  spellCheck: false,
                  placeholder: 'Authorization=Bearer TOKEN',
                  disabled,
                  'aria-invalid': errors.headers ? 'true' : 'false',
                }),
                error('headers', 'f-headers'),
              ),
            ),

        h(
          'div',
          { className: 'mcpm-row2' },
          h(
            'div',
            { className: 'mcpm-field' },
            label('fTimeout', 'f-timeout'),
            h('input', {
              id: 'f-timeout',
              value: form.timeout,
              onChange: field('timeout'),
              inputMode: 'numeric',
              disabled,
            }),
          ),
          h(
            'div',
            { className: 'mcpm-field' },
            h('span', { className: 'mcpm-hint' }, '\u00a0'),
            h(
              'label',
              { className: 'mcpm-switch' },
              h('input', {
                type: 'checkbox',
                checked: form.failOnStartupError,
                onChange: (event) => onChange('failOnStartupError', event.target.checked),
                disabled,
              }),
              t('fFailStartup'),
            ),
          ),
        ),
      )
    }

    // ── the page ────────────────────────────────────────────────────────────

    /**
     * @param {{ t: (key: string, values?: object) => string }} props
     * @returns {object}
     */
    function ManagerPage(props) {
      const { t } = props

      /** Full inventory from the host. */
      const [snapshot, setSnapshot] = useState(null)
      const [loading, setLoading] = useState(true)
      const [refreshing, setRefreshing] = useState(false)
      const [loadError, setLoadError] = useState('')
      const [lastRead, setLastRead] = useState(null)

      const [selectedId, setSelectedId] = useState(null)
      const [query, setQuery] = useState('')

      /** `{ kind: 'add' | 'edit' | 'remove', ... }` or null. */
      const [dialog, setDialog] = useState(null)
      /** `{ message: string, tone: 'ok' | 'danger' } | null`. */
      const [toast, setToast] = useState(null)

      const toastTimer = useRef(null)

      /**
       * Show a result message.
       *
       * `tone` only picks the signal colour: white card with green text for a
       * completed change, red for a removal. An error always uses the red tone,
       * because it is the one case the user must not mistake for success.
       *
       * @param {string} message
       * @param {'ok' | 'danger'} [tone]
       */
      const showToast = useCallback((message, tone) => {
        setToast({ message, tone: tone === 'danger' ? 'danger' : 'ok' })
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 3200)
      }, [])

      useEffect(
        () => () => {
          if (toastTimer.current !== null) clearTimeout(toastTimer.current)
        },
        [],
      )

      /**
       * Read the inventory.
       * @param {boolean} [manual]
       */
      const load = useCallback(
        async (manual) => {
          if (manual === true) setRefreshing(true)
          try {
            const payload = await api('servers')
            setSnapshot(payload)
            setLoadError('')
            setLastRead(Date.now())
            setSelectedId((current) => {
              if (current !== null && payload.servers.some((server) => server.id === current)) {
                return current
              }
              return payload.servers.length > 0 ? payload.servers[0].id : null
            })
          } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error))
          } finally {
            setLoading(false)
            if (manual === true) setRefreshing(false)
          }
        },
        [],
      )

      /**
       * Latest snapshot, readable from callbacks without re-subscribing.
       * Declared before the callbacks that read it.
       */
      const snapshotRef = useRef(null)
      useEffect(() => {
        snapshotRef.current = snapshot
      }, [snapshot])

      /**
       * Re-read the inventory until the write becomes visible.
       *
       * A configuration write is applied by HMR re-composing the profile, not
       * by the HTTP response. The first read after a successful write therefore
       * still returns the previous inventory; reading once made the list look
       * as if nothing had happened. This settles on the new state by re-reading
       * a bounded number of times and stopping as soon as it differs.
       *
       * @param {object | null} before snapshot captured before the write
       */
      /**
       * A stable description of everything the page displays about one server.
       *
       * The configuration is included because an edit may change nothing else:
       * changing only `toolCallTimeoutMs` leaves the id, name, transport, state
       * and tool count identical, so a signature built from those alone could
       * never notice the write had landed.
       */
      const inventorySignature = (payload) => {
        if (payload === null || payload === undefined) return ''
        const servers = Array.isArray(payload.servers) ? payload.servers : []
        return servers
          .map((server) => {
            const config = server.config ?? {}
            return [
              server.id,
              server.serverName,
              server.transport,
              server.state,
              (server.tools ?? []).length,
              JSON.stringify(config),
            ].join(':')
          })
          .sort()
          .join('|')
      }

      const refreshAfterWrite = useCallback(async (before) => {
        const start = inventorySignature(before ?? snapshotRef.current)

        for (let attempt = 0; attempt < 8; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 700))
          try {
            const payload = await api('servers')
            const changed = inventorySignature(payload) !== start
            if (changed || attempt === 7) {
              setSnapshot(payload)
              setLoadError('')
              setLastRead(Date.now())
              setSelectedId((current) => {
                if (current !== null && payload.servers.some((server) => server.id === current)) {
                  return current
                }
                return payload.servers.length > 0 ? payload.servers[0].id : null
              })
              if (changed) return
            }
          } catch {
            // A failed re-read keeps the last good inventory; the poll loop
            // will try again on its own schedule.
          }
        }
      }, [])

      useEffect(() => {
        let alive = true
        void load(false)
        const timer = setInterval(() => {
          if (!alive) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void load(false)
        }, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load])

      const servers = snapshot?.servers ?? []

      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (needle === '') return servers
        return servers.filter((server) => {
          if (server.serverName.toLowerCase().includes(needle)) return true
          if (server.transport.toLowerCase().includes(needle)) return true
          return server.tools.some(
            (tool) =>
              tool.rawName.toLowerCase().includes(needle) ||
              (tool.description ?? '').toLowerCase().includes(needle),
          )
        })
      }, [servers, query])

      const selected = useMemo(
        () => servers.find((server) => server.id === selectedId) ?? servers[0] ?? null,
        [servers, selectedId],
      )

      /**
       * Remove one server after the confirm dialog.
       * @param {{ id: string, serverName: string }} server
       */
      const removeServer = useCallback(
        async (server) => {
          try {
            await api('remove', { method: 'POST', body: { id: server.id } })
            setDialog(null)
            showToast(t('removedToast', { name: server.serverName }), 'danger')
            await refreshAfterWrite()
          } catch (error) {
            setDialog((current) =>
              current === null
                ? null
                : { ...current, error: error instanceof Error ? error.message : String(error) },
            )
          }
        },
        [refreshAfterWrite, showToast, t],
      )

      /**
       * Enable or disable one server.
       * @param {{ id: string, serverName: string, disabled: boolean }} server
       */
      const toggleServer = useCallback(
        async (server) => {
          try {
            await api('toggle', {
              method: 'POST',
              body: { id: server.id, disabled: !server.disabled },
            })
            showToast(
              server.disabled
                ? t('toggledOnToast', { name: server.serverName })
                : t('toggledOffToast', { name: server.serverName }),
            )
            await refreshAfterWrite()
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), 'danger')
          }
        },
        [refreshAfterWrite, showToast, t],
      )

      // ── rail ──────────────────────────────────────────────────────────────

      const rail = h(
        'aside',
        { className: 'mcpm-rail' },
        h(
          'div',
          { className: 'mcpm-search' },
          h('input', {
            type: 'search',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            placeholder: t('searchPlaceholder'),
            'aria-label': t('searchPlaceholder'),
            spellCheck: false,
            autoComplete: 'off',
          }),
        ),
        h(
          'div',
          { className: 'mcpm-list' },
          visible.length === 0
            ? h(
                'div',
                { className: 'mcpm-empty-rail' },
                servers.length === 0 ? t('emptyTitle') : fmt(t('noMatch'), { q: query.trim() }),
              )
            : visible.map((server) =>
                h(
                  'button',
                  {
                    key: server.id,
                    type: 'button',
                    className: 'mcpm-item',
                    'aria-current': server.id === selected?.id ? 'true' : 'false',
                    onClick: () => setSelectedId(server.id),
                  },
                  h('span', { className: `mcpm-dot ${server.state}` }),
                  h(
                    'span',
                    { className: 'mcpm-item-main' },
                    h('span', { className: 'mcpm-item-name' }, server.serverName),
                    h(
                      'span',
                      { className: 'mcpm-item-sub' },
                      `${server.transport} · ${server.tools.length} ${t('toolsUnit')}`,
                    ),
                  ),
                ),
              ),
        ),
      )

      // ── detail ────────────────────────────────────────────────────────────

      /**
       * @param {object} server
       * @returns {object}
       */
      const detailFor = (server) => {
        const toolsEmpty =
          server.state === 'connected'
            ? t('toolsEmptyConnected')
            : server.state === 'error'
              ? t('toolsEmptyError')
              : server.state === 'inactive'
                ? t('toolsEmptyInactive')
                : t('toolsEmptyUnknown')

        return h(
          'div',
          { className: 'mcpm-detail-inner' },
          h(
            'h1',
            { className: 'mcpm-h1' },
            h('span', { style: { overflowWrap: 'anywhere' } }, server.serverName),
            h(StatePill, { state: server.state, t }),
          ),
          h('p', { className: 'mcpm-endpoint' }, server.endpoint || '—'),

          h(
            'div',
            { className: 'mcpm-detail-actions' },
            h(
              'button',
              { type: 'button', className: 'mcpm-btn primary', onClick: () => setDialog({ kind: 'edit', id: server.id }) },
              icon(ICON.pencil),
              t('edit'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mcpm-btn',
                onClick: () => void toggleServer(server),
              },
              icon(ICON.power),
              server.disabled ? t('enable') : t('disable'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mcpm-btn',
                onClick: () => void load(true),
                disabled: refreshing,
              },
              icon(ICON.refresh),
              refreshing ? t('refreshing') : t('refresh'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mcpm-btn danger',
                onClick: () => setDialog({ kind: 'remove', id: server.id, server }),
              },
              icon(ICON.trash),
              t('remove'),
            ),
          ),

          h(
            'div',
            { className: 'mcpm-meta' },
            h(MetaCell, { label: t('metaTransport'), value: server.transport, mono: true }),
            h(MetaCell, { label: t('metaTools'), value: String(server.tools.length), mono: true }),
            h(MetaCell, { label: t('metaPrefix'), value: server.toolPrefix, mono: true }),
            h(MetaCell, { label: t('metaRowId'), value: server.id, mono: true }),
          ),

          h('p', { className: 'mcpm-endpoint', style: { marginTop: '10px' } }, serverDetailText(server)),

          server.warnings.length > 0
            ? h(
                'div',
                { className: 'mcpm-warn' },
                `${t('warnings')}: ${server.warnings.join('; ')}`,
              )
            : null,

          h(
            'section',
            { className: 'mcpm-section' },
            h(
              'div',
              { className: 'mcpm-section-head' },
              h('h2', null, t('sectionTools')),
              h('span', { className: 'mcpm-count' }, String(server.tools.length)),
            ),
            server.tools.length === 0
              ? h('div', { className: 'mcpm-empty' }, toolsEmpty)
              : h(
                  'div',
                  { className: 'mcpm-tools' },
                  server.tools.map((tool) => h(ToolRow, { key: tool.name, tool, t })),
                ),
          ),
        )
      }

      const detail = h(
        'div',
        { className: 'mcpm-detail' },
        loading
          ? h('div', { className: 'mcpm-empty' }, t('loading'))
          : loadError !== ''
            ? h('div', { className: 'mcpm-inline-error' }, icon(ICON.alert), loadError)
            : servers.length === 0
              ? h(
                  'div',
                  { className: 'mcpm-detail-inner' },
                  h('h1', { className: 'mcpm-h1' }, t('emptyTitle')),
                  h('p', { className: 'mcpm-endpoint' }, t('emptyBody')),
                  h(
                    'div',
                    { className: 'mcpm-detail-actions' },
                    h(
                      'button',
                      { type: 'button', className: 'mcpm-btn primary', onClick: () => setDialog({ kind: 'add' }) },
                      icon(ICON.plus),
                      t('emptyAdd'),
                    ),
                  ),
                )
              : selected !== null
                ? detailFor(selected)
                : null,
      )

      // ── header ────────────────────────────────────────────────────────────

      const counts = snapshot?.counts
      const summary =
        counts === undefined
          ? ''
          : counts.error > 0
            ? fmt(t('summaryIssue'), { c: counts.connected, e: counts.error, t: counts.tools })
            : fmt(t('summary'), { c: counts.connected, t: counts.tools })

      const header = h(
        'div',
        { className: 'mcpm-top' },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('h1', { className: 'mcpm-title' }, t('title')),
          h('p', { className: 'mcpm-lede' }, summary !== '' ? `${summary} · ${t('lede')}` : t('lede')),
        ),
        h(
          'div',
          { className: 'mcpm-top-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'mcpm-btn',
              onClick: () => void load(true),
              disabled: refreshing,
            },
            icon(ICON.refresh),
            refreshing ? t('refreshing') : t('refresh'),
          ),
          h(
            'button',
            { type: 'button', className: 'mcpm-btn primary', onClick: () => setDialog({ kind: 'add' }) },
            icon(ICON.plus),
            t('addServer'),
          ),
        ),
      )

      return h(
        'div',
        { className: 'mcpm' },
        header,
        h('div', { className: 'mcpm-body' }, rail, detail),
        dialog === null
          ? null
          : h(Dialog, {
              dialog,
              snapshot,
              t,
              onClose: () => setDialog(null),
              onDone: (message, tone) => {
                setDialog(null)
                if (typeof message === 'string' && message !== '') showToast(message, tone)
                // A write is applied by HMR re-composing the profile, which
                // takes a moment. Reading once would almost always show the
                // pre-write inventory, so the page settles on the new one by
                // re-reading a few times and stopping as soon as it changes.
                void refreshAfterWrite()
              },
              onError: (message, error) =>
                setDialog((current) =>
                  current === null
                    ? null
                    : {
                        ...current,
                        error: message,
                        // A preflight refusal carries findings and the option
                        // to override it; anything else is a plain failure.
                        findings: Array.isArray(error?.findings) ? error.findings : null,
                        canIgnore: error?.canIgnore === true,
                      },
                ),
              removeServer,
            }),
        toast === null
          ? null
          : h(Toast, { message: toast.message, tone: toast.tone }),
      )
    }

    /**
     * A transient result message.
     *
     * Rendered into a `document.body`-level layer rather than inside the panel:
     * the panel is a scroll container that the host may clip or restack, and a
     * `position: fixed` box inside that subtree is not reliably visible. The
     * layer is created once and removed when its mount unmounts; both it and
     * the message carry this plugin's prefix so host styles cannot reach them.
     *
     * @param {{ message: string | null, tone?: 'ok' | 'danger' }} props
     * @returns {object | null}
     */
    function Toast(props) {
      const { message, tone } = props
      const [layer] = useState(() => {
        if (typeof document === 'undefined' || document.body === null) return null
        const existing = document.querySelector('[data-mcpm-toasts]')
        if (existing !== null) return existing
        const node = document.createElement('div')
        node.setAttribute('data-mcpm-toasts', '')
        node.setAttribute('aria-live', 'polite')
        node.setAttribute('aria-atomic', 'false')
        document.body.appendChild(node)
        return node
      })

      useEffect(() => {
        if (layer === null) return () => {}
        return () => {
          // Clear the message first, then drop the layer if nothing else holds
          // it. Leaving the bubble behind would strand an old toast on screen
          // after the page that owns it unmounts.
          if (layer.isConnected) {
            layer.textContent = ''
            layer.remove()
          }
        }
      }, [layer])

      useEffect(() => {
        if (layer === null) return
        if (message === null || message === undefined || message === '') {
          layer.textContent = ''
          return
        }
        // Rebuilt each time so the entry animation replays for a new message.
        layer.textContent = ''
        const box = document.createElement('div')
        box.className = 'mcpm-toast-root'
        const bubble = document.createElement('div')
        bubble.className = tone === 'danger' ? 'mcpm-toast danger' : 'mcpm-toast'
        bubble.setAttribute('role', tone === 'danger' ? 'alert' : 'status')
        bubble.textContent = String(message)
        box.appendChild(bubble)
        layer.appendChild(box)
      }, [layer, message, tone])

      return null
    }

    // ── dialogs ─────────────────────────────────────────────────────────────

    /**
     * The add / edit / remove dialog set.
     * @param {object} props
     * @returns {object}
     */
    function Dialog(props) {
      const { dialog, t, onClose, onDone, onError } = props
      if (dialog.kind === 'remove') return h(RemoveDialog, { dialog, t, onClose, onDone, onError })
      if (dialog.kind === 'edit') return h(EditDialog, { dialog, t, onClose, onDone, onError })
      return h(AddDialog, { dialog, t, onClose, onDone, onError })
    }

    /**
     * @param {object} props
     * @returns {object}
     */
    function DialogShell(props) {
      const {
        title, eyebrow, tabs, body, status, statusError, submitLabel, submitDisabled,
        submitting, onSubmit, onClose, t, small, canIgnore, onIgnore,
      } = props
      const overlayRef = useRef(null)

      useEffect(() => {
        /**
         * @param {KeyboardEvent} event
         */
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      return h(
        'div',
        {
          className: 'mcpm-overlay',
          ref: overlayRef,
          onMouseDown: (event) => {
            if (event.target === overlayRef.current) onClose()
          },
        },
        h(
          'div',
          { className: `mcpm-dialog${small === true ? ' small' : ''}`, role: 'dialog', 'aria-modal': 'true' },
          h(
            'header',
            { className: 'mcpm-dlg-head' },
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('p', { className: 'mcpm-eyebrow' }, eyebrow),
              h('h2', null, title),
            ),
            h(
              'button',
              { type: 'button', className: 'mcpm-btn', onClick: onClose, 'aria-label': t('cancel') },
              icon(ICON.close),
            ),
          ),
          tabs ?? null,
          h('div', { className: 'mcpm-dlg-body' }, body),
          h(
            'footer',
            { className: 'mcpm-dlg-foot' },
            h('p', { className: `mcpm-foot-status${statusError === true ? ' err' : ''}` }, status),
            h(
              'div',
              { className: 'mcpm-foot-actions' },
              h('button', { type: 'button', className: 'mcpm-btn', onClick: onClose }, t('cancel')),
              // A preflight refusal is advisory: the check cannot see the
              // Harness' own environment, so the user may knowingly override it.
              canIgnore === true
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'mcpm-btn',
                      onClick: onIgnore,
                      disabled: submitting === true,
                      title: t('ignorePreflightHint'),
                    },
                    t('ignorePreflight'),
                  )
                : null,
              submitLabel === null
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'mcpm-btn primary',
                      onClick: onSubmit,
                      disabled: submitDisabled === true || submitting === true,
                    },
                    submitting === true ? t('submitting') : submitLabel,
                  ),
            ),
          ),
        ),
      )
    }

    /**
     * Remove confirmation.
     * @param {object} props
     * @returns {object}
     */
    function RemoveDialog(props) {
      const { dialog, t, onClose, onDone, onError } = props
      const server = dialog.server ?? { id: dialog.id, serverName: dialog.id }
      const [busy, setBusy] = useState(false)

      const submit = async () => {
        setBusy(true)
        try {
          await api('remove', { method: 'POST', body: { id: server.id } })
          onDone(t('removedToast', { name: server.serverName }), 'danger')
        } catch (error) {
          setBusy(false)
          onError(error instanceof Error ? error.message : String(error))
        }
      }

      return h(DialogShell, {
        t,
        small: true,
        eyebrow: t('remove'),
        title: fmt(t('removeTitle'), { name: server.serverName }),
        tabs: null,
        body: h(
          'div',
          { className: 'mcpm-confirm-body' },
          h('p', null, t('removeBody')),
          dialog.error ? h('div', { className: 'mcpm-inline-error' }, icon(ICON.alert), dialog.error) : null,
        ),
        status: '',
        statusError: false,
        submitLabel: t('removeConfirm'),
        submitDisabled: false,
        submitting: busy,
        onSubmit: () => void submit(),
        onClose,
      })
    }

    /**
     * The individual reasons behind a preflight refusal.
     *
     * A single flattened sentence hides which field is wrong; this lists each
     * finding with its level so the user can fix them one at a time.
     *
     * @param {{ findings: any[] | null | undefined, t: (key: string) => string }} props
     * @returns {object | null}
     */
    function FindingsList(props) {
      const { findings, t } = props
      if (!Array.isArray(findings) || findings.length === 0) return null
      return h(
        'ul',
        { className: 'mcpm-findings' },
        findings.map((finding, index) =>
          h(
            'li',
            { key: `${finding.code ?? 'f'}-${index}`, className: `mcpm-finding ${finding.level ?? 'info'}` },
            h('span', { className: 'mcpm-finding-level' }, t(`level_${finding.level ?? 'info'}`)),
            h('span', null, finding.message),
          ),
        ),
      )
    }

    /**
     * Edit one existing server.
     *
     * Two ways in, mirroring the add dialog: paste or edit the configuration
     * text (either dialect, prefilled with what the profile currently holds), or
     * fill the form. Both end in the same `/update` call, so both get the same
     * parse, normalization and preflight.
     *
     * @param {object} props
     * @returns {object}
     */
    function EditDialog(props) {
      const { dialog, t, onClose, onDone, onError } = props
      const [form, setForm] = useState(null)
      const [errors, setErrors] = useState({})
      const [busy, setBusy] = useState(false)
      const [tab, setTab] = useState('config')

      /** The editable configuration text, prefilled from the profile. */
      const [text, setText] = useState('')
      /** Which dialect the buffer is in; switches the renderer on tab entry. */
      const [dialect, setDialect] = useState('dsh')
      /** Live parse result for the text buffer. */
      const [parsed, setParsed] = useState({ dialect: '', items: [], warnings: [] })
      const [parseError, setParseError] = useState('')
      /** Values loaded from the host, kept so a tab switch can re-render. */
      const [loaded, setLoaded] = useState(null)

      // The caller passes an inline `onError`, so its identity changes on every
      // render of the parent. Keeping it in the dependency list would re-run
      // this effect on each of those renders, discard the in-flight response,
      // and leave the dialog on "reading…" forever. The id is the only real
      // input; the callback is read through a ref.
      const errorRef = useRef(onError)
      useEffect(() => {
        errorRef.current = onError
      }, [onError])

      useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const payload = await api(`server?id=${encodeURIComponent(dialog.id)}`)
            if (!alive) return
            setForm(formFromDraft(payload.draft))
            setLoaded(payload)
            // Prefill with the configuration the profile actually holds, in the
            // dialect that renders most faithfully for this server.
            setText(payload.preview?.dsh ?? toDraftText(payload.draft))
          } catch (error) {
            if (alive) errorRef.current(error instanceof Error ? error.message : String(error))
          }
        })()
        return () => {
          alive = false
        }
      }, [dialog.id])

      // Re-render the buffer when the user switches dialect, unless they have
      // typed something — an in-progress edit is never overwritten.
      const switchDialect = (next) => {
        if (next === dialect) return
        setDialect(next)
        if (loaded === null) return
        setText(next === 'json' ? (loaded.preview?.json ?? '') : (loaded.preview?.dsh ?? ''))
        setParsed({ dialect: '', items: [], warnings: [] })
        setParseError('')
      }

      if (form === null) {
        return h(DialogShell, {
          t,
          eyebrow: t('editEyebrow'),
          title: t('edit'),
          tabs: null,
          body: h('div', { className: 'mcpm-empty' }, t('loading')),
          status: '',
          submitLabel: null,
          onClose,
        })
      }

      /**
       * Parse the text buffer after the user stops typing.
       *
       * The same route the add dialog uses, so the preview, the warnings and the
       * normalization are identical in both places.
       */
      const parseText = useCallback((value) => {
        if (value.trim() === '') {
          setParsed({ dialect: '', items: [], warnings: [] })
          setParseError('')
          return () => {}
        }
        const timer = setTimeout(() => {
          void (async () => {
            try {
              const payload = await api('parse', { method: 'POST', body: { text: value } })
              setParsed({ dialect: payload.dialect, items: payload.items, warnings: payload.warnings ?? [] })
              setParseError('')
            } catch (error) {
              setParsed({ dialect: '', items: [], warnings: [] })
              setParseError(error instanceof Error ? error.message : String(error))
            }
          })()
        }, 220)
        return () => clearTimeout(timer)
      }, [])

      useEffect(() => {
        if (tab !== 'config') return undefined
        return parseText(text)
      }, [text, tab, parseText])

      /** Apply one parsed item to this server. */
      const submitText = async (ignorePreflight) => {
        const items = parsed.items
        if (items.length === 0) {
          onError(t('parseEmpty'))
          return
        }
        if (items.length > 1) {
          // Editing one row must not quietly add or overwrite siblings; the add
          // dialog is the place for that.
          onError(t('editOneOnly'))
          return
        }
        setBusy(true)
        try {
          // `row.config` is the normalized dsh config the host built while
          // parsing; fall back to the draft itself so a shape change in that
          // response cannot silently send `undefined` and blank the row.
          const target = items[0].row?.config ?? items[0]
          await api('update', {
            method: 'POST',
            body: {
              id: dialog.id,
              draft: target,
              ...(ignorePreflight === true ? { ignorePreflight: true } : {}),
            },
          })
          onDone(t('updatedToast', { name: items[0].serverName }))
        } catch (error) {
          setBusy(false)
          onError(error instanceof Error ? error.message : String(error), error)
        }
      }

      const submitForm = async (ignorePreflight) => {
        const found = validateForm(form, t)
        setErrors(found)
        if (Object.keys(found).length > 0) return
        setBusy(true)
        try {
          await api('update', {
            method: 'POST',
            body: {
              id: dialog.id,
              draft: draftFromForm(form),
              ...(ignorePreflight === true ? { ignorePreflight: true } : {}),
            },
          })
          onDone(t('updatedToast', { name: form.serverName }))
        } catch (error) {
          setBusy(false)
          onError(error instanceof Error ? error.message : String(error), error)
        }
      }

      const tabs = h(
        'div',
        { className: 'mcpm-tabs', role: 'tablist' },
        h(
          'button',
          {
            type: 'button',
            className: 'mcpm-tab',
            role: 'tab',
            'aria-selected': tab === 'config' ? 'true' : 'false',
            onClick: () => setTab('config'),
          },
          t('tabConfig'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'mcpm-tab',
            role: 'tab',
            'aria-selected': tab === 'form' ? 'true' : 'false',
            onClick: () => setTab('form'),
          },
          t('tabManual'),
        ),
      )

      const usable = parsed.items
      const body =
        tab === 'config'
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'mcpm-field' },
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
                  h('span', { className: 'mcpm-hint' }, t('editConfigHint')),
                  h(
                    'div',
                    { className: 'mcpm-seg', role: 'group' },
                    ['dsh', 'json'].map((key) =>
                      h(
                        'button',
                        {
                          key,
                          type: 'button',
                          className: `mcpm-seg-btn${dialect === key ? ' on' : ''}`,
                          'aria-pressed': dialect === key ? 'true' : 'false',
                          onClick: () => switchDialect(key),
                          disabled: busy,
                        },
                        key === 'dsh' ? t('dialectDsh') : t('dialectJson'),
                      ),
                    ),
                  ),
                ),
                h('textarea', {
                  id: 'mcpm-edit-config',
                  className: 'mono',
                  value: text,
                  onChange: (event) => setText(event.target.value),
                  rows: 12,
                  spellCheck: false,
                  placeholder: t('importPlaceholder'),
                  disabled: busy,
                }),
              ),
              h(
                'div',
                { className: 'mcpm-preview' },
                parseError !== ''
                  ? h('div', { className: 'mcpm-inline-error' }, icon(ICON.alert), parseError)
                  : text.trim() === ''
                    ? h('p', { className: 'mcpm-preview-idle' }, t('parseEmpty'))
                    : h(
                        'div',
                        null,
                        h(
                          'div',
                          { className: 'mcpm-preview-head' },
                          h('span', { className: 'mcpm-tag' }, parsed.dialect === 'json' ? t('dialectJson') : t('dialectDsh')),
                          h(
                            'span',
                            { className: usable.length === 1 ? '' : 'mcpm-tag bad' },
                            usable.length === 1 ? fmt(t('editReady'), { n: 1 }) : t('editOneOnly'),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'mcpm-preview-list' },
                          parsed.items.map((item, index) =>
                            h(
                              'div',
                              { key: `${item.serverName}-${index}`, className: 'mcpm-preview-item' },
                              h('span', { className: 'mcpm-dot connected' }),
                              h(
                                'span',
                                { className: 'mcpm-preview-main' },
                                h('span', { className: 'mcpm-preview-name' }, item.serverName),
                                h('span', { className: 'mcpm-preview-meta' }, `${item.transport} · ${item.endpoint}`),
                              ),
                              h('span', { className: 'mcpm-tag' }, item.rowId),
                            ),
                          ),
                        ),
                      ),
              ),
              dialog.error ? h('div', { className: 'mcpm-inline-error' }, icon(ICON.alert), dialog.error) : null,
              h(FindingsList, { findings: dialog.findings, t }),
            )
          : h(
              'div',
              null,
              h(ServerForm, {
                form,
                errors,
                disabled: busy,
                t,
                onChange: (key, value) => setForm((current) => ({ ...current, [key]: value })),
              }),
              dialog.error ? h('div', { className: 'mcpm-inline-error' }, icon(ICON.alert), dialog.error) : null,
              h(FindingsList, { findings: dialog.findings, t }),
            )

      const status =
        tab === 'config'
          ? text.trim() === ''
            ? ''
            : usable.length === 1
              ? fmt(t('editReady'), { n: 1 })
              : ''
          : t('editHint')

      return h(DialogShell, {
        t,
        eyebrow: t('editEyebrow'),
        title: fmt(t('editTitle'), { name: form.serverName || dialog.id }),
        tabs,
        body,
        status,
        statusError: false,
        submitLabel: t('submitEdit'),
        submitDisabled: tab === 'config' && usable.length !== 1,
        submitting: busy,
        canIgnore: dialog.canIgnore === true,
        onIgnore: () => void (tab === 'config' ? submitText(true) : submitForm(true)),
        onSubmit: () => void (tab === 'config' ? submitText(false) : submitForm(false)),
        onClose,
      })
    }

    /**
     * Add one or more servers, by pasting or by filling the form.
     * @param {object} props
     * @returns {object}
     */
    function AddDialog(props) {
      const { t, onClose, onDone, onError } = props
      const [tab, setTab] = useState('import')
      const [text, setText] = useState('')
      const [parsed, setParsed] = useState({ dialect: '', items: [], warnings: [] })
      const [parseError, setParseError] = useState('')
      const [form, setForm] = useState(formFromDraft({}))
      const [errors, setErrors] = useState({})
      const [busy, setBusy] = useState(false)

      // Debounced parse: parsing is cheap, but it runs on every keystroke of a
      // multi-KB paste otherwise.
      useEffect(() => {
        if (tab !== 'import') return
        if (text.trim() === '') {
          setParsed({ dialect: '', items: [], warnings: [] })
          setParseError('')
          return
        }
        const timer = setTimeout(() => {
          void (async () => {
            try {
              const payload = await api('parse', { method: 'POST', body: { text } })
              setParsed({ dialect: payload.dialect, items: payload.items, warnings: payload.warnings ?? [] })
              setParseError('')
            } catch (error) {
              setParsed({ dialect: '', items: [], warnings: [] })
              setParseError(error instanceof Error ? error.message : String(error))
            }
          })()
        }, 220)
        return () => clearTimeout(timer)
      }, [text, tab])

      const tabs = h(
        'div',
        { className: 'mcpm-tabs', role: 'tablist' },
        ['import', 'manual'].map((key) =>
          h(
            'button',
            {
              key,
              type: 'button',
              className: 'mcpm-tab',
              role: 'tab',
              'aria-selected': tab === key ? 'true' : 'false',
              onClick: () => setTab(key),
            },
            key === 'import' ? t('tabImport') : t('tabManual'),
          ),
        ),
      )

      const usable = parsed.items.filter((item) => !item.duplicate && !item.duplicatedInInput)

      const submitImport = async (ignorePreflight) => {
        if (usable.length === 0) return
        setBusy(true)
        try {
          await api('add', {
            method: 'POST',
            body: {
              drafts: usable.map((item) => item.row.config),
              ...(ignorePreflight === true ? { ignorePreflight: true } : {}),
            },
          })
          onDone(fmt(t('addedToast'), { n: usable.length }))
        } catch (error) {
          setBusy(false)
          onError(error instanceof Error ? error.message : String(error), error)
        }
      }

      const submitManual = async (ignorePreflight) => {
        const found = validateForm(form, t)
        setErrors(found)
        if (Object.keys(found).length > 0) return
        setBusy(true)
        try {
          await api('add', {
            method: 'POST',
            body: { drafts: [draftFromForm(form)], ...(ignorePreflight === true ? { ignorePreflight: true } : {}) },
          })
          onDone(fmt(t('addedToast'), { n: 1 }))
        } catch (error) {
          setBusy(false)
          onError(error instanceof Error ? error.message : String(error), error)
        }
      }

      const body =
        tab === 'import'
          ? h(
              'div',
              null,
              h('div', { className: 'mcpm-field' }, h('span', { className: 'mcpm-hint' }, t('importHintDsh'))),
              h(
                'div',
                { className: 'mcpm-field' },
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
                  h('label', { htmlFor: 'mcpm-import' }, t('importLabel')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'mcpm-btn link',
                      onClick: () =>
                        setText(
                          '- insert:\n' +
                            "    - id: mcp-dbx\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n" +
                            '        serverName: dbx\n        transport: stdio\n' +
                            '        command: "C:\\\\Users\\\\me\\\\.dbx\\\\bin\\\\dbx-mcp.exe"',
                        ),
                    },
                    t('fillSample'),
                  ),
                ),
                h('textarea', {
                  id: 'mcpm-import',
                  className: 'mono',
                  value: text,
                  onChange: (event) => setText(event.target.value),
                  rows: 9,
                  spellCheck: false,
                  placeholder: t('importPlaceholder'),
                  disabled: busy,
                }),
              ),
              h(
                'div',
                { className: 'mcpm-preview' },
                parseError !== ''
                  ? h('div', { className: 'mcpm-inline-error' }, icon(ICON.alert), parseError)
                  : text.trim() === ''
                    ? h('p', { className: 'mcpm-preview-idle' }, t('parseEmpty'))
                    : h(
                        'div',
                        null,
                        h(
                          'div',
                          { className: 'mcpm-preview-head' },
                          h('span', { className: 'mcpm-tag' }, parsed.dialect === 'json' ? t('dialectJson') : t('dialectDsh')),
                          h('span', null, fmt(t('parsedCount'), { n: usable.length })),
                        ),
                        h(
                          'div',
                          { className: 'mcpm-preview-list' },
                          parsed.items.map((item, index) =>
                            h(
                              'div',
                              { key: `${item.serverName}-${index}`, className: 'mcpm-preview-item' },
                              h('span', { className: `mcpm-dot ${item.duplicate || item.duplicatedInInput ? 'error' : 'connected'}` }),
                              h(
                                'span',
                                { className: 'mcpm-preview-main' },
                                h('span', { className: 'mcpm-preview-name' }, item.serverName),
                                h('span', { className: 'mcpm-preview-meta' }, `${item.transport} · ${item.endpoint}`),
                              ),
                              item.duplicate
                                ? h('span', { className: 'mcpm-tag bad' }, t('duplicate'))
                                : item.duplicatedInInput
                                  ? h('span', { className: 'mcpm-tag bad' }, t('duplicateInInput'))
                                  : h('span', { className: 'mcpm-tag' }, item.rowId),
                            ),
                          ),
                        ),
                      ),
              ),
              parsed.warnings.length > 0
                ? h(
                    'div',
                    { className: 'mcpm-warn' },
                    `${t('warnings')}: ${parsed.warnings.join('; ')}`,
                  )
                : null,
            )
          : h(ServerForm, {
              form,
              errors,
              disabled: busy,
              t,
              onChange: (key, value) => setForm((current) => ({ ...current, [key]: value })),
            })

      // The footer carries the count only, never the empty-state sentence: the
      // preview area already says that, and printing it twice reads like a bug.
      const status =
        tab === 'import' && parsed.items.length > 0
          ? fmt(t('parsedCount'), { n: usable.length })
          : ''

      return h(DialogShell, {
        t,
        eyebrow: t('addEyebrow'),
        title: t('addTitle'),
        tabs,
        body: h(
          'div',
          null,
          body,
          props.dialog.error ? h('div', { className: 'mcpm-inline-error' }, icon(ICON.alert), props.dialog.error) : null,
          h(FindingsList, { findings: props.dialog.findings, t }),
        ),
        status,
        statusError: parseError !== '',
        submitLabel: t('submitAdd'),
        submitDisabled: tab === 'import' ? usable.length === 0 : false,
        submitting: busy,
        canIgnore: props.dialog.canIgnore === true,
        onIgnore: () => void (tab === 'import' ? submitImport(true) : submitManual(true)),
        onSubmit: () => void (tab === 'import' ? submitImport(false) : submitManual(false)),
        onClose,
      })
    }

    // ── registration ────────────────────────────────────────────────────────

    /**
     * Sidebar row: a small plug glyph.
     * @param {{ size?: number }} owner
     * @returns {object}
     */
    function SidebarIcon(owner) {
      const size = owner !== null && typeof owner?.size === 'number' ? owner.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M9 3v5M15 3v5' }),
        h('path', { d: 'M6 8h12v3a6 6 0 0 1-12 0z' }),
        h('path', { d: 'M12 17v4' }),
      )
    }

    return {
      /** Cordis client services this browser half needs. */
      inject: ['slots', 'locale'],
      /** @param {object} ctx */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-manager: dictionaries')

        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const style = document.createElement('style')
          style.setAttribute('data-plugin', '@zhujiuyi/dsh-mcpserver-manager')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'mcp-manager: styles')

        const t = ctx.locale.bind(NS)

        /** The page. `key` matches the sidebar row's `id`. */
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: 'mcp-manager',
              locale: NS,
              inject: () => ({ t }),
            },
            ManagerPage,
          ),
        )

        /** The sidebar row. `order: 6` puts it just after the token dashboard. */
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'mcp-manager',
              order: 6,
              label: () => t('nav'),
              locale: NS,
            },
            SidebarIcon,
          ),
        )
      },
    }
  },
})
