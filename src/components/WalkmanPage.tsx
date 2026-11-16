import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  HardDrive,
  LoaderCircle,
  Music2,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  Usb,
  X,
} from 'lucide-react'
import type {
  AppSettings,
  DownloadedAudio,
  DownloadMetadata,
  MusicTrack,
  OnlineSourceKey,
  WalkmanDevice,
  WalkmanTrack,
} from '../types'
import { getBuiltinArtwork, providerNames, searchMusic } from '../lib/providers'
import {
  listWalkmanMusic,
  transferWalkmanFile,
  updateWalkmanTags,
  deleteWalkmanFile,
} from '../lib/tauri'
import {
  formatStorage,
  selectOnlineTagMetadata,
  tagMetadataKeys,
  tagSearchQuery,
  walkmanTagStatus,
} from '../lib/walkman'
import type { TagMetadataValues } from '../lib/walkman'
import {
  invalidateWalkmanArtwork,
  loadWalkmanArtwork,
  WalkmanArtwork,
} from './WalkmanArtwork'

interface Props {
  devices: WalkmanDevice[]
  deviceError: string
  downloads: DownloadedAudio[]
  settings: AppSettings
  onBack: () => void
  onRefreshDevices: () => Promise<void>
  onDownloadsChanged: () => void
}

