import { Download, LoaderCircle, RefreshCw, X } from 'lucide-react'
import type { AppUpdater, AppUpdateState } from '../lib/appUpdater'

const phaseLabels: Record<AppUpdateState['phase'], string> = {
  idle: '检查是否有可用的新版本。',
  checking: '正在检查新版本…',
  current: '当前已是最新版本',
  available: '发现新版本，可以先下载，稍后安装。',
  downloading: '正在下载更新，音乐可以继续播放。',
  ready: '更新已下载并通过校验，可以安装。',
  installing: '正在安装，请勿关闭应用…',
  installed: '更新已安装，重启后生效。',
  restarting: '正在重启 One Player…',
}

export function AppUpdatePanel({
  updater,
  state,
  currentVersion,
  supported,
  autoCheckEnabled,
  installationBlocked,
  onToggleAutoCheck,
  onCheck,
  onConfirmInstall,
}: {
  updater: AppUpdater
  state: AppUpdateState
  currentVersion: string
  supported: boolean
  autoCheckEnabled: boolean
  installationBlocked: boolean
  onToggleAutoCheck: (enabled: boolean) => void
  onCheck: () => void
  onConfirmInstall: () => void
}) {
  const checkingAllowed = supported && ['idle', 'current', 'available'].includes(state.phase)
  const progress = state.totalBytes
    ? Math.min(100, Math.round(state.receivedBytes / state.totalBytes * 100))
    : null

  return (
    <div className="settings-card app-update-card">
      <div className="settings-card-title">
        <div className="settings-icon accent"><RefreshCw size={19} /></div>
        <div>
          <h2>应用更新</h2>
          <p>One Player {currentVersion ? `v${currentVersion}` : ''}</p>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <strong>自动检查更新</strong>
          <span>启动后及每 6 小时检查一次，使用通用 HTTP 代理。</span>
        </div>
        <label className="switch" title="自动检查应用更新">
          <input type="checkbox" checked={autoCheckEnabled} onChange={(event) => onToggleAutoCheck(event.target.checked)} />
          <span />
        </label>
      </div>
      <div className="app-update-content" aria-live="polite">
        <strong>{state.release ? `新版本 v${state.release.version}` : '保持最新'}</strong>
        <p>{supported ? phaseLabels[state.phase] : '请在桌面应用中检查和安装更新。'}</p>
        {state.release?.date && (
          <span className="app-update-date">
            发布于 {new Date(state.release.date).toLocaleDateString('zh-CN')}
          </span>
        )}
        {state.release?.notes && (
          <pre className="app-update-notes">{state.release.notes}</pre>
        )}
        {state.phase === 'downloading' && (
          <div className="app-update-progress">
            <progress max={100} value={progress ?? undefined} aria-label="更新下载进度" />
            <span>
              {progress === null ? '下载中' : `${progress}%`}
              {' · '}{(state.receivedBytes / 1024 / 1024).toFixed(1)} MB
              {state.totalBytes ? ` / ${(state.totalBytes / 1024 / 1024).toFixed(1)} MB` : ''}
            </span>
          </div>
        )}
        {state.error && <p className="app-update-error" role="alert">{state.error}</p>}
        {state.phase === 'ready' && installationBlocked && (
          <p>请等待音乐下载或本地导入完成后再安装。</p>
        )}
        <div className="app-update-actions">
          <button
            className="secondary-button"
            disabled={!checkingAllowed}
            onClick={onCheck}
          >
            {state.phase === 'checking' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            检查更新
          </button>
          {state.phase === 'available' && (
            <button className="primary-button" onClick={() => void updater.download()}>
              <Download size={14} />下载更新
            </button>
          )}
          {state.phase === 'ready' && (
            <button className="primary-button" disabled={installationBlocked} onClick={onConfirmInstall}>
              安装并重启
            </button>
          )}
          {state.phase === 'installed' && (
            <button className="primary-button" onClick={() => void updater.restart()}>重新启动</button>
          )}
        </div>
        {state.checkedAt && (
          <span className="app-update-date">上次检查：{new Date(state.checkedAt).toLocaleString('zh-CN')}</span>
        )}
      </div>
    </div>
  )
}

export function AppUpdateConfirmation({
  onClose,
  onInstall,
}: {
  onClose: () => void
  onInstall: () => void
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-update-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
      >
        <button className="modal-close" aria-label="稍后安装" onClick={onClose}><X size={18} /></button>
        <div className="modal-icon"><RefreshCw size={24} /></div>
        <h2 id="app-update-title">安装并重启 One Player？</h2>
        <p>安装会停止播放并重启应用。请先完成正在进行的 WALKMAN 传输和文件编辑。</p>
        <div className="modal-actions">
          <button className="secondary-button" autoFocus onClick={onClose}>稍后安装</button>
          <button className="primary-button" onClick={onInstall}>安装并重启</button>
        </div>
      </div>
    </div>
  )
}
