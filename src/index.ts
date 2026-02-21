// src/index.ts
import { Context, Schema, Service, h, Session } from 'koishi'
import axios from 'axios'
import * as fs from 'fs'
import * as path from 'path'
import { promisify } from 'util'
import { pipeline } from 'stream'

const streamPipeline = promisify(pipeline)

declare module 'koishi' {
  interface Context {
    qqMusic: QQMusicService
  }
}

// 模板变量替换
function formatTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] || match)
}

// 下载文件
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
  const writer = fs.createWriteStream(filePath)
  await streamPipeline(response.data, writer)
}

// 构建搜索结果图片HTML
function buildSongListHTML(songs: QQMusicService.SongInfo[], keyword: string): string {
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function formatTime(s: number): string {
  return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`
}

async function htmlToImage(html: string, outputPath: string, ctx: Context): Promise<string | null> {
  try {
    if (!ctx['puppeteer']) {
      ctx.logger.warn('puppeteer 服务未找到')
      return null
    }
    
    const page = await ctx['puppeteer'].page()
    await page.setViewport({ width: 800, height: 600 })
    await page.setContent(html, { waitUntil: 'networkidle0' })
    
    const bodyHandle = await page.$('body')
    const { height } = await bodyHandle.boundingBox()
    await page.setViewport({ width: 800, height: Math.ceil(height) + 20 })
    
    await page.screenshot({ path: outputPath, fullPage: true })
    await page.close()
    
    return outputPath
  } catch (error) {
    ctx.logger.error('生成图片失败:', error)
    return null
  }
}

class QQMusicService extends Service {
  private config: QQMusicService.Config
  private cacheDir: string
  private tempDir: string
  private guid: string

  constructor(ctx: Context, config: QQMusicService.Config) {
    super(ctx, 'qqMusic', true)
    this.config = config
    this.guid = this.generateGuid()
    this.cacheDir = path.join(ctx.baseDir, 'data', 'music-qq', 'cache')
    this.tempDir = path.join(ctx.baseDir, 'data', 'music-qq', 'temp')
    
    ;[this.cacheDir, this.tempDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    })
  }

  static inject = ['http']

  private generateGuid(): string {
    return Math.floor(Math.random() * 2147483647).toString()
  }

  private extractUin(): string {
    const match = this.config.cookie.match(/uin=o(\d+)/)
    return match ? match[1] : this.config.uin
  }

  async cleanCache(): Promise<void> {
    try {
      const now = Date.now()
      const expireTime = this.config.cacheExpire * 3600000
      
      const dirs = [this.cacheDir, this.tempDir]
      for (const dir of dirs) {
        const files = fs.readdirSync(dir)
        for (const file of files) {
          const filePath = path.join(dir, file)
          const stats = fs.statSync(filePath)
          if (now - stats.mtime.getTime() > expireTime) {
            fs.unlinkSync(filePath)
            this.ctx.logger.info('清理文件:', file)
          }
        }
      }
    } catch (error) {
      this.ctx.logger.error('清理缓存失败:', error)
    }
  }

  async search(keyword: string, limit: number = 5): Promise<QQMusicService.SongInfo[]> {
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
          'Cookie': this.config.cookie,
          'User-Agent': this.config.userAgent
        }
      })

      const jsonStr = data.replace(/MusicJsonCallback\(|\)$/g, '')
      const result = JSON.parse(jsonStr)

      if (!result.data?.song?.list) {
        return []
      }

      return result.data.song.list.map((song: any) => ({
        mid: song.mid,
        name: song.name,
        singer: song.singer.map((s: any) => s.name).join('/'),
        album: song.album?.name || '未知专辑',
        duration: song.interval,
        songId: song.id,
        payInfo: song.pay || {},
        quality: song.file?.size_320mp3 ? 320 : (song.file?.size_128mp3 ? 128 : 0)
      }))
    } catch (error) {
      this.logger.error('搜索失败:', error)
      throw new Error('搜索歌曲失败')
    }
  }

  async getPlayUrl(songMid: string, quality: number = 128): Promise<{url: string | null, type: string, quality: number}> {
    try {
      const guid = this.guid
      const uin = this.extractUin()
      
      const vkeyUrl = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
      const vkeyData = {
        req: {
          module: 'CDN.SrfCdnDispatchServer',
          method: 'GetCdnDispatch',
          param: { guid: guid, calltype: 0, userip: '' }
        },
        req_0: {
          module: 'vkey.GetVkeyServer',
          method: 'CgiGetVkey',
          param: {
            guid: guid,
            songmid: [songMid],
            songtype: [0],
            uin: uin,
            loginflag: 1,
            platform: '20'
          }
        },
        comm: { uin: uin, format: 'json', ct: 24, cv: 0 }
      }

      const { data: vkeyRes } = await this.ctx.http.post(vkeyUrl, vkeyData, {
        headers: {
          'Content-Type': 'application/json',
          'Cookie': this.config.cookie,
          'Referer': 'https://y.qq.com',
          'User-Agent': this.config.userAgent
        }
      })

      const midUrlInfo = vkeyRes.req_0?.data?.midurlinfo?.[0]
      if (!midUrlInfo || !midUrlInfo.purl) {
        return { url: null, type: 'need_vip', quality: 0 }
      }

      const url = `https://isure.stream.qqmusic.qq.com/${midUrlInfo.purl}`
      const actualQuality = midUrlInfo.purl.includes('M800') ? 320 : 
                           midUrlInfo.purl.includes('F000') ? 999 : 128
      
      return { url, type: 'success', quality: actualQuality }
    } catch (error) {
      this.logger.error('获取播放链接失败:', error)
      return { url: null, type: 'error', quality: 0 }
    }
  }

  async downloadSong(songMid: string, songName: string, quality: number): Promise<string | null> {
    try {
      await this.cleanCache()
      
      const { url } = await this.getPlayUrl(songMid, quality)
      if (!url) return null

      const fileName = `${songMid}_${Date.now()}.mp3`
      const filePath = path.join(this.cacheDir, fileName)

      await downloadFile(url, filePath, this.config.requestTimeout)
      
      const stats = fs.statSync(filePath)
      if (stats.size < 102400) {
        fs.unlinkSync(filePath)
        return null
      }

      return filePath
    } catch (error) {
      this.logger.error('下载歌曲失败:', error)
      return null
    }
  }

  async getLyrics(songMid: string): Promise<string | null> {
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
          'Cookie': this.config.cookie
        }
      })

      const result = JSON.parse(data.replace(/MusicJsonCallback\(|\)$/g, ''))
      if (result.lyric) {
        const lyrics = Buffer.from(result.lyric, 'base64').toString('utf-8')
        return lyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim()
      }
      return null
    } catch (error) {
      this.logger.error('获取歌词失败:', error)
      return null
    }
  }

  async getUserPlaylists(): Promise<any[]> {
    const uin = this.extractUin()
    const url = 'https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss'
    
    const params = {
      cv: 10000, ct: 24, format: 'json',
      inCharset: 'utf-8', outCharset: 'utf-8',
      notice: 0, platform: 'yqq.json', needNewCode: 0,
      uin: uin, hostUin: uin, sin: 0, ein: 19, sort: 2, g_tk: 5381
    }

    try {
      const { data } = await this.ctx.http.get(url, {
        params,
        headers: { 'Cookie': this.config.cookie, 'Referer': 'https://y.qq.com' }
      })
      return data.data?.disslist || []
    } catch (error) {
      this.logger.error('获取歌单失败:', error)
      return []
    }
  }
}

