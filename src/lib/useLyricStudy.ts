import { useEffect, useMemo, useState } from 'react'
import type { LyricStudySettings } from '../types'
import {
  analyzeLyrics,
  getLyricStudyConnection,
  type LyricStudyLine,
  type LyricStudyResult,
} from './lyricStudy'
import { requestHttp } from './tauri'

export function useLyricStudy(lines: readonly LyricStudyLine[] | null, settings: LyricStudySettings, proxy: string) {
  const connection = useMemo(() => getLyricStudyConnection(settings), [settings])
  const cache = useMemo(() => new Map<string, LyricStudyResult>(), [connection, proxy])
  const selection = useMemo(() => lines?.length ? { lines, key: JSON.stringify(lines) } : null, [lines])
  const [manualRun, setManualRun] = useState<{ selection: NonNullable<typeof selection> } | null>(null)
  const [run, setRun] = useState<{
    selection: NonNullable<typeof selection>
    cache: typeof cache
    status: 'loading' | 'done' | 'error'
    result?: LyricStudyResult
    error?: string
  } | null>(null)

  useEffect(() => {
    if (!connection || !selection || cache.has(selection.key)) return
    if (!settings.automatic && manualRun?.selection !== selection) return
    const controller = new AbortController()
    setRun({ selection, cache, status: 'loading' })
    void analyzeLyrics(selection.lines, connection, proxy, requestHttp, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (!result.incomplete) {
        cache.set(selection.key, result)
        if (cache.size > 12) cache.delete(cache.keys().next().value!)
      }
      setRun({ selection, cache, status: 'done', result })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setRun({ selection, cache, status: 'error', error: error instanceof Error ? error.message : String(error) })
    })
    return () => controller.abort()
  }, [cache, connection, manualRun, proxy, selection, settings.automatic])

  const current = run?.selection === selection && run.cache === cache ? run : null
  const result = (selection ? cache.get(selection.key) : undefined) ?? current?.result
  return {
    configured: !!connection,
    analyze: () => { if (selection) setManualRun({ selection }) },
    loading: current?.status === 'loading',
    error: current?.error,
    result,
  }
}
