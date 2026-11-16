import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import { decodeKuwoLyrics } from '../src/lib/kuwoLyrics.ts'

const response = (text, enhanced) => {
  let content = Buffer.from(text)
  if (enhanced) {
    const key = Buffer.from('yeelion')
    content = Buffer.from(content.map((byte, index) => byte ^ key[index % key.length]))
    content = Buffer.from(content.toString('base64'))
  }
  return Buffer.concat([
    Buffer.from(`TP=content\r\nlrcx=${enhanced ? 1 : 0}\r\n\r\n`),
    deflateSync(content),
  ]).toString('base64')
}

test('decodes plain LRC returned despite requesting enhanced lyrics', () => {
  const lyrics = decodeKuwoLyrics(response(
    '[ti:测试]\n[00:00.73]开场\n[03:44.13][00:08.99]重复歌词\n',
    false,
  ))
  assert.deepEqual(lyrics, {
    lyric: '[00:00.73]开场\n[03:44.13]重复歌词\n[00:08.99]重复歌词',
    tlyric: '',
  })
})

test('normalizes colon fractions used by instrumental notices', () => {
  const lyrics = decodeKuwoLyrics(response('[00:00:00]纯音乐，请欣赏\n', false))
  assert.equal(lyrics.lyric, '[00:00.00]纯音乐，请欣赏')
})

test('keeps enhanced lyrics and translations while removing word timing', () => {
  const lyrics = decodeKuwoLyrics(response(
    '[ti:测试]\n[00:01.000]<0,500>原<500,500>文\n[00:01.000]Translation\n[00:02.000]<-100,500>下一行\n',
    true,
  ))
  assert.deepEqual(lyrics, {
    lyric: '[00:01.000]原文\n[00:02.000]下一行',
    tlyric: '[00:01.000]Translation',
  })
})

test('rejects invalid responses and lyrics without timed content', () => {
  assert.throws(() => decodeKuwoLyrics(Buffer.from('unavailable').toString('base64')), /响应格式/)
  assert.throws(() => decodeKuwoLyrics(response('[ti:测试]\n', false)), /内容为空/)
})