namespace QQMusicService {
  export interface Config {
    cookie: string
    uin: string
    defaultQuality: number
    cacheExpire: number
    userAgent: string
  }

  export interface SongInfo {
    mid: string
    name: string
    singer: string
    album: string
    duration: number
    songId: number
    payInfo: any
    quality: number
  }
}

// ==================== 消息格式配置 Schema ====================

// 歌词格式配置
const LyricsConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('发送歌词'),
  maxLength: Schema.number().default(500).min(0).max(3000).description('歌词最大长度（0为不限制）'),
  format: Schema.string().role('textarea').default('📜 歌词：\n{{lyrics}}').description('歌词格式模板'),
  showTimestamp: Schema.boolean().default(false).description('显示时间戳'),
  truncateText: Schema.string().default('...').description('截断提示文本'),
})

// 歌曲信息格式配置
const SongInfoConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('发送歌曲信息'),
  format: Schema.string().role('textarea').default(
`{{prefix}} {{name}}
🎤 歌手：{{singer}}
💿 专辑：{{album}}
⏱️ 时长：{{duration}}
{{quality}}
{{suffix}}`
  ).description('歌曲信息格式模板（可用变量：{{prefix}}, {{name}}, {{singer}}, {{album}}, {{duration}}, {{quality}}, {{vip}}, {{suffix}}）'),
  separator: Schema.string().default('──────────').description('分隔线样式'),
  showSeparator: Schema.boolean().default(true).description('显示分隔线'),
})

