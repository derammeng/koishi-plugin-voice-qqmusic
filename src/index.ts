
# 生成修复后的 index.ts 文件
fixed_code = '''// src/index.ts
/**
 * Koishi 插件 - QQ 音乐点歌
 * 支持搜索、播放、歌词显示、图片列表、自定义消息格式等
 */

import { Context, Schema, Service, h, Session, Logger, Dict } from 'koishi'
import axios from 'axios'
import * as fs from 'fs/promises'
import * as path from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

// 声明模块扩展，使 ctx.qqMusic 可用
declare module 'koishi' {
  interface Context {
    qqMusic: QQMusicService
    puppeteer?: any  // 添加 puppeteer 类型声明
  }
}

// ---------- 工具函数 ----------

/**
 * 模板变量替换
 */
function formatTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\\{\\{(\\w+)\\}\\}/g, (match, key) => vars[key] ?? match)
}

/**
 * 下载文件（流式）
 */
async function downloadFile(url: string, filePath: string, timeout: number = 30000): Promise<void> {
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  })
  
  const writer = await fs.open(filePath, 'w')
  try {
    const writeStream = writer.createWriteStream()
    await pipeline(Readable.from(response.data), writeStream)
  } finally {
    await writer.close()
  }
}

/**
 * HTML 转义
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * 格式化时间（秒 -> mm:ss）
 */
function formatTime(s: number): string {
  const minutes = Math.floor(s / 60)
  const seconds = Math.floor(s % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/**
 * 生成搜索结果图片的 HTML
 */
function buildSongListHTML(songs: SongInfo[], keyword: string): string {
  const items = songs.map((song, idx) => `
    <div class="song-item">
      <div class="number">${idx + 1}</div>
      <div class="info">
        <div class="title">${escapeHtml(song.name)} ${song.payInfo?.pay_play ? '💎' : ''} ${song.quality >= 320 ? '🔥' : ''}</div>
        <div class="meta">🎤 ${escapeHtml(song.singer)} | 💿 ${escapeHtml(song.album)} | ⏱️ ${formatTime(song.duration)}</div>
      </div>
    </div>
  `).join('')

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px;
      min-height: 100vh;
    }
    .container {
      max-width: 700px;
      margin: 0 auto;
      background: rgba(255, 255, 255, 0.95);
      border-radius: 20px;
      padding: 30px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .header {
      text-align: center;
      margin-bottom: 25px;
      padding-bottom: 20px;
      border-bottom: 2px solid #eee;
    }
    .header h1 {
      color: #333;
      font-size: 28px;
      margin-bottom: 10px;
    }
    .header .keyword {
      color: #667eea;
      font-size: 18px;
    }
    .song-item {
      display: flex;
      align-items: center;
      padding: 15px;
      margin: 10px 0;
      background: #f8f9fa;
      border-radius: 12px;
      transition: all 0.3s;
    }
    .song-item:hover {
      background: #e9ecef;
      transform: translateX(5px);
    }
    .number {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 18px;
      margin-right: 15px;
      flex-shrink: 0;
    }
    .info {
      flex: 1;
    }
    .title {
      font-size: 18px;
      font-weight: 600;
      color: #333;
      margin-bottom: 5px;
    }
    .meta {
      font-size: 14px;
      color: #666;
    }
    .footer {
      text-align: center;
      margin-top: 25px;
      padding-top: 20px;
      border-top: 2px solid #eee;
      color: #999;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎵 QQ 音乐搜索结果</h1>
      <div class="keyword">关键词：${escapeHtml(keyword)}</div>
    </div>
    ${items}
    <div class="footer">
      回复数字 1-${songs.length} 选择歌曲，回复 0 取消
    </div>
  </div>
</body>
</html>
  `
}

/**
 * 将 HTML 转为图片
 */
async function htmlToImage(html: string, outputPath: string, ctx: Context): Promise<string | null> {
  if (!ctx.puppeteer) {
    ctx.logger.warn('puppeteer 服务未找到，无法生成图片')
    return null
  }
  
  let page: any
  try {
    page = await ctx.puppeteer.page()
    await page.setViewport({ width: 800, height: 600 })
    await page.setContent(html, { waitUntil: 'networkidle0' })

    const bodyHandle = await page.$('body')
    if (!bodyHandle) return null
    
    const { height } = await bodyHandle.boundingBox() || { height: 600 }
    await bodyHandle.dispose()
    await page.setViewport({ width: 800, height: Math.ceil(height) + 20 })

    await page.screenshot({ path: outputPath, fullPage: true })
    return outputPath
  } catch (error) {
    ctx.logger.error('生成图片失败:', error)
    return null
  } finally {
    if (page) await page.close().catch(() => {})
  }
}

// ---------- 类型定义 ----------

interface RawSong {
  mid: string
  name: string
  singer: Array<{ name: string }>
  album?: { name: string }
  interval: number
  id: number
  pay?: any
  file?: {
    size_128mp3?: number
    size_320mp3?: number
    size_flac?: number
  }
}

interface VkeyResponse {
  req_0?: {
    data?: {
      midurlinfo?: Array<{
        purl: string
      }>
    }
  }
}

interface LyricResponse {
  lyric?: string
}

// 修正 PlaylistResponse 以匹配实际 API 返回的两层 data 结构
interface PlaylistResponse {
  data?: {
    data?: {
      disslist?: Array<{
        diss_name: string
        song_cnt: number
      }>
    }
  }
}

interface SongInfo {
  mid: string
  name: string
  singer: string
  album: string
  duration: number
  songId: number
  payInfo: any
  quality: number
}

// ---------- QQMusicService ----------

class QQMusicService extends Service {
  private serviceConfig: QQMusicServiceConfig
  private cacheDir: string
  private tempDir: string
  private guid: string
  private serviceLogger: Logger  // 重命名避免冲突

  private static readonly MAX_CONCURRENT = 3
  private currentDownloads = 0
  private downloadQueue: Array<() => void> = []

  constructor(ctx: Context, config: QQMusicServiceConfig) {
    super(ctx, 'qqMusic', true)
    this.serviceConfig = config
    this.serviceLogger = ctx.logger('qq-music')
    this.guid = this.generateGuid()
    this.cacheDir = path.join(ctx.baseDir, 'data', 'music-qq', 'cache')
    this.tempDir = path.join(ctx.baseDir, 'data', 'music-qq', 'temp')

    // 创建目录（不等待，允许异步完成）
    this.createDirectories().catch((err: any) => {
      this.serviceLogger.error('创建目录失败:', err)
    })
  }

  static inject = ['http']

  private generateGuid(): string {
    return Math.floor(Math.random() * 2147483647).toString()
  }

  private extractUin(): string {
    const match = this.serviceConfig.cookie.match(/uin=o(\\d+)/)
    return match ? match[1] : this.serviceConfig.uin
  }

  private async createDirectories(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.cacheDir, { recursive: true }),
      fs.mkdir(this.tempDir, { recursive: true })
    ])
  }

  async cleanCache(): Promise<void> {
    try {
      const now = Date.now()
      const expireTime = this.serviceConfig.cacheExpire * 3600000

      const dirs = [this.cacheDir, this.tempDir]
      for (const dir of dirs) {
        const files = await fs.readdir(dir).catch(() => [] as string[])
        for (const file of files) {
          const filePath = path.join(dir, file)
          try {
            const stats = await fs.stat(filePath)
            if (now - stats.mtimeMs > expireTime) {
              await fs.unlink(filePath)
              this.serviceLogger.info('清理过期缓存文件:', file)
            }
          } catch {
            // 忽略单个文件错误
          }
        }
      }
    } catch (error) {
      this.serviceLogger.error('清理缓存失败:', error)
    }
  }

  async search(keyword: string, limit: number = 5): Promise<SongInfo[]> {
    const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'

    const params = {
      ct: 24,
      qqmusic_ver: 1298,
      new_json: 1,
      remoteplace: 'txt.yqq.center',
      searchid: Math.floor(Math.random() * 1000000000),
      t: 0,
      aggr: 1,
      cr: 1,
      catZhida: 1,
      lossless: 0,
      flag_qc: 0,
      p: 1,
      n: limit,
      w: keyword,
      g_tk: 5381,
      jsonpCallback: 'MusicJsonCallback',
      loginUin: this.extractUin(),
      hostUin: 0,
      format: 'json',
      inCharset: 'utf8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq',
      needNewCode: 0
    }

    try {
      const { data } = await this.ctx.http.get(url, {
        params,
        headers: {
          'Referer': 'https://y.qq.com',
          'Cookie': this.serviceConfig.cookie,
          'User-Agent': this.serviceConfig.userAgent
        }
      })

      const jsonStr = data.replace(/MusicJsonCallback\\(|\\)$/g, '')
      const result = JSON.parse(jsonStr)

      if (!result.data?.song?.list) {
        return []
      }

      return result.data.song.list.map((song: RawSong) => ({
        mid: song.mid,
        name: song.name,
        singer: song.singer.map(s => s.name).join('/'),
        album: song.album?.name || '未知专辑',
        duration: song.interval,
        songId: song.id,
        payInfo: song.pay || {},
        quality: this.getSongQuality(song.file)
      }))
    } catch (error) {
      this.serviceLogger.error('搜索失败:', error)
      throw new Error('搜索歌曲失败')
    }
  }

  private getSongQuality(file?: RawSong['file']): number {
    if (!file) return 0
    if (file.size_flac) return 999
    if (file.size_320mp3) return 320
    if (file.size_128mp3) return 128
    return 0
  }

  async getPlayUrl(songMid: string, quality?: number): Promise<{ url: string | null; type: 'success' | 'vip' | 'error'; quality: number }> {
    try {
      const guid = this.guid
      const uin = this.extractUin()

      const vkeyUrl = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
      const vkeyData = {
        req: {
          module: 'CDN.SrfCdnDispatchServer',
          method: 'GetCdnDispatch',
          param: { guid, calltype: 0, userip: '' }
        },
        req_0: {
          module: 'vkey.GetVkeyServer',
          method: 'CgiGetVkey',
          param: {
            guid,
            songmid: [songMid],
            songtype: [0],
            uin,
            loginflag: 1,
            platform: '20'
          }
        },
        comm: { uin, format: 'json', ct: 24, cv: 0 }
      }

      const { data } = await this.ctx.http.post(vkeyUrl, vkeyData, {
        headers: {
          'Content-Type': 'application/json',
          'Cookie': this.serviceConfig.cookie,
          'Referer': 'https://y.qq.com',
          'User-Agent': this.serviceConfig.userAgent
        }
      }) as { data: VkeyResponse }

      const midUrlInfo = data.req_0?.data?.midurlinfo?.[0]
      if (!midUrlInfo || !midUrlInfo.purl) {
        return { url: null, type: 'vip', quality: 0 }
      }

      const url = `https://isure.stream.qqmusic.qq.com/${midUrlInfo.purl}`
      const actualQuality = this.getUrlQuality(midUrlInfo.purl)

      return { url, type: 'success', quality: actualQuality }
    } catch (error) {
      this.serviceLogger.error('获取播放链接失败:', error)
      return { url: null, type: 'error', quality: 0 }
    }
  }

  private getUrlQuality(purl: string): number {
    if (purl.includes('F000')) return 999
    if (purl.includes('M800')) return 320
    return 128
  }

  async downloadSong(songMid: string, songName: string, quality?: number): Promise<string | null> {
    // 并发控制
    if (this.currentDownloads >= QQMusicService.MAX_CONCURRENT) {
      await new Promise<void>(resolve => this.downloadQueue.push(resolve))
    }
    this.currentDownloads++

    try {
      await this.cleanCache()

      const { url, type } = await this.getPlayUrl(songMid, quality)
      if (!url) {
        this.serviceLogger.debug(type === 'vip' ? `VIP 歌曲无法下载: ${songName}` : `获取播放链接失败: ${songName}`)
        return null
      }

      const fileName = `${songMid}_${Date.now()}.mp3`
      const filePath = path.join(this.cacheDir, fileName)

      await downloadFile(url, filePath, this.serviceConfig.requestTimeout)

      const stats = await fs.stat(filePath)
      if (stats.size < 102400) {
        await fs.unlink(filePath)
        this.serviceLogger.debug(`下载文件过小，已删除: ${fileName}`)
        return null
      }

      this.serviceLogger.debug(`歌曲下载成功: ${songName} -> ${fileName}`)
      return filePath
    } catch (error) {
      this.serviceLogger.error('下载歌曲失败:', error)
      return null
    } finally {
      this.currentDownloads--
      // 触发队列中的下一个
      const next = this.downloadQueue.shift()
      next?.()
    }
  }

  async getLyrics(songMid: string, showTimestamp: boolean = false): Promise<string | null> {
    try {
      const url = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg'
      const params = {
        songmid: songMid,
        pcachetime: Date.now(),
        g_tk: 5381,
        loginUin: this.extractUin(),
        hostUin: 0,
        format: 'json',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: 0,
        platform: 'yqq.json',
        needNewCode: 0
      }

      const { data } = await this.ctx.http.get(url, {
        params,
        headers: {
          'Referer': 'https://y.qq.com',
          'Cookie': this.serviceConfig.cookie
        }
      })

      const jsonStr = data.replace(/MusicJsonCallback\\(|\\)$/g, '')
      const result = JSON.parse(jsonStr) as LyricResponse

      if (result.lyric) {
        let lyrics = Buffer.from(result.lyric, 'base64').toString('utf-8')
        if (!showTimestamp) {
          lyrics = lyrics.replace(/\\[\\d{2}:\\d{2}\\.\\d{2,3}\\]/g, '').trim()
        }
        return lyrics
      }
      return null
    } catch (error) {
      this.serviceLogger.error('获取歌词失败:', error)
      return null
    }
  }

  async getUserPlaylists(): Promise<Array<{ name: string; count: number }>> {
    const uin = this.extractUin()
    const url = 'https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss'

    const params = {
      cv: 10000, ct: 24, format: 'json',
      inCharset: 'utf-8', outCharset: 'utf-8',
      notice: 0, platform: 'yqq.json', needNewCode: 0,
      uin, hostUin: uin, sin: 0, ein: 19, sort: 2, g_tk: 5381
    }

    try {
      const { data } = await this.ctx.http.get(url, {
        params,
        headers: { 'Cookie': this.serviceConfig.cookie, 'Referer': 'https://y.qq.com' }
      }) as { data: PlaylistResponse }

      // 根据修正后的 PlaylistResponse，需要访问 data.data?.disslist
      const list = data.data?.data?.disslist || []
      return list.map(item => ({
        name: item.diss_name,
        count: item.song_cnt
      }))
    } catch (error) {
      this.serviceLogger.error('获取歌单失败:', error)
      return []
    }
  }
}

// ---------- 命名空间类型 ----------

interface QQMusicServiceConfig {
  cookie: string
  uin: string
  defaultQuality: number
  cacheExpire: number
  userAgent: string
  requestTimeout: number
}

// ---------- 配置 Schema ----------

const LyricsConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('发送歌词'),
  maxLength: Schema.number().default(500).min(0).max(3000).description('歌词最大长度（0为不限制）'),
  format: Schema.string().role('textarea').default('📜 歌词：\\n{{lyrics}}').description('歌词格式模板'),
  showTimestamp: Schema.boolean().default(false).description('显示时间戳'),
  truncateText: Schema.string().default('...').description('截断提示文本'),
})

const SongInfoConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('发送歌曲信息'),
  format: Schema.string().role('textarea').default(
`{{prefix}} {{name}}
🎤 歌手：{{singer}}
💿 专辑：{{album}}
⏱️ 时长：{{duration}}
{{quality}}
{{suffix}}`
  ).description('歌曲信息格式模板'),
  separator: Schema.string().default('──────────').description('分隔线样式'),
  showSeparator: Schema.boolean().default(true).description('显示分隔线'),
})

const VoiceConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('发送语音'),
  sendFirst: Schema.boolean().default(true).description('语音优先发送（先于文字）'),
  atSender: Schema.boolean().default(true).description('语音 @ 点歌者'),
  timeout: Schema.number().default(30).min(5).max(120).description('语音超时（秒）'),
  quality: Schema.union([
    Schema.const(128).description('标准 128kbps'),
    Schema.const(320).description('高品质 320kbps'),
    Schema.const(999).description('无损 FLAC')
  ]).default(128).description('语音音质'),
})

const MessageFormatConfig = Schema.intersect([
  Schema.object({ voice: VoiceConfig }).description('语音消息'),
  Schema.object({ songInfo: SongInfoConfig }).description('歌曲信息'),
  Schema.object({ lyrics: LyricsConfig }).description('歌词设置'),
  Schema.object({
    globalPrefix: Schema.string().default('').description('全局前缀'),
    globalSuffix: Schema.string().default('').description('全局后缀'),
    combineMessages: Schema.boolean().default(true).description('合并为单条消息（语音除外）'),
    messageDelay: Schema.number().default(500).min(0).max(5000).description('消息间隔（毫秒）'),
  }).description('全局设置'),
])

const GroupConfig = Schema.intersect([
  Schema.object({ enabled: Schema.boolean().default(true).description('在群聊中启用点歌功能') }).description('基础设置'),
  Schema.object({
    maxResults: Schema.number().default(5).min(1).max(20).description('搜索结果数量'),
    imageMode: Schema.boolean().default(true).description('图片展示搜索结果'),
    imageFallback: Schema.boolean().default(true).description('图片失败回退文字'),
  }).description('搜索设置'),
  Schema.object({ messageFormat: MessageFormatConfig }).description('消息格式'),
  Schema.object({
    cooldown: Schema.number().default(10).min(0).max(300).description('冷却时间（秒）'),
    allowAnonymous: Schema.boolean().default(false).description('允许匿名用户'),
    maxDuration: Schema.number().default(600).min(0).description('最大时长（秒，0无限制）'),
    vipTip: Schema.boolean().default(true).description('VIP 歌曲提示'),
  }).description('限制设置'),
])

const PrivateConfig = Schema.intersect([
  Schema.object({ enabled: Schema.boolean().default(true).description('在私聊中启用点歌功能') }).description('基础设置'),
  Schema.object({
    maxResults: Schema.number().default(10).min(1).max(30).description('搜索结果数量'),
    imageMode: Schema.boolean().default(true).description('图片展示搜索结果'),
    imageFallback: Schema.boolean().default(true).description('图片失败回退文字'),
  }).description('搜索设置'),
  Schema.object({ messageFormat: MessageFormatConfig }).description('消息格式'),
  Schema.object({
    cooldown: Schema.number().default(0).min(0).max(300).description('冷却时间（秒）'),
    maxDaily: Schema.number().default(50).min(0).description('每日最大次数（0无限制）'),
    vipTip: Schema.boolean().default(true).description('VIP 歌曲提示'),
  }).description('限制设置'),
])

const SearchConfig = Schema.object({
  searchTimeout: Schema.number().default(10000).min(5000).max(30000).description('搜索超时（毫秒）'),
  retryTimes: Schema.number().default(3).min(1).max(5).description('失败重试次数'),
  fuzzyMatch: Schema.boolean().default(true).description('模糊匹配'),
})

const AdvancedConfig = Schema.object({
  debug: Schema.boolean().default(false).description('调试日志'),
  cacheCleanInterval: Schema.number().default(24).min(1).max(168).description('缓存清理间隔（小时）'),
  cacheExpire: Schema.number().default(24).min(1).max(168).description('缓存过期（小时）'),
  requestTimeout: Schema.number().default(30000).min(10000).max(60000).description('请求超时（毫秒）'),
  userAgent: Schema.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36').description('User-Agent'),
})

// 简化 Config 类型定义
export interface Config {
  cookie: string
  uin: string
  defaultQuality: number
  group: any  // 使用 any 避免复杂类型推导问题
  private: any
  search: any
  advanced: any
  adminUsers: string[]
  blacklist: string[]
  whitelist: string[]
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    cookie: Schema.string().role('textarea').required().description('QQ 音乐 Cookie（需登录态）'),
    uin: Schema.string().required().description('QQ 号码'),
    defaultQuality: Schema.union([
      Schema.const(128).description('标准 128kbps'),
      Schema.const(320).description('高品质 320kbps'),
      Schema.const(999).description('无损 FLAC')
    ]).default(128).description('默认音质'),
  }).description('账号配置'),

  Schema.object({ group: GroupConfig }).description('群聊设置'),
  Schema.object({ private: PrivateConfig }).description('私聊设置'),
  Schema.object({ search: SearchConfig }).description('搜索设置'),
  Schema.object({ advanced: AdvancedConfig }).description('高级设置'),

  Schema.object({
    adminUsers: Schema.array(Schema.string()).default([]).description('管理员列表（用户ID）'),
    blacklist: Schema.array(Schema.string()).default([]).description('黑名单用户ID'),
    whitelist: Schema.array(Schema.string()).default([]).description('白名单用户ID（为空则不启用）'),
  }).description('权限设置'),
])

export const name = 'koishi-plugin-voice-qqmusic'
export const inject = ['http', 'puppeteer?']

// ---------- 全局状态 ----------
const cooldowns = new Map<string, number>()
const dailyLimits = new Map<string, { count: number; date: string }>()
const userLocks = new Set<string>()

// 定期清理过期冷却数据（每24小时）
setInterval(() => {
  const now = Date.now()
  const todayStr = new Date().toDateString()
  
  // 清理超过24小时的冷却记录
  for (const [key, time] of cooldowns) {
    if (now - time > 86400000) {
      cooldowns.delete(key)
    }
  }
  
  // 清理过期的每日限制
  for (const [key, record] of dailyLimits) {
    if (record.date !== todayStr) {
      dailyLimits.delete(key)
    }
  }
}, 86400000)

// ---------- 插件入口 ----------
export function apply(ctx: Context, config: Config) {
  // 注册服务
  ctx.plugin(QQMusicService, {
    cookie: config.cookie,
    uin: config.uin,
    defaultQuality: config.defaultQuality,
    cacheExpire: config.advanced?.cacheExpire ?? 24,
    userAgent: config.advanced?.userAgent ?? 'Mozilla/5.0',
    requestTimeout: config.advanced?.requestTimeout ?? 30000
  })

  // 定时清理缓存
  const cleanInterval = setInterval(() => {
    ctx.qqMusic?.cleanCache()
  }, (config.advanced?.cacheCleanInterval ?? 24) * 3600000)
  
  ctx.on('dispose', () => {
    clearInterval(cleanInterval)
    // 清理所有临时文件
    const tempDir = path.join(ctx.baseDir, 'data', 'music-qq', 'temp')
    fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  // ---------- 辅助函数 ----------

  function isGroup(session: Session): boolean {
    return !!session.guildId
  }

  function getEnvConfig(session: Session) {
    return isGroup(session) ? config.group : config.private
  }

  function getMessageFormat(session: Session) {
    return getEnvConfig(session)?.messageFormat
  }

  function isAdmin(session: Session): boolean {
    return config.adminUsers?.includes(session.userId) || (session.user?.authorities?.includes(4) ?? false)
  }

  function checkCooldown(session: Session): boolean {
    if (isAdmin(session)) return true

    const env = getEnvConfig(session)
    const key = `${isGroup(session) ? 'g' : 'p'}:${session.userId}`
    const now = Date.now()
    const last = cooldowns.get(key)
    const cd = (env?.cooldown ?? 0) * 1000

    if (last && now - last < cd) {
      const wait = Math.ceil((cd - (now - last)) / 1000)
      session.send(`⏳ 请等待 ${wait} 秒`).catch(() => {})
      return false
    }

    cooldowns.set(key, now)
    return true
  }

  function checkDailyLimit(session: Session): boolean {
    if (isAdmin(session) || isGroup(session)) return true

    const maxDaily = config.private?.maxDaily ?? 0
    if (maxDaily === 0) return true

    const key = `daily:${session.userId}`
    const today = new Date().toDateString()
    const record = dailyLimits.get(key)

    if (!record || record.date !== today) {
      dailyLimits.set(key, { count: 1, date: today })
      return true
    }

    if (record.count >= maxDaily) {
      session.send(`❌ 今日已达上限 (${maxDaily} 次)`).catch(() => {})
      return false
    }

    record.count++
    return true
  }

  function checkPermission(session: Session): boolean {
    const userId = session.userId

    if (config.blacklist?.includes(userId)) {
      session.send('❌ 你已被列入黑名单').catch(() => {})
      return false
    }

    if (config.whitelist?.length > 0 && !config.whitelist?.includes(userId)) {
      session.send('❌ 你不在白名单中').catch(() => {})
      return false
    }

    return true
  }

  function buildSongInfoMessage(song: SongInfo, format: any): string {
    if (!format?.enabled) return ''

    const qualityText = song.quality >= 999 ? '🔥 无损音质' :
                       song.quality >= 320 ? '🔥 高品质音质' :
                       song.quality >= 128 ? '🎵 标准音质' : ''

    const vipText = song.payInfo?.pay_play ? '💎 VIP 专享' : ''

    const vars = {
      prefix: '',
      name: song.name,
      singer: song.singer,
      album: song.album,
      duration: formatTime(song.duration),
      quality: qualityText,
      vip: vipText,
      suffix: '',
    }

    let message = formatTemplate(format.format, vars)

    if (format.showSeparator && format.separator) {
      message += '\\n' + format.separator
    }

    return message
  }

  function buildLyricsMessage(lyrics: string, format: any): string {
    if (!format?.enabled || !lyrics) return ''

    let processedLyrics = lyrics
    if (format.maxLength > 0 && lyrics.length > format.maxLength) {
      processedLyrics = lyrics.substring(0, format.maxLength) + format.truncateText
    }

    return formatTemplate(format.format, { lyrics: processedLyrics })
  }

  async function sendSearchResult(session: Session, songs: SongInfo[], keyword: string): Promise<boolean> {
    const env = getEnvConfig(session)

    if (env?.imageMode) {
      try {
        const html = buildSongListHTML(songs, keyword)
        const imagePath = path.join(ctx.qqMusic['tempDir'], `list_${Date.now()}.png`)
        const result = await htmlToImage(html, imagePath, ctx)

        if (result) {
          await session.send(h.image('file://' + result))
          return true
        }
      } catch (e) {
        if (config.advanced?.debug) ctx.logger.error('图片生成失败:', e)
        if (!env?.imageFallback) return false
      }
    }

    // 文字列表
    const list = songs.map((s, i) => {
      const icon = s.payInfo?.pay_play ? '💎' : '🎵'
      const quality = s.quality >= 320 ? '🔥' : ''
      return `${i + 1}. ${icon}${quality} ${s.name}\\n   🎤 ${s.singer} | 💿 ${s.album} | ⏱️ ${formatTime(s.duration)}`
    }).join('\\n\\n')

    await session.send(`🎼 找到以下歌曲：\\n${list}\\n\\n回复数字选择，0取消`)
    return true
  }

  async function playSong(session: Session, song: SongInfo, quality?: number): Promise<string | undefined> {
    const env = getEnvConfig(session)
    const format = getMessageFormat(session)
    const isGroupChat = isGroup(session)

    // 时长检查（仅群聊）
    if (isGroupChat && env?.maxDuration > 0 && song.duration > env.maxDuration) {
      return `❌ 歌曲过长（限制 ${formatTime(env.maxDuration)}）`
    }

    // 用户级并发锁（防止同一用户重复点击）
    const lockKey = `${session.userId}:${song.mid}`
    if (userLocks.has(lockKey)) {
      return '⏳ 正在处理中，请稍候...'
    }
    userLocks.add(lockKey)

    try {
      await session.send(`⏳ 正在准备：${song.name}...`)

      const actualQuality = quality || format?.voice?.quality || config.defaultQuality
      const filePath = await ctx.qqMusic.downloadSong(song.mid, song.name, actualQuality)

      if (!filePath) {
        const { type } = await ctx.qqMusic.getPlayUrl(song.mid)
        if (type === 'vip' && env?.vipTip) {
          return '💎 该歌曲为 VIP 专享，请开通会员后播放'
        }
        return '❌ 歌曲下载失败，可能是版权受限或链接失效'
      }

      // 获取歌词（异步）
      const lyricsPromise = format?.lyrics?.enabled
        ? ctx.qqMusic.getLyrics(song.mid, format.lyrics.showTimestamp)
        : Promise.resolve(null)

      // 1. 发送语音（如果启用且优先）
      if (format?.voice?.enabled && format.voice.sendFirst) {
        try {
          const atPrefix = isGroupChat && format.voice.atSender ? h.at(session.userId) + ' ' : ''
          await session.send(atPrefix + h('record', {
            file: 'file://' + filePath,
            timeout: format.voice.timeout * 1000
          }))
        } catch (e) {
          if (config.advanced?.debug) ctx.logger.error('语音发送失败:', e)
        }
      }

      // 2. 构建并发送文字消息
      const lyrics = await lyricsPromise
      const messages: string[] = []

      if (format?.globalPrefix) messages.push(format.globalPrefix)

      const songInfo = buildSongInfoMessage(song, format?.songInfo)
      if (songInfo) messages.push(songInfo)

      const lyricsMsg = buildLyricsMessage(lyrics, format?.lyrics)
      if (lyricsMsg) messages.push(lyricsMsg)

      if (format?.globalSuffix) messages.push(format.globalSuffix)

      if (format?.combineMessages && messages.length > 0) {
        await session.send(messages.join('\\n\\n'))
      } else {
        for (const msg of messages) {
          if (msg) {
            await session.send(msg)
            if (format?.messageDelay > 0) {
              await new Promise(r => setTimeout(r, format.messageDelay))
            }
          }
        }
      }

      // 3. 发送语音（如果启用且不优先）
      if (format?.voice?.enabled && !format.voice.sendFirst) {
        try {
          const atPrefix = isGroupChat && format.voice.atSender ? h.at(session.userId) + ' ' : ''
          await session.send(atPrefix + h('record', {
            file: 'file://' + filePath,
            timeout: format.voice.timeout * 1000
          }))
        } catch (e) {
          if (config.advanced?.debug) ctx.logger.error('语音发送失败:', e)
        }
      }

      return undefined
    } catch (err) {
      ctx.logger.error('播放失败:', err)
      return '❌ 播放失败，请稍后重试'
    } finally {
      userLocks.delete(lockKey)
    }
  }

  // ---------- 命令定义 ----------

  const musicCmd = ctx.command('点歌 <keyword:text>', '搜索并播放 QQ 音乐')
    .alias('qq点歌', 'music')
    .option('n', '-n <num:number>', { fallback: 1, description: '直接选择第几首' })
    .option('q', '-q <quality:number>', { fallback: 0, description: '指定音质(128/320/999)' })

  // 使用 before 中间件进行权限检查
  musicCmd.before('check', (session) => {
    if (!checkPermission(session)) return ''
    if (!checkCooldown(session)) return ''
    if (!checkDailyLimit(session)) return ''
    
    const env = getEnvConfig(session)
    if (!env?.enabled) {
      // 根据环境返回明确提示
      return isGroup(session) ? '❌ 群聊点歌功能已关闭' : '❌ 私聊点歌功能已关闭'
    }
    
    if (isGroup(session) && !env?.allowAnonymous && session.author?.anonymous) {
      return '❌ 匿名用户无法点歌'
    }
    return undefined
  })

  musicCmd.action(async ({ session, options }, keyword) => {
    if (!keyword) return '请输入歌曲名，如：点歌 周杰伦 晴天'

    const env = getEnvConfig(session)

    await session.send('🔍 搜索中...')

    try {
      let songs: SongInfo[] = []
      const retryTimes = config.search?.retryTimes ?? 3
      for (let i = 0; i < retryTimes; i++) {
        try {
          songs = await ctx.qqMusic.search(keyword, env?.maxResults ?? 5)
          if (songs.length > 0) break
        } catch (e) {
          if (i === retryTimes - 1) throw e
          await new Promise(r => setTimeout(r, 1000))
        }
      }

      if (songs.length === 0) {
        return config.search?.fuzzyMatch === false ? '❌ 未找到精确匹配' : '❌ 未找到相关歌曲'
      }

      // 直接播放指定序号
      const n = options?.n ?? 0
      if (n > 0 && n <= songs.length) {
        return await playSong(session, songs[n - 1], options?.q) ?? ''
      }
      
      if (n > songs.length) {
        return `❌ 只有 ${songs.length} 首结果`
      }

      // 发送列表等待选择
      const listSent = await sendSearchResult(session, songs, keyword)
      if (!listSent) return '❌ 发送失败'

      try {
        const res = await session.prompt(60000)
        if (!res || res === '0') return '已取消'

        const selectNum = parseInt(res)
        if (isNaN(selectNum) || selectNum < 1 || selectNum > songs.length) {
          return '❌ 无效选择'
        }

        const result = await playSong(session, songs[selectNum - 1], options?.q)
        return result ?? ''
      } catch (promptErr) {
        // prompt 超时或失败
        return '⏰ 选择超时，请重新点歌'
      }
    } catch (err) {
      ctx.logger.error('点歌失败:', err)
      return '❌ 搜索失败，请检查配置'
    }
  })

  // 查看歌单
  ctx.command('我的歌单', '查看 QQ 音乐歌单').action(async ({ session }) => {
    try {
      const list = await ctx.qqMusic.getUserPlaylists()
      if (list.length === 0) return '📂 没有找到歌单'
      return '📚 我的歌单：\\n' + list.map((p, i) =>
        `${i + 1}. ${p.name} (${p.count}首)`
      ).join('\\n')
    } catch (error) {
      return '❌ 获取歌单失败'
    }
  })

  // 点歌状态（管理员）
  ctx.command('点歌状态', '查看点歌系统状态').action(async ({ session }) => {
    if (!isAdmin(session)) return '❌ 无权使用'

    try {
      const files = await fs.readdir(ctx.qqMusic['cacheDir']).catch(() => [] as string[])
      let size = 0
      for (const file of files) {
        try {
          const stat = await fs.stat(path.join(ctx.qqMusic['cacheDir'], file))
          size += stat.size
        } catch { }
      }

      return [
        '📊 系统状态',
        `缓存文件: ${files.length} 个`,
        `缓存大小: ${(size / 1024 / 1024).toFixed(1)} MB`,
        `群聊: ${config.group?.enabled ? '✅' : '❌'}`,
        `私聊: ${config.private?.enabled ? '✅' : '❌'}`,
      ].join('\\n')
    } catch (error) {
      return '❌ 读取状态失败'
    }
  })

  // 清理缓存（管理员）
  ctx.command('清理音乐缓存', '手动清理过期缓存').action(async ({ session }) => {
    if (!isAdmin(session)) return '❌ 无权使用'
    await ctx.qqMusic.cleanCache()
    return '✅ 缓存清理完成'
  })
}
'''

# 保存到文件
with open('/mnt/kimi/output/index_fixed.ts', 'w', encoding='utf-8') as f:
    f.write(fixed_code)

print("修复后的文件已生成！")
print("主要修复：")
print("1. 添加了 puppeteer 类型声明到 Context 模块")
print("2. 将 logger 重命名为 serviceLogger 避免与 Service 基类冲突")
print("3. 将 config 重命名为 serviceConfig 避免参数名冲突")
print("4. 简化 Config 接口类型，使用 any 避免复杂 Schema 推导问题")
print("5. 添加可选链操作符 ?. 处理可能的 undefined 值")
print("6. 将 desc 改为 description（Koishi API 变更）")
print("7. 修复了 || 和 ?? 混合使用的问题")