export function WalkmanPage(props: Props) {
  const [deviceId, setDeviceId] = useState(props.devices[0]?.id ?? '')
  const device =
    props.devices.find((item) => item.id === deviceId) ?? props.devices[0]
  const id = device?.id ?? ''
  const [files, setFiles] = useState<WalkmanTrack[]>([])
  const [coverRevision, setCoverRevision] = useState(0)
  const [tab, setTab] = useState<'device' | 'downloads'>('device')
  const [selectedDevice, setSelectedDevice] = useState<Set<string>>(new Set())
  const [selectedDownloads, setSelectedDownloads] = useState<Set<string>>(
    new Set(),
  )
  const [filter, setFilter] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [issues, setIssues] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<{
    device: WalkmanDevice
    files: WalkmanTrack[]
  } | null>(null)
  const [progress, setProgress] = useState({ current: 0, total: 0, name: '' })
  const [report, setReport] = useState('')
  const [failures, setFailures] = useState<string[]>([])
  const [editing, setEditing] = useState<WalkmanTrack[]>([])
  const scanId = useRef(0)
  const cancelTransfer = useRef(false)

  async function refresh() {
    if (!id) return
    const request = ++scanId.current
    setLoading(true)
    setError('')
    try {
      const result = await listWalkmanMusic(id)
      if (request !== scanId.current) return
      invalidateWalkmanArtwork(id)
      setCoverRevision((value) => value + 1)
      setFiles(result.files)
      setIssues(result.issues)
      setSelectedDevice(
        (old) =>
          new Set(
            [...old].filter((path) =>
              result.files.some((file) => file.path === path),
            ),
          ),
      )
    } catch (error) {
      if (request === scanId.current) setError(String(error))
    } finally {
      if (request === scanId.current) setLoading(false)
    }
  }

  useEffect(() => {
    setFiles([])
    setSelectedDevice(new Set())
    setReport('')
    setFailures([])
    if (id) void refresh()
    return () => {
      scanId.current += 1
      cancelTransfer.current = true
    }
  }, [id])

  useEffect(() => {
    if (!pendingDelete || deleting) return
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPendingDelete(null)
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [pendingDelete, deleting])

  const deviceFiles = useMemo(
    () =>
      files.filter(
        (file) =>
          (!onlyMissing || file.missingFields.length > 0) &&
          `${file.title} ${file.artist} ${file.album} ${file.relativePath}`
            .toLocaleLowerCase()
            .includes(filter.toLocaleLowerCase()),
      ),
    [files, onlyMissing, filter],
  )
  const localFiles = useMemo(
    () =>
      props.downloads.filter((file) =>
        `${file.title} ${file.artist} ${file.album}`
          .toLocaleLowerCase()
          .includes(filter.toLocaleLowerCase()),
      ),
    [props.downloads, filter],
  )
  const rows = tab === 'device' ? deviceFiles : localFiles
  const selected = tab === 'device' ? selectedDevice : selectedDownloads
  const setSelected =
    tab === 'device' ? setSelectedDevice : setSelectedDownloads
  const allSelected =
    rows.length > 0 && rows.every((file) => selected.has(file.path))
  const used = device ? Math.max(0, device.totalBytes - device.freeBytes) : 0
  const percent = device?.totalBytes
    ? Math.min(100, (used / device.totalBytes) * 100)
    : 0

  async function transfer() {
    if (!device || busy || !selected.size) return
    const toWalkman = tab === 'downloads'
    const paths = [...selected]
    const sourceFiles = toWalkman ? props.downloads : files
    const selectedSize = sourceFiles
      .filter((file) => selected.has(file.path))
      .reduce((total, file) => total + file.size, 0)
    if (toWalkman && selectedSize > device.freeBytes) {
      setError('所选音乐超过 WALKMAN 剩余空间，请减少选择。')
      return
    }
    setBusy(true)
    setError('')
    setReport('')
    setFailures([])
    cancelTransfer.current = false
    const errors: string[] = []
    let copied = 0
    let processed = 0
    try {
      for (const path of paths) {
        if (cancelTransfer.current) break
        const file = sourceFiles.find((file) => file.path === path)
        setProgress({
          current: processed,
          total: paths.length,
          name: file?.title ?? path,
        })
        try {
          await transferWalkmanFile(
            device.id,
            path,
            toWalkman,
            props.settings.downloadDirectory || undefined,
          )
          copied += 1
          setSelected((old) => {
            const next = new Set(old)
            next.delete(path)
            return next
          })
        } catch (error) {
          errors.push(`${file?.title ?? path}：${String(error)}`)
        }
        processed += 1
        setProgress({
          current: processed,
          total: paths.length,
          name: file?.title ?? path,
        })
      }
      setReport(
        `${cancelTransfer.current ? '已停止' : '同步完成'}：成功 ${copied} 首${errors.length ? `，失败 ${errors.length} 首` : ''}${processed < paths.length ? `，未处理 ${paths.length - processed} 首` : ''}`,
      )
      setFailures(errors)
      props.onDownloadsChanged()
      await Promise.all([refresh(), props.onRefreshDevices()])
    } finally {
      setBusy(false)
    }
  }

  function requestDelete() {
    if (!device || busy || loading) return
    const tracks = files.filter((file) => selectedDevice.has(file.path))
    if (tracks.length) setPendingDelete({ device, files: tracks })
  }

  async function confirmDelete() {
    if (!pendingDelete || busy) return
    const request = pendingDelete
    const errors: string[] = []
    let removed = 0
    setBusy(true)
    setDeleting(true)
    setError('')
    setReport('')
    setFailures([])
    setProgress({ current: 0, total: request.files.length, name: '' })
    try {
      for (const [index, file] of request.files.entries()) {
        setProgress({
          current: index,
          total: request.files.length,
          name: file.title,
        })
        try {
          await deleteWalkmanFile(request.device.id, file.path)
          invalidateWalkmanArtwork(request.device.id, file.path)
          removed += 1
          setFiles((current) =>
            current.filter((item) => item.path !== file.path),
          )
          setSelectedDevice((current) => {
            const next = new Set(current)
            next.delete(file.path)
            return next
          })
        } catch (error) {
          errors.push(`${file.title}：${String(error)}`)
        }
        setProgress({
          current: index + 1,
          total: request.files.length,
          name: file.title,
        })
      }
      setPendingDelete(null)
      setReport(
        `删除完成：成功 ${removed} 首${errors.length ? `，失败 ${errors.length} 首` : ''}`,
      )
      setFailures(errors)
      await Promise.all([refresh(), props.onRefreshDevices()])
    } finally {
      setDeleting(false)
      setBusy(false)
    }
  }

  return (
    <section className="page-section walkman-page">
      <div className="walkman-heading">
        <div>
          <button
            className="walkman-back"
            onClick={props.onBack}
            disabled={busy || editing.length > 0}
          >
            <ArrowLeft size={16} />
            下载管理
          </button>
          <span className="eyebrow">YOUR MUSIC, EVERYWHERE</span>
          <h1>WALKMAN 音乐管理</h1>
          <p>选择音乐，在电脑与随身听之间同步。</p>
        </div>
        {device && (
          <div className="walkman-storage">
            <div>
              <HardDrive size={17} />
              <strong>{device.name}</strong>
              <span>{percent.toFixed(0)}% 已使用</span>
            </div>
            <progress
              value={used}
              max={device.totalBytes || 1}
              aria-label="WALKMAN 已使用存储空间"
            />
            <small>
              可用 {formatStorage(device.freeBytes)}{' '}
              <span>共 {formatStorage(device.totalBytes)}</span>
            </small>
          </div>
        )}
      </div>
      {!device ? (
        <div className="walkman-disconnected">
          <Usb size={42} />
          <h2>连接你的 WALKMAN</h2>
          <p>连接 USB 并开启存储模式后，将自动识别设备的 MUSIC 目录。</p>
          {props.deviceError && (
            <p className="download-error">{props.deviceError}</p>
          )}
          <button
            className="secondary-button"
            onClick={() => void props.onRefreshDevices()}
          >
            <RefreshCw size={16} />
            重新检测
          </button>
        </div>
      ) : (
        <>
          <div className="walkman-device-line">
            <span className="status-dot ready" />
            <span>{device.musicDirectory}</span>
            {props.devices.length > 1 && (
              <select
                value={id}
                onChange={(e) => setDeviceId(e.target.value)}
                disabled={busy || editing.length > 0}
              >
                {props.devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
            <button
              className="secondary-button"
              disabled={busy || loading || editing.length > 0}
              onClick={() =>
                void Promise.all([refresh(), props.onRefreshDevices()])
              }
            >
              <RefreshCw size={15} className={loading ? 'spin' : ''} />
              刷新
            </button>
          </div>
          <div className="walkman-tabs" role="tablist" aria-label="音乐来源">
            <button
              role="tab"
              aria-selected={tab === 'device'}
              className={tab === 'device' ? 'active' : ''}
              disabled={busy}
              onClick={() => {
                setTab('device')
                setFilter('')
              }}
            >
              <Usb size={18} />
              WALKMAN <span>{files.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === 'downloads'}
              className={tab === 'downloads' ? 'active' : ''}
              disabled={busy}
              onClick={() => {
                setTab('downloads')
                setFilter('')
              }}
            >
              <HardDrive size={18} />
              已下载音乐 <span>{props.downloads.length}</span>
            </button>
          </div>
          <div className="walkman-toolbar">
            <label className="walkman-search">
              <Search size={17} />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="筛选歌曲、歌手或文件夹"
              />
            </label>
            {tab === 'device' && (
              <label className="walkman-missing">
                <input
                  type="checkbox"
                  checked={onlyMissing}
                  onChange={(e) => setOnlyMissing(e.target.checked)}
                />
                仅显示待补全项
              </label>
            )}
            <span className="walkman-selection">已选 {selected.size} 首</span>
            {tab === 'device' && (
              <button
                className="secondary-button"
                disabled={busy || !selectedDevice.size || loading}
                onClick={() =>
                  setEditing(
                    files.filter((file) => selectedDevice.has(file.path)),
                  )
                }
              >
                <Tags size={16} />
                补全标签与封面
              </button>
            )}
            <button
              className="primary-button"
              disabled={busy || !selected.size || loading}
              onClick={() => void transfer()}
            >
              {tab === 'device' ? (
                <ArrowDownToLine size={17} />
              ) : (
                <ArrowUpFromLine size={17} />
              )}
              {tab === 'device' ? '导出到下载文件夹' : '同步到 WALKMAN'}
            </button>
            {tab === 'device' && (
              <button
                className="secondary-button walkman-delete-button"
                disabled={busy || loading || !selectedDevice.size}
                onClick={requestDelete}
              >
                <Trash2 size={16} />
                删除
              </button>
            )}
          </div>
          {busy && (
            <div className="walkman-progress">
              <LoaderCircle className="spin" size={18} />
              <span>
                {deleting ? '正在删除' : '正在复制'} {progress.current} /{' '}
                {progress.total} · {progress.name}
              </span>
              {!deleting && (
                <button
                  onClick={() => {
                    cancelTransfer.current = true
                  }}
                >
                  完成当前文件后停止
                </button>
              )}
              <progress value={progress.current} max={progress.total || 1} />
            </div>
          )}
          {(error || props.deviceError) && (
            <p className="download-error" role="alert">
              {error || props.deviceError}
            </p>
          )}
          {report && (
            <p className="walkman-report" role="status">
              <Check size={17} />
              {report}
            </p>
          )}
          {failures.length > 0 && (
            <details className="walkman-issues">
              <summary>查看失败文件（{failures.length}）</summary>
              {failures.map((text, i) => (
                <p key={i}>{text}</p>
              ))}
            </details>
          )}
          {issues.length > 0 && (
            <details className="walkman-issues">
              <summary>部分目录读取失败（{issues.length}）</summary>
              {issues.map((text, i) => (
                <p key={i}>{text}</p>
              ))}
            </details>
          )}
          <div className="walkman-table">
            <div className="walkman-table-head">
              <label>
                <input
                  type="checkbox"
                  aria-label="选择当前筛选的全部音乐"
                  checked={allSelected}
                  disabled={busy || !rows.length}
                  onChange={() =>
                    setSelected((old) => {
                      const next = new Set(old)
                      rows.forEach((file) =>
                        allSelected
                          ? next.delete(file.path)
                          : next.add(file.path),
                      )
                      return next
                    })
                  }
                />
                歌曲 / 文件位置
              </label>
              <span>歌手 / 专辑</span>
              <span>格式 / 大小</span>
              <span>{tab === 'device' ? '标签 / 封面' : '状态'}</span>
            </div>
            {rows.map((file) => (
              <label
                className={`walkman-row ${selected.has(file.path) ? 'selected' : ''}`}
                key={file.path}
                onDoubleClick={(event) => {
                  if (
                    event.target instanceof HTMLInputElement ||
                    busy ||
                    loading ||
                    !device ||
                    editing.length ||
                    !('missingFields' in file)
                  )
                    return
                  event.preventDefault()
                  setEditing([file])
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(file.path)}
                  disabled={busy}
                  onChange={() =>
                    setSelected((old) => {
                      const next = new Set(old)
                      next.has(file.path)
                        ? next.delete(file.path)
                        : next.add(file.path)
                      return next
                    })
                  }
                />
                <div className="walkman-song">
                  <WalkmanArtwork
                    deviceId={id}
                    revision={coverRevision}
                    file={'missingFields' in file ? file : undefined}
                    url={'coverDataUrl' in file ? file.coverDataUrl : undefined}
                  />
                  <div>
                    <strong>{file.title}</strong>
                    <small title={file.path}>
                      {'relativePath' in file ? file.relativePath : file.path}
                    </small>
                  </div>
                </div>
                <div>
                  <span>{file.artist || '未知歌手'}</span>
                  <small>{file.album || '未知专辑'}</small>
                </div>
                <div>
                  <span className="walkman-format">
                    {file.format.toUpperCase()}
                  </span>
                  <small>{formatStorage(file.size)}</small>
                </div>
                <div>
                  {'missingFields' in file ? (
                    <span
                      className={
                        file.missingFields.length || file.tagError
                          ? 'walkman-tag-missing'
                          : 'walkman-tag-complete'
                      }
                      title={file.tagError ?? ''}
                    >
                      {walkmanTagStatus(file).length
                        ? walkmanTagStatus(file).map((text) => (
                            <span className="walkman-status-line" key={text}>
                              {text}
                            </span>
                          ))
                        : '标签与封面完整'}
                    </span>
                  ) : (
                    <span className="walkman-tag-complete">已下载</span>
                  )}
                </div>
              </label>
            ))}
            {!rows.length && (
              <div className="walkman-empty">
                {loading ? (
                  <>
                    <LoaderCircle className="spin" size={24} />
                    <span>正在读取 MUSIC 及其子目录…</span>
                  </>
                ) : (
                  <>
                    <Music2 size={28} />
                    <span>
                      {filter || onlyMissing
                        ? '没有符合筛选条件的音乐'
                        : tab === 'device'
                          ? 'WALKMAN 中还没有音乐'
                          : '还没有已下载音乐'}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
          <p className="walkman-footnote">
            双击歌曲可直接补全信息与封面，勾选多首可批量处理。{' '}
            标注“文件名已识别”的信息尚未写入文件标签；补全时可一并写入歌曲信息和封面。{' '}
            支持 MP3、WAV、FLAC、APE、DSF
            等格式。同步保留原文件；遇到重名会另存副本。
          </p>
        </>
      )}
      {pendingDelete && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!deleting) setPendingDelete(null)
          }}
        >
          <section
            className="modal-card walkman-delete-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="walkman-delete-title"
            aria-describedby="walkman-delete-description"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-icon danger">
              <Trash2 size={23} />
            </div>
            <h2 id="walkman-delete-title">删除 WALKMAN 音乐</h2>
            <p id="walkman-delete-description">
              将从 {pendingDelete.device.name} 永久删除以下{' '}
              {pendingDelete.files.length} 首音乐，此操作无法撤销。
            </p>
            <ul className="walkman-delete-list">
              {pendingDelete.files.map((file) => (
                <li key={file.path}>
                  <strong>{file.title}</strong>
                  <span>{file.artist || '未知歌手'}</span>
                  <small>{file.relativePath}</small>
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button
                className="secondary-button"
                autoFocus
                disabled={deleting}
                onClick={() => setPendingDelete(null)}
              >
                取消
              </button>
              <button
                className="primary-button danger"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {deleting ? (
                  <>
                    <LoaderCircle className="spin" size={16} />
                    删除中 {progress.current} / {progress.total}
                  </>
                ) : (
                  `确认删除 ${pendingDelete.files.length} 首`
                )}
              </button>
            </div>
          </section>
        </div>
      )}
      {editing.length > 0 && device && (
        <TagEditor
          tracks={editing}
          device={device}
          settings={props.settings}
          onClose={() => {
            setEditing([])
            void refresh()
            void props.onRefreshDevices()
          }}
          onUpdated={(originalPath, updated) => {
            invalidateWalkmanArtwork(device.id, originalPath)
            invalidateWalkmanArtwork(device.id, updated.path)
            setCoverRevision((value) => value + 1)
            setFiles((old) =>
              old.map((file) => (file.path === originalPath ? updated : file)),
            )
            setSelectedDevice((old) => {
              if (!old.has(originalPath)) return old
              const next = new Set(old)
              next.delete(originalPath)
              next.add(updated.path)
              return next
            })
          }}
        />
      )}
    </section>
  )
}

function TagEditor({
  tracks,
  device,
  settings,
  onClose,
  onUpdated,
}: {
  tracks: WalkmanTrack[]
  device: WalkmanDevice
  settings: AppSettings
  onClose: () => void
  onUpdated: (originalPath: string, updated: WalkmanTrack) => void
}) {
  const [index, setIndex] = useState(0)
  const file = tracks[index]
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState<'all' | OnlineSourceKey>('all')
  const [results, setResults] = useState<MusicTrack[]>([])
  const [candidate, setCandidate] = useState('')
  const [metadata, setMetadata] = useState<DownloadMetadata>({
    title: '',
    artist: '',
    album: '',
  })
  const [onlineMetadata, setOnlineMetadata] = useState<TagMetadataValues | null>(
    null,
  )
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [searchWarning, setSearchWarning] = useState('')
  const [existingCover, setExistingCover] = useState<string | null>(null)
  const [coverLoading, setCoverLoading] = useState(false)
  const [coverError, setCoverError] = useState('')
  const coverRequestId = useRef(0)
  const requestId = useRef(0)

  async function search(value = query) {
    if (!value.trim()) return
    const request = ++requestId.current
    setSearching(true)
    setError('')
    setSearchWarning('')
    setResults([])
    setCandidate('')
    const sources =
      provider === 'all'
        ? (Object.keys(providerNames) as OnlineSourceKey[])
        : [provider]
    try {
      const responses = await Promise.allSettled(
        sources.map((source) => searchMusic(source, value, 1, settings)),
      )
      if (request !== requestId.current) return
      const songs = responses.flatMap((response) =>
        response.status === 'fulfilled' ? response.value.list.slice(0, 12) : [],
      )
      setResults(songs)
      const failed = sources
        .filter((_, i) => responses[i].status === 'rejected')
        .map((source) => providerNames[source])
      if (failed.length)
        setSearchWarning(`${failed.join('、')}搜索失败，可切换平台重试。`)
      if (!songs.length)
        setError('没有找到匹配歌曲，可修改关键词重试或手动填写标签。')
    } finally {
      if (request === requestId.current) setSearching(false)
    }
  }

  useEffect(() => {
    const query = tagSearchQuery(file)
    setQuery(query)
    setMetadata({ title: file.title, artist: file.artist, album: file.album })
    setResults([])
    setCandidate('')
    setOnlineMetadata(null)
    setError('')
    setExistingCover(null)
    setCoverError('')
    setCoverLoading(false)
    coverRequestId.current += 1
    let cancelled = false
    if (file.hasCover)
      void loadWalkmanArtwork(device.id, file)
        .then((cover) => {
          if (!cancelled) setExistingCover(cover)
        })
        .catch(() => {
          if (!cancelled)
            setCoverError('已有封面预览读取失败，写入时将保留原封面。')
        })
    void search(query)
    return () => {
      requestId.current += 1
      coverRequestId.current += 1
      cancelled = true
    }
  }, [file.path])

  async function choose(track: MusicTrack) {
    const request = ++coverRequestId.current
    const key = `${track.source}_${track.songmid}`
    const existing = {
      title: file.title,
      artist: file.artist,
      album: file.album,
    }
    const online = {
      title: track.name,
      artist: track.singer,
      album: track.albumName,
    }
    setCandidate(key)
    setOnlineMetadata(online)
    setMetadata({
      ...selectOnlineTagMetadata({
        existing,
        online,
        missingFields: file.missingFields,
        overwriteExisting: settings.overwriteExistingTags,
      }),
      coverUrl: track.img ?? undefined,
      trackKey: key,
    })
    setCoverLoading(true)
    setCoverError('')
    try {
      const cover = await getBuiltinArtwork(track, settings)
      if (request !== coverRequestId.current) return
      setMetadata((old) => ({ ...old, coverUrl: cover || undefined }))
      if (!cover)
        setCoverError(
          file.hasCover
            ? '此结果未提供封面，将保留文件内已有封面。'
            : '此结果没有封面，请选择其他结果或填写封面图片地址。',
        )
    } catch (error) {
      if (request === coverRequestId.current)
        setCoverError(`封面获取失败：${String(error)}`)
    } finally {
      if (request === coverRequestId.current) setCoverLoading(false)
    }
  }

  function next() {
    if (index + 1 === tracks.length) onClose()
    else setIndex((value) => value + 1)
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      if (!metadata.coverUrl && !file.hasCover)
        throw new Error('请先选择匹配歌曲的封面，或填写封面图片地址。')
      const updated = await updateWalkmanTags(
        device.id,
        file.path,
        {
          ...metadata,
          title: metadata.title.trim(),
          artist: metadata.artist.trim(),
          album: metadata.album.trim(),
          coverUrl: metadata.coverUrl || undefined,
        },
        settings.proxy || undefined,
      )
      onUpdated(file.path, updated)
      next()
    } catch (error) {
      setError(String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop walkman-tag-backdrop">
      <section
        className="walkman-tag-modal"
        role="dialog"
        aria-modal="true"
        aria-label="音乐标签和封面补全"
      >
        <div className="walkman-tag-title">
          <div>
            <span className="eyebrow">
              完善音乐信息 · {index + 1} / {tracks.length}
            </span>
            <h2>补全标签与封面</h2>
            <p title={file.path}>{file.relativePath}</p>
          </div>
          <button
            className="icon-button"
            disabled={saving}
            onClick={onClose}
            aria-label="关闭标签补全"
          >
            <X size={20} />
          </button>
        </div>
        <form
          className="walkman-tag-search"
          onSubmit={(e) => {
            e.preventDefault()
            void search()
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="歌曲名、歌手或文件名"
            disabled={saving}
          />
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as typeof provider)}
            disabled={saving}
          >
            <option value="all">所有平台</option>
            {Object.entries(providerNames).map(([key, name]) => (
              <option value={key} key={key}>
                {name}
              </option>
            ))}
          </select>
          <button
            className="secondary-button"
            disabled={searching || saving || !query.trim()}
          >
            {searching ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Search size={16} />
            )}
            搜索
          </button>
        </form>
        <p className="walkman-tag-help">
          选择匹配版本，确认歌曲信息和封面后写入。文件名推断的信息也会写入标签。
          保存后按「歌手-歌曲名.扩展名」重命名，保留原目录；同名文件自动加序号。
          已有封面也会自动转换为 WALKMAN 兼容格式，无需重新搜索封面。
        </p>
        {searchWarning && (
          <p className="walkman-search-warning">{searchWarning}</p>
        )}
        <div className="walkman-tag-results">
          {searching && (
            <div className="walkman-empty">
              <LoaderCircle className="spin" size={24} />
              正在搜索匹配的音乐…
            </div>
          )}
          {results.map((track) => {
            const key = `${track.source}_${track.songmid}`
            return (
              <button
                disabled={saving}
                className={`walkman-candidate ${candidate === key ? 'selected' : ''}`}
                key={key}
                onClick={() => void choose(track)}
              >
                {track.img ? (
                  <img src={track.img} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <Music2 size={32} />
                )}
                <span>
                  <strong>{track.name}</strong>
                  <small>
                    {track.singer} · {track.albumName || '未知专辑'}
                  </small>
                </span>
                <small>
                  {providerNames[track.source as OnlineSourceKey]} ·{' '}
                  {track.interval || '—'}
                </small>
                {candidate === key && <Check size={18} />}
              </button>
            )
          })}
        </div>
        <div className="walkman-cover-editor">
          <div className="walkman-cover-preview">
            {coverLoading ? (
              <LoaderCircle className="spin" size={24} />
            ) : metadata.coverUrl || existingCover ? (
              <img
                src={metadata.coverUrl || existingCover!}
                alt="待写入的歌曲封面"
                referrerPolicy="no-referrer"
                onError={() =>
                  setCoverError('封面图片无法预览，请检查地址或更换搜索结果。')
                }
              />
            ) : (
              <Music2 size={32} />
            )}
          </div>
          <div>
            <strong>歌曲封面</strong>
            <p>
              {coverLoading
                ? '正在获取封面…'
                : metadata.coverUrl
                  ? '此封面将写入音乐文件'
                  : file.hasCover
                    ? '使用已有封面，保存时自动处理 WALKMAN 兼容性'
                    : '尚未写入封面，请从搜索结果选择'}
            </p>
            <input
              aria-label="封面图片地址"
              value={metadata.coverUrl ?? ''}
              disabled={saving || coverLoading}
              placeholder={
                file.hasCover
                  ? '填写图片地址以替换已有封面（可选）'
                  : '也可填写 HTTP/HTTPS 封面图片地址'
              }
              onChange={(event) => {
                coverRequestId.current += 1
                setCoverError('')
                setMetadata((old) => ({
                  ...old,
                  coverUrl: event.target.value.trim() || undefined,
                }))
              }}
            />
            {coverError && (
              <small className="walkman-cover-error" role="status">
                {coverError}
              </small>
            )}
          </div>
        </div>
        <div className="walkman-tag-fields">
          {tagMetadataKeys.map((key, index) => {
            const original =
              key === 'title' ? file.title : key === 'artist' ? file.artist : file.album
            const online = onlineMetadata?.[key]
            const changed = online !== undefined && online !== original
            return (
              <label key={key}>
                {['歌曲名', '歌手', '专辑'][index]}
                <input
                  value={metadata[key]}
                  onChange={(e) =>
                    setMetadata((old) => ({ ...old, [key]: e.target.value }))
                  }
                  disabled={saving}
                />
                {changed && (
                  <span className="tag-value-diff">
                    <button
                      type="button"
                      className={metadata[key] === original ? 'active' : ''}
                      disabled={saving}
                      onClick={() =>
                        setMetadata((old) => ({ ...old, [key]: original }))
                      }
                    >
                      <span>原值</span>
                      <strong>{original || '空'}</strong>
                    </button>
                    <small>→</small>
                    <button
                      type="button"
                      className={metadata[key] === online ? 'active' : ''}
                      disabled={saving}
                      onClick={() =>
                        setMetadata((old) => ({ ...old, [key]: online }))
                      }
                    >
                      <span>新值</span>
                      <strong>{online || '空'}</strong>
                    </button>
                  </span>
                )}
              </label>
            )
          })}
        </div>
        {error && (
          <p className="download-error" role="alert">
            {error}
          </p>
        )}
        <div className="walkman-tag-footer">
          <span>保留音频内容和其他已有标签。</span>
          <button className="secondary-button" disabled={saving} onClick={next}>
            跳过
          </button>
          <button
            className="primary-button"
            disabled={
              saving ||
              coverLoading ||
              !metadata.title.trim() ||
              !metadata.artist.trim() ||
              (!file.hasCover && !metadata.coverUrl)
            }
            onClick={() => void save()}
          >
            {saving ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <Tags size={17} />
            )}
            {saving
              ? '正在写入'
              : index + 1 < tracks.length
                ? '写入并继续'
                : '写入标签与封面'}
          </button>
        </div>
      </section>
    </div>
  )
}