// 语音消息配置
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

// 完整的消息格式配置
const MessageFormatConfig = Schema.intersect([
  Schema.object({
    voice: VoiceConfig,
  }).description('语音消息'),
  
  Schema.object({
    songInfo: SongInfoConfig,
  }).description('歌曲信息'),
  
  Schema.object({
    lyrics: LyricsConfig,
  }).description('歌词设置'),
  
  Schema.object({
    globalPrefix: Schema.string().default('').description('全局前缀（每消息前添加）'),
    globalSuffix: Schema.string().default('').description('全局后缀（每消息后添加）'),
    combineMessages: Schema.boolean().default(true).description('合并为单条消息（语音除外）'),
    messageDelay: Schema.number().default(500).min(0).max(5000).description('消息间隔（毫秒）'),
  }).description('全局设置'),
])

// ==================== 群聊/私聊配置 ====================

const GroupConfig = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('在群聊中启用点歌功能'),
  }).description('基础设置'),
  
  Schema.object({
    maxResults: Schema.number().default(5).min(1).max(20).description('搜索结果数量'),
    imageMode: Schema.boolean().default(true).description('图片展示搜索结果'),
    imageFallback: Schema.boolean().default(true).description('图片失败回退文字'),
  }).description('搜索设置'),
  
  Schema.object({
    messageFormat: MessageFormatConfig,
  }).description('消息格式（可完全自定义）'),
  
  Schema.object({
    cooldown: Schema.number().default(10).min(0).max(300).description('冷却时间（秒）'),
    allowAnonymous: Schema.boolean().default(false).description('允许匿名用户'),
    maxDuration: Schema.number().default(600).min(0).description('最大时长（秒，0无限制）'),
    vipTip: Schema.boolean().default(true).description('VIP 歌曲提示'),
  }).description('限制设置'),
])

const PrivateConfig = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('在私聊中启用点歌功能'),
  }).description('基础设置'),
  
  Schema.object({
    maxResults: Schema.number().default(10).min(1).max(30).description('搜索结果数量'),
    imageMode: Schema.boolean().default(true).description('图片展示搜索结果'),
    imageFallback: Schema.boolean().default(true).description('图片失败回退文字'),
  }).description('搜索设置'),
  
  Schema.object({
    messageFormat: MessageFormatConfig,
  }).description('消息格式（可完全自定义）'),
  
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

export interface Config {
  cookie: string
  uin: string
  defaultQuality: number
  group: typeof GroupConfig.value
  private: typeof PrivateConfig.value
  search: typeof SearchConfig.value
  advanced: typeof AdvancedConfig.value
  adminUsers: string[]
  blacklist: string[]
  whitelist: string[]
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    cookie: Schema.string().role('textarea').required().description('QQ 音乐 Cookie'),
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
    adminUsers: Schema.array(Schema.string()).default([]).description('管理员'),
    blacklist: Schema.array(Schema.string()).default([]).description('黑名单'),
    whitelist: Schema.array(Schema.string()).default([]).description('白名单'),
  }).description('权限设置'),
])

export const name = 'koishi-plugin-voice-qqmusic'
export const inject = ['http', 'puppeteer?']

const cooldowns = new Map<string, number>()
const dailyLimits = new Map<string, { count: number, date: string }>()
const concurrentDownloads = new Set<string>()

