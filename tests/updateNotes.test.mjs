import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

let server
let UpdateNotes
let AppUpdatePanel

before(async () => {
  server = await createServer({
    configFile: false,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  const notesModule = await server.ssrLoadModule('/src/components/UpdateNotes.tsx')
  const panelModule = await server.ssrLoadModule('/src/components/AppUpdatePanel.tsx')
  UpdateNotes = notesModule.UpdateNotes
  AppUpdatePanel = panelModule.AppUpdatePanel
})

after(async () => {
  await server?.close()
})

function renderNotes(notes) {
  return renderToStaticMarkup(createElement(UpdateNotes, { children: notes }))
}

test('renders heading levels, formatted text, lists, quotes and code as Markdown', () => {
  const notes = [
    '# 更新说明', '## 新功能', '### 播放', '#### 四级', '##### 五级', '###### 六级',
    '', '**重点**与*强调*，支持 `v0.3.0`。', '',
    '- 新增功能', '  - 嵌套说明', '', '3. 第三步', '',
    '> 更新后重启', '', '---', '', '```sh', 'pnpm build', '```',
  ].join('\n')
  const markup = renderNotes(notes)
  for (const level of [1, 2, 3, 4, 5, 6]) {
    assert.match(markup, new RegExp(`<h${level}>[^<]+</h${level}>`))
  }
  assert.match(markup, /<strong>重点<\/strong>与<em>强调<\/em>/)
  assert.match(markup, /<code>v0\.3\.0<\/code>/)
  assert.match(markup, /<ul>[\s\S]*<li>新增功能[\s\S]*<ul>[\s\S]*<li>嵌套说明<\/li>/)
  assert.match(markup, /<ol start="3">/)
  assert.match(markup, /<blockquote>[\s\S]*更新后重启/)
  assert.match(markup, /<hr\/>/)
  assert.match(markup, /<pre><code class="language-sh">pnpm build\n<\/code><\/pre>/)
})

test('renders release tables, task lists, strikethrough and safe external links', () => {
  const markup = renderNotes([
    '| 平台 | 安装包 |', '| --- | --- |', '| macOS | `One.Player.dmg` |',
    '', '- [x] 已完成', '- [ ] 待完成', '', '~~旧说明~~', '',
    '[安装说明](https://example.com/install)', '', 'https://example.com/release',
  ].join('\n'))
  assert.match(markup, /<div class="update-notes-table"><table>/)
  assert.match(markup, /<th>平台<\/th>/)
  assert.match(markup, /<td><code>One\.Player\.dmg<\/code><\/td>/)
  assert.match(markup, /<input type="checkbox" disabled="" checked=""/)
  assert.match(markup, /<input type="checkbox" disabled=""\/>/)
  assert.match(markup, /<del>旧说明<\/del>/)
  assert.match(markup, /href="https:\/\/example\.com\/install" target="_blank" rel="noopener noreferrer"/)
  assert.match(markup, /href="https:\/\/example\.com\/release"/)
})

test('ignores raw HTML and unsafe URLs while preserving literal code', () => {
  const markup = renderNotes([
    '<script>alert("unsafe")</script>', '',
    '<iframe src="https://example.com"></iframe>', '',
    '[不安全链接](javascript:alert%281%29)', '',
    '`<img src=x onerror=alert(1)>`',
  ].join('\n'))
  assert.doesNotMatch(markup, /<script|<iframe|<img|href="javascript:/)
  assert.match(markup, /<code>&lt;img src=x onerror=alert\(1\)&gt;<\/code>/)
})

test('the update panel renders the published release notes including the installer table', () => {
  const notes = readFileSync(new URL('../.github/release-notes/v0.3.0.md', import.meta.url), 'utf8')
  const markup = renderToStaticMarkup(createElement(AppUpdatePanel, {
    updater: {},
    state: {
      phase: 'available',
      release: { version: '0.3.0', notes },
      receivedBytes: 0,
      totalBytes: null,
      error: '',
      checkedAt: null,
    },
    currentVersion: '0.2.0',
    supported: true,
    autoCheckEnabled: true,
    installationBlocked: false,
    onToggleAutoCheck() {},
    onCheck() {},
    onConfirmInstall() {},
  }))
  assert.match(markup, /class="update-notes app-update-notes"/)
  assert.match(markup, /<h2>One Player v0\.3\.0<\/h2>/)
  assert.match(markup, /<h3>菜单栏与窗口<\/h3>/)
  assert.match(markup, /<strong>菜单栏与系统托盘图标<\/strong>/)
  assert.match(markup, /<table>/)
  assert.match(markup, /<code>One\.Player_0\.3\.0_aarch64\.dmg<\/code>/)
  assert.doesNotMatch(markup, /## One Player/)
})
