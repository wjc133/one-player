import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  analyzeLyrics,
  getLyricStudyConnection,
  getLyricStudyEndpoint,
  groupLyricWords,
  normalizeLyricStudySettings,
  parseLyricStudyResponse,
} from '../src/lib/lyricStudy.ts'

const lyric = (id, text) => ({ id, text })
const token = (text, reading) => ({ text, reading })
const completion = (lines) => JSON.stringify({
  choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({ lines })}\n\`\`\`` } }],
})

test('uses provider presets and accepts OpenAI-compatible base URLs or full endpoints', () => {
  const settings = normalizeLyricStudySettings({ enabled: true })
  assert.equal(settings.automatic, false)
  assert.equal(getLyricStudyConnection(settings), null)
  assert.equal(getLyricStudyConnection({ ...settings, apiKey: 'test' }).endpoint, 'https://api.siliconflow.cn/v1/chat/completions')
  const deepseek = normalizeLyricStudySettings({ enabled: true, provider: 'deepseek', apiKey: 'test' })
  assert.equal(getLyricStudyConnection(deepseek).endpoint, 'https://api.deepseek.com/chat/completions')
  assert.equal(getLyricStudyEndpoint(' https://example.com/gateway/v1/ '), 'https://example.com/gateway/v1/chat/completions')
  assert.equal(getLyricStudyEndpoint('http://localhost:11434/v1/chat/completions'), 'http://localhost:11434/v1/chat/completions')
  assert.equal(getLyricStudyEndpoint('file:///tmp/model'), null)
  assert.equal(getLyricStudyEndpoint('https://name:secret@example.com/v1'), null)
})

test('the master switch blocks connections even with saved credentials and automatic study enabled', () => {
  const settings = normalizeLyricStudySettings({ provider: 'deepseek', apiKey: 'test', automatic: true })
  assert.equal(settings.enabled, false)
  assert.equal(settings.automatic, true)
  assert.equal(getLyricStudyConnection(settings), null)
  assert.equal(getLyricStudyConnection({ ...settings, enabled: true }).apiKey, 'test')
})

test('aligns English IPA and Japanese kana above the exact lyric words and leaves Chinese unchanged', () => {
  const lines = [lyric(5, `I'll wait, wait!`), lyric(6, '君を待つ。'), lyric(7, '我在等你')]
  const result = parseLyricStudyResponse(completion([
    { id: 5, language: 'en', tokens: [token("I'll", 'aɪl'), token('wait', 'weɪt'), token('wait', 'weɪt')] },
    { id: 6, language: 'ja', tokens: [token('君', 'きみ'), token('を', 'を'), token('待つ', 'まつ')] },
    { id: 7, language: 'zh', tokens: [] },
  ]), lines)
  assert.equal(result.incomplete, false)
  assert.deepEqual([...result.annotations.keys()], [5, 6])
  assert.deepEqual(result.annotations.get(5), {
    language: 'en',
    segments: [
      token("I'll", 'aɪl'), { text: ' ' }, token('wait', 'weɪt'), { text: ', ' }, token('wait', 'weɪt'), { text: '!' },
    ],
  })
  assert.deepEqual(result.annotations.get(6), {
    language: 'ja',
    segments: [
      token('君', 'きみ'), token('を', 'を'), token('待つ', 'まつ'), { text: '。' },
    ],
  })
})

test('groups Japanese segments into words with attached punctuation', () => {
  assert.deepEqual(groupLyricWords([token('君', 'きみ'), token('を', 'を'), token('待つ', 'まつ'), { text: '。' }]), [
    { segments: [token('君', 'きみ')], text: '君' },
    { segments: [token('を', 'を')], text: 'を' },
    { segments: [token('待つ', 'まつ'), { text: '。' }], text: '待つ' },
  ])
  assert.deepEqual(groupLyricWords([{ text: '「' }, token('君', 'きみ'), { text: '」' }]), [
    { segments: [{ text: '「' }, token('君', 'きみ'), { text: '」' }], text: '君' },
  ])
  assert.deepEqual(groupLyricWords([{ text: '…' }]), [{ segments: [{ text: '…' }], text: '' }])
  assert.deepEqual(groupLyricWords([]), [])
})

test('keeps the original line when the model splits a contraction or returns invalid kana', () => {
  const lines = [lyric(1, `Don't go`), lyric(2, '声'), lyric(3, 'Stay')]
  const result = parseLyricStudyResponse(completion([
    { id: 1, language: 'en', tokens: [token('Don', 'doʊn'), token('t', 't'), token('go', 'ɡoʊ')] },
    { id: 2, language: 'ja', tokens: [token('声', 'koe')] },
    { id: 3, language: 'en', tokens: [token('Stay', 'steɪ')] },
  ]), lines)
  assert.equal(result.incomplete, true)
  assert.deepEqual([...result.annotations.keys()], [3])
  assert.throws(() => parseLyricStudyResponse(completion([]), lines), /格式不正确/)
})

test('requests lyrics in bounded batches and stops queued batches after the selection is left', async () => {
  const connection = getLyricStudyConnection(normalizeLyricStudySettings({
    enabled: true, provider: 'custom', baseUrl: 'https://example.com/v1', model: 'mock',
  }))
  const controller = new AbortController()
  const lines = Array.from({ length: 17 }, (_, id) => lyric(id, `Line ${id}`))
  let requests = 0
  await assert.rejects(analyzeLyrics(lines, connection, '', async (request) => {
    requests += 1
    assert.equal(request.url, 'https://example.com/v1/chat/completions')
    assert.equal(request.headers.Authorization, undefined)
    const body = JSON.parse(request.bodyText)
    assert.equal(body.model, 'mock')
    assert.equal(body.stream, false)
    assert.deepEqual(JSON.parse(body.messages[1].content).lines, lines.slice(0, 16))
    controller.abort()
    return { statusCode: 200, bodyText: '' }
  }, controller.signal), { name: 'AbortError' })
  assert.equal(requests, 1)
})