export function apply(ctx: Context, config: Config) {
  ctx.plugin(QQMusicService, {
    cookie: config.cookie,
    uin: config.uin,
    defaultQuality: config.defaultQuality,
    cacheExpire: config.advanced.cacheExpire,
    userAgent: config.advanced.userAgent
  })

  const cleanInterval = setInterval(() => {
    ctx.qqMusic.cleanCache()
  }, config.advanced.cacheCleanInterval * 3600000)
  ctx.on('dispose', () => clearInterval(cleanInterval))

  function isGroup(session: Session): boolean {
    return !!session.guildId
  }

  function getEnvConfig(session: Session) {
    return isGroup(session) ? config.group : config.private
  }

  function getMessageFormat(session: Session) {
    return getEnvConfig(session).messageFormat
  }

  function isAdmin(userId: string): boolean {
    return config.adminUsers.includes(userId)
  }

  function checkCooldown(session: Session): boolean {
    if (isAdmin(session.userId)) return true
    
    const isGroupChat = isGroup(session)
    const env = getEnvConfig(session)
    const key = `${isGroupChat ? 'g' : 'p'}:${session.userId}`
    
    const now = Date.now()
    const last = cooldowns.get(key)
    const cd = env.cooldown * 1000
    
    if (last && now - last < cd) {
      const wait = Math.ceil((cd - (now - last)) / 1000)
      session.send(`⏳ 请等待 ${wait} 秒`)
      return false
    }
    
    cooldowns.set(key, now)
    return true
  }

  function checkDailyLimit(session: Session): boolean {
    if (isAdmin(session.userId) || isGroup(session)) return true
    
    const maxDaily = config.private.maxDaily
    if (maxDaily === 0) return true
    
    const key = `daily:${session.userId}`
    const today = new Date().toDateString()
    const record = dailyLimits.get(key)
    
    if (!record || record.date !== today) {
      dailyLimits.set(key, { count: 1, date: today })
      return true
    }
    
    if (record.count >= maxDaily) {
      session.send(`❌ 今日已达上限(${maxDaily}次)`)
      return false
    }
    
    record.count++
    return true
  }

  function checkPermission(session: Session): boolean {
    const userId = session.userId
    
    if (config.blacklist.includes(userId)) {
      session.send('❌ 你已被列入黑名单')
      return false
    }
    
    if (config.whitelist.length > 0 && !config.whitelist.includes(userId)) {
      session.send('❌ 你不在白名单中')
      return false
    }
    
    return true
  }

  // 构建歌曲信息消息（使用自定义模板）
  function buildSongInfoMessage(song: QQMusicService.SongInfo, format: any): string {
    if (!format.enabled) return ''
    
    const qualityText = song.quality >= 999 ? '🔥 无损音质' : 
                       song.quality >= 320 ? '🔥 高品质音质' : 
                       song.quality >= 128 ? '🎵 标准音质' : ''
    
    const vipText = song.payInfo?.pay_play ? '💎 VIP 专享' : ''
    
    const vars = {
      prefix: '', // 在全局处理
      name: song.name,
      singer: song.singer,
      album: song.album,
      duration: formatTime(song.duration),
      quality: qualityText,
      vip: vipText,
      suffix: '',
    }
    
    let message = formatTemplate(format.format, vars)
    
    // 添加分隔线
    if (format.showSeparator && format.separator) {
      message += '\n' + format.separator
    }
    
    return message
  }

  // 构建歌词消息（使用自定义模板）
  function buildLyricsMessage(lyrics: string, format: any): string {
    if (!format.enabled || !lyrics) return ''
    
    let processedLyrics = lyrics
    if (format.maxLength > 0 && lyrics.length > format.maxLength) {
      processedLyrics = lyrics.substring(0, format.maxLength) + format.truncateText
    }
    
    return formatTemplate(format.format, { lyrics: processedLyrics })
  }

  // 发送搜索结果
  async function sendSearchResult(session: Session, songs: QQMusicService.SongInfo[], keyword: string): Promise<boolean> {
    const env = getEnvConfig(session)
    
    if (env.imageMode) {
      try {
        const html = buildSongListHTML(songs, keyword)
        const imagePath = path.join(ctx.qqMusic['tempDir'], `list_${Date.now()}.png`)
        const result = await htmlToImage(html, imagePath, ctx)
        
        if (result) {
          await session.send(h.image('file://' + result))
          setTimeout(() => {
            try { fs.unlinkSync(result) } catch {}
          }, 60000)
          return true
        }
      } catch (e) {
        if (config.advanced.debug) ctx.logger.error('图片生成失败:', e)
        if (!env.imageFallback) return false
      }
    }
    
    const list = songs.map((s, i) => {
      const icon = s.payInfo?.pay_play ? '💎' : '🎵'
      const quality = s.quality >= 320 ? '🔥' : ''
      return `${i+1}. ${icon}${quality} ${s.name}\n   🎤 ${s.singer} | 💿 ${s.album} | ⏱️ ${formatTime(s.duration)}`
    }).join('\n\n')
    
    await session.send(`🎼 找到以下歌曲：\n${list}\n\n回复数字选择，0取消`)
    return true
  }

  // 播放歌曲
  async function playSong(session: Session, song: QQMusicService.SongInfo, quality: number): Promise<string> {
    const env = getEnvConfig(session)
    const format = getMessageFormat(session)
    const isGroupChat = isGroup(session)
    
    // 时长检查
    if (isGroupChat && env.maxDuration > 0 && song.duration > env.maxDuration) {
      return `❌ 歌曲过长（限制${formatTime(env.maxDuration)}）`
    }

    // 并发控制
    const downloadKey = `${session.userId}:${song.mid}`
    if (concurrentDownloads.has(downloadKey)) {
      return '⏳ 正在处理中，请稍候...'
    }
    concurrentDownloads.add(downloadKey)

    try {
      await session.send(`⏳ 正在准备：${song.name}...`)
      
      const actualQuality = quality || format.voice.quality || env.messageFormat.voice.quality
      const filePath = await ctx.qqMusic.downloadSong(song.mid, song.name, actualQuality)
      
      if (!filePath) {
        return '❌ 歌曲下载失败，可能是 VIP 专享或版权受限'
      }

      // 获取歌词（异步）
      const lyricsPromise = format.lyrics.enabled ? ctx.qqMusic.getLyrics(song.mid) : Promise.resolve(null)

      // 1. 发送语音（如果启用且优先）
      if (format.voice.enabled && format.voice.sendFirst) {
        try {
          const atPrefix = isGroupChat && format.voice.atSender ? h.at(session.userId) + ' ' : ''
          await session.send(atPrefix + h('record', { 
            file: 'file://' + filePath,
            timeout: format.voice.timeout * 1000
          }))
        } catch (e) {
          if (config.advanced.debug) ctx.logger.error('语音发送失败:', e)
        }
      }

      // 2. 构建并发送文字消息（整合信息）
      const lyrics = await lyricsPromise
      const messages: string[] = []
      
      // 全局前缀
      if (format.globalPrefix) {
        messages.push(format.globalPrefix)
      }
      
      // 歌曲信息
      const songInfo = buildSongInfoMessage(song, format.songInfo)
      if (songInfo) messages.push(songInfo)
      
      // 歌词
      const lyricsMsg = buildLyricsMessage(lyrics, format.lyrics)
      if (lyricsMsg) messages.push(lyricsMsg)
      
      // 全局后缀
      if (format.globalSuffix) {
        messages.push(format.globalSuffix)
      }
      
      // 合并或分开发送
      if (format.combineMessages && messages.length > 0) {
        await session.send(messages.join('\n\n'))
      } else {
        for (const msg of messages) {
          if (msg) {
            await session.send(msg)
            if (format.messageDelay > 0) {
              await new Promise(r => setTimeout(r, format.messageDelay))
            }
          }
        }
      }

      // 3. 发送语音（如果启用且不优先）
      if (format.voice.enabled && !format.voice.sendFirst) {
        try {
          const atPrefix = isGroupChat && format.voice.atSender ? h.at(session.userId) + ' ' : ''
          await session.send(atPrefix + h('record', { 
            file: 'file://' + filePath,
            timeout: format.voice.timeout * 1000
          }))
        } catch (e) {
          if (config.advanced.debug) ctx.logger.error('语音发送失败:', e)
        }
      }

      // 延迟清理文件
      setTimeout(() => {
        try { fs.unlinkSync(filePath) } catch {}
      }, 120000)

      return undefined

    } catch (err) {
      ctx.logger.error('播放失败:', err)
      return '❌ 播放失败，请稍后重试'
    } finally {
      concurrentDownloads.delete(downloadKey)
    }
  }

  // ==================== 命令 ====================

  const musicCmd = ctx.command('点歌 <keyword:text>', '搜索并播放 QQ 音乐')
    .alias('qq点歌', 'music', '点歌')
    .option('n', '-n <num:number>', { fallback: 1, desc: '直接选择第几首' })
    .option('q', '-q <quality:number>', { fallback: 0, desc: '指定音质(128/320/999)' })

  musicCmd.middleware(async (session, next) => {
    if (!checkPermission(session)) return
    if (!checkCooldown(session)) return
    if (!checkDailyLimit(session)) return
    
    const env = getEnvConfig(session)
    if (!env.enabled) return isGroup(session) ? undefined : '私聊点歌已关闭'
    
    if (isGroup(session) && !env.allowAnonymous && session.author?.anonymous) {
      return '❌ 匿名用户无法点歌'
    }
    return next()
  })

  musicCmd.action(async ({ session, options }, keyword) => {
    if (!keyword) return '请输入歌曲名，如：点歌 周杰伦 晴天'
    
    const env = getEnvConfig(session)
    
    await session.send('🔍 搜索中...')

    try {
      let songs: QQMusicService.SongInfo[] = []
      for (let i = 0; i < config.search.retryTimes; i++) {
        try {
          songs = await ctx.qqMusic.search(keyword, env.maxResults)
          if (songs.length > 0) break
        } catch (e) {
          if (i === config.search.retryTimes - 1) throw e
          await new Promise(r => setTimeout(r, 1000))
        }
      }
      
      if (songs.length === 0) {
        return config.search.fuzzyMatch ? '❌ 未找到相关歌曲' : '❌ 未找到精确匹配'
      }

      if (options.n > 1) {
        if (options.n > songs.length) {
          return `❌ 只有 ${songs.length} 首结果`
        }
        return await playSong(session, songs[options.n - 1], options.q)
      }

      const listSent = await sendSearchResult(session, songs, keyword)
      if (!listSent) return '❌ 发送失败'

      const res = await session.prompt(60000)
      if (!res || res === '0') return '已取消'
      
      const n = parseInt(res)
      if (isNaN(n) || n < 1 || n > songs.length) {
        return '❌ 无效选择'
      }
      
      return await playSong(session, songs[n - 1], options.q)

    } catch (err) {
      ctx.logger.error('点歌失败:', err)
      return '❌ 搜索失败，请检查配置'
    }
  })

  ctx.command('我的歌单', '查看 QQ 音乐歌单').action(async ({ session }) => {
    try {
      const list = await ctx.qqMusic.getUserPlaylists()
      if (list.length === 0) return '📂 没有找到歌单'
      return '📚 我的歌单：\n' + list.map((p, i) => 
        `${i+1}. ${p.diss_name} (${p.song_cnt}首)`
      ).join('\n')
    } catch (error) {
      return '❌ 获取歌单失败'
    }
  })

  ctx.command('点歌状态').action(async ({ session }) => {
    if (!isAdmin(session.userId)) return '❌ 无权使用'
    
    const files = fs.readdirSync(ctx.qqMusic['cacheDir'])
    const size = files.reduce((a, f) => {
      try { 
        return a + fs.statSync(path.join(ctx.qqMusic['cacheDir'], f)).size 
      } catch { return a }
    }, 0)
    
    return [
      '📊 系统状态',
      `缓存文件: ${files.length}个`,
      `缓存大小: ${(size/1024/1024).toFixed(1)}MB`,
      `群聊: ${config.group.enabled ? '✅' : '❌'}`,
      `私聊: ${config.private.enabled ? '✅' : '❌'}`,
    ].join('\n')
  })

  ctx.command('清理音乐缓存').action(async ({ session }) => {
    if (!isAdmin(session.userId)) return '❌ 无权使用'
    await ctx.qqMusic.cleanCache()
    return '✅ 缓存清理完成'
  })
}