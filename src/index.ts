// src/index.ts
/**
 * Koishi 插件 - QQ 音乐点歌（扫码登录版）
 * 支持 QQ/微信扫码登录、搜索、播放、歌词显示等
 */

import { Context, Schema, Service, h, Session, Logger } from 'koishi'
import axios from 'axios'
import * as fs from 'fs/promises'
import * as path from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

// 声明模块扩展
declare module 'koishi' {
  interface Context {
    qqMusic: QQMusicService
    puppeteer: any
  }
}

// ---------- 工具函数 ----------

function formatTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match)
}

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function formatTime(s: number): string {
  const minutes = Math.floor(s / 60)
  const seconds = Math.floor(s % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

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

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; min-height: 100vh; }
    .container { max-width: 700px; margin: 0 auto; background: rgba(255,255,255,0.95); border-radius: 20px; padding: 30px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
    .header { text-align: center; margin-bottom: 25px; padding-bottom: 20px; border-bottom: 2px solid #eee; }
    .header h1 { color: #333; font-size: 28px; margin-bottom: 10px; }
    .header .keyword { color: #667eea; font-size: 18px; }
    .song-item { display: flex; align-items: center; padding: 15px; margin: 10px 0; background: #f8f9fa; border-radius: 12px; transition: all 0.3s; }
    .song-item:hover { background: #e9ecef; transform: translateX(5px); }
    .number { width: 40px; height: 40px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 18px; margin-right: 15px; flex-shrink: 0; }
    .info { flex: 1; }
    .title { font-size: 18px; font-weight: 600; color: #333; margin-bottom: 5px; }
    .meta { font-size: 14px; color: #666; }
    .footer { text-align: center; margin-top: 25px; padding-top: 20px; border-top: 2px solid #eee; color: #999; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎵 QQ 音乐搜索结果</h1>
      <div class="keyword">关键词：${escapeHtml(keyword)}</div>
    </div>
    ${items}
    <div class="footer">回复数字 1-${songs.length} 选择歌曲，回复 0 取消</div>
  </div>
</body>
</html>`
}

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

interface LoginState {
  cookie: string
  uin: string
  loginType: 'qq' | 'wechat'
  loginTime: number
  isVip: boolean
}

// ---------- QQMusicService ----------

class QQMusicService extends Service {
  private serviceConfig: QQMusicServiceConfig
  private cacheDir: string
  private tempDir: string
  private guid: string
  private serviceLogger: Logger
  private loginState: LoginState | null = null
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
    this.createDirectories().catch((err: any) => {
      this.serviceLogger.error('创建目录失败:', err)
    })
  }

  static inject = ['http', 'puppeteer']

  // 检查是否已登录
  isLoggedIn(): boolean {
    return this.loginState !== null && (Date.now() - this.loginState.loginTime) < 7 * 24 * 60 * 60 * 1000 // 7天有效期
  }

  // 获取当前登录态
  getLoginState(): LoginState | null {
    return this.loginState
  }

  // 设置登录态
  setLoginState(state: LoginState) {
    this.loginState = state
    this.serviceLogger.info(`登录成功: ${state.loginType}, UIN: ${state.uin}`)
  }

  // 退出登录
  logout() {
    this.loginState = null
    this.serviceLogger.info('已退出登录')
  }

  private generateGuid(): string {
    return Math.floor(Math.random() * 2147483647).toString()
  }

  private extractUin(): string {
    return this.loginState?.uin || '0'
  }

  private getCookie(): string {
    return this.loginState?.cookie || ''
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
          } catch {}
        }
      }
    } catch (error) {
      this.serviceLogger.error('清理缓存失败:', error)
    }
  }

  // 使用 Puppeteer 进行扫码登录
  async performLogin(loginType: 'qq' | 'wechat', notifyCallback: (message: string, imagePath?: string) => Promise<void>): Promise<boolean> {
    if (!this.ctx.puppeteer) {
      throw new Error('puppeteer 服务未加载，无法登录')
    }

    const page = await this.ctx.puppeteer.page()
    let loginSuccess = false

    try {
      // 访问 QQ 音乐登录页
      await page.goto('https://y.qq.com', { waitUntil: 'networkidle2', timeout: 60000 })
      
      // 点击登录按钮
      await page.waitForSelector('.mod_top_login', { timeout: 10000 })
      await page.click('.mod_top_login')
      
      // 等待登录弹窗
      await page.waitForTimeout(2000)

      // 根据类型选择登录方式
      if (loginType === 'qq') {
        // 切换到 QQ 扫码登录
        try {
          await page.waitForSelector('[data-stat="y_new.top.pop.login_qq"]', { timeout: 5000 })
          await page.click('[data-stat="y_new.top.pop.login_qq"]')
        } catch (e) {
          this.serviceLogger.debug('QQ登录按钮未找到，可能默认就是QQ登录')
        }
      } else {
        // 切换到微信登录
        try {
          await page.waitForSelector('[data-stat="y_new.top.pop.login_wechat"]', { timeout: 5000 })
          await page.click('[data-stat="y_new.top.pop.login_wechat"]')
        } catch (e) {
          // 尝试其他选择器
          const wechatBtn = await page.$('.login_wechat, [title="微信登录"]')
          if (wechatBtn) await wechatBtn.click()
        }
      }

      await page.waitForTimeout(2000)

      // 等待二维码出现
      const qrSelector = loginType === 'qq' ? '.qr_img, #qr_img, .qrcode img, iframe[src*="xui.ptlogin2.qq.com"]' : '.qr_img, #qr_img, .wechat_qr'
      await page.waitForSelector(qrSelector, { timeout: 15000 })

      // 如果是 iframe 需要切换
      const frames = page.frames()
      let targetFrame = page
      for (const frame of frames) {
        try {
          await frame.waitForSelector('.qr_img, #qr_img, .qrcode', { timeout: 3000 })
          targetFrame = frame
          break
        } catch {}
      }

      // 截取二维码区域或整个页面
      const qrPath = path.join(this.tempDir, `qr_${Date.now()}.png`)
      
      // 尝试定位二维码元素
      const qrElement = await targetFrame.$('.qr_img, #qr_img, .qrcode img, .login_qr_img')
      if (qrElement) {
        await qrElement.screenshot({ path: qrPath })
      } else {
        // 截取整个页面
        await page.screenshot({ path: qrPath, fullPage: false })
      }

      // 发送二维码给用户
      await notifyCallback(`请使用${loginType === 'qq' ? 'QQ' : '微信'}扫描以下二维码登录（2分钟内有效）：`, qrPath)

      // 监听登录成功
      const startTime = Date.now()
      const timeout = 120000 // 2分钟

      while (Date.now() - startTime < timeout) {
        // 检查是否登录成功（通过检查 Cookie 或页面跳转）
        const cookies = await page.cookies()
        const uinCookie = cookies.find(c => c.name === 'uin' || c.name === 'wxuin' || c.name === 'euin')
        const p_uinCookie = cookies.find(c => c.name === 'p_uin')
        
        if (uinCookie || p_uinCookie) {
          // 登录成功，提取 Cookie
          const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
          
          // 获取 UIN
          let uin = '0'
          const uinMatch = cookieStr.match(/uin=o(\d+)/) || cookieStr.match(/wxuin=(\d+)/)
          if (uinMatch) uin = uinMatch[1]

          // 检查是否为 VIP（通过访问会员页面或特定 API）
          const isVip = await this.checkVipStatus(cookieStr)

          this.setLoginState({
            cookie: cookieStr,
            uin,
            loginType,
            loginTime: Date.now(),
            isVip
          })

          loginSuccess = true
          await notifyCallback(`✅ 登录成功！${isVip ? '检测到 VIP 会员' : '非 VIP 用户'}\nUIN: ${uin}`)
          break
        }

        await page.waitForTimeout(3000)
      }

      if (!loginSuccess) {
        await notifyCallback('❌ 登录超时，请重试')
      }

      return loginSuccess
    } catch (error) {
      this.serviceLogger.error('登录过程出错:', error)
      await notifyCallback(`❌ 登录失败: ${error.message}`)
      return false
    } finally {
      await page.close().catch(() => {})
      // 清理二维码图片
      try {
        const qrPath = path.join(this.tempDir, `qr_${Date.now()}.png`)
        await fs.unlink(qrPath).catch(() => {})
      } catch {}
    }
  }

  // 检查 VIP 状态
  private async checkVipStatus(cookie: string): Promise<boolean> {
    try {
      const { data } = await this.ctx.http.get('https://c.y.qq.com/rsc/fcgi-bin/fcg_get_vip_info', {
        params: { g_tk: 5381, format: 'json', outCharset: 'utf-8' },
        headers: { Cookie: cookie, Referer: 'https://y.qq.com' }
      })
      // 解析返回判断是否为 VIP
      return data?.data?.isVip === 1 || data?.data?.vip === 1 || false
    } catch {
      return false
    }
  }

  async search(keyword: string, limit: number = 5): Promise<SongInfo[]> {
    if (!this.isLoggedIn()) throw new Error('未登录，请先使用"QQ音乐 登录"命令登录')

    const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
    const params = {
      ct: 24, qqmusic_ver: 1298, new_json: 1, remoteplace: 'txt.yqq.center',
      searchid: Math.floor(Math.random() * 1000000000), t: 0, aggr: 1, cr: 1,
      catZhida: 1, lossless: 0, flag_qc: 0, p: 1, n: limit, w: keyword,
      g_tk: 5381, jsonpCallback: 'MusicJsonCallback', loginUin: this.extractUin(),
      hostUin: 0, format: 'json', inCharset: 'utf8', outCharset: 'utf-8',
      notice: 0, platform: 'yqq', needNewCode: 0
    }

    try {
      const { data } = await this.ctx.http.get(url, {
        params,
        headers: {
          'Referer': 'https://y.qq.com',
          'Cookie': this.getCookie(),
          'User-Agent': this.serviceConfig.userAgent
        }
      })

      if (!data) throw new Error('搜索返回空数据')

      let result: any
      if (typeof data === 'string') {
        const jsonStr = data.replace(/^(?:MusicJsonCallback|callback)\(|\)$/g, '')
        result = JSON.parse(jsonStr)
      } else {
        result = data
      }

      if (!result.data?.song?.list) return []
      
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
      throw new Error('搜索歌曲失败: ' + error.message)
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
    if (!this.isLoggedIn()) return { url: null, type: 'error', quality: 0 }

    try {
      const guid = this.guid
      const uin = this.extractUin()
      const vkeyUrl = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
      const vkeyData = {
        req: { module: 'CDN.SrfCdnDispatchServer', method: 'GetCdnDispatch', param: { guid, calltype: 0, userip: '' } },
        req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: { guid, songmid: [songMid], songtype: [0], uin, loginflag: 1, platform: '20' } },
        comm: { uin, format: 'json', ct: 24, cv: 0 }
      }
      
      const { data } = await this.ctx.http.post(vkeyUrl, vkeyData, {
        headers: {
          'Content-Type': 'application/json',
          'Cookie': this.getCookie(),
          'Referer': 'https://y.qq.com',
          'User-Agent': this.serviceConfig.userAgent
        }
      })

      const midUrlInfo = data?.req_0?.data?.midurlinfo?.[0]
      if (!midUrlInfo?.purl) {
        return { url: null, type: this.loginState?.isVip ? 'error' : 'vip', quality: 0 }
      }
      
      const url = `https://isure.stream.qqmusic.qq.com/${midUrlInfo.purl}`
      return { url, type: 'success', quality: this.getUrlQuality(midUrlInfo.purl) }
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
        return null
      }
      
      return filePath
    } catch (error) {
      this.serviceLogger.error('下载歌曲失败:', error)
      return null
    } finally {
      this.currentDownloads--
      const next = this.downloadQueue.shift()
      next?.()
    }
  }

  async getLyrics(songMid: string, showTimestamp: boolean = false): Promise<string | null> {
    if (!this.isLoggedIn()) return null
    
    try {
      const url = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg'
      const params = {
        songmid: songMid, pcachetime: Date.now(), g_tk: 5381,
        loginUin: this.extractUin(), hostUin: 0, format: 'json',
        inCharset: 'utf8', outCharset: 'utf-8', notice: 0,
        platform: 'yqq.json', needNewCode: 0
      }
      
      const { data } = await this.ctx.http.get(url, {
        params,
        headers: { 'Referer': 'https://y.qq.com', 'Cookie': this.getCookie() }
      })

      if (!data) return null
      
      let result: any
      if (typeof data === 'string') {
        const jsonStr = data.replace(/^(?:MusicJsonCallback|callback)\(|\)$/g, '')
        result = JSON.parse(jsonStr)
      } else {
        result = data
      }

      if (result.lyric) {
        let lyrics = Buffer.from(result.lyric, 'base64').toString('utf-8')
        if (!showTimestamp) lyrics = lyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim()
        return lyrics
      }
      return null
    } catch (error) {
      this.serviceLogger.error('获取歌词失败:', error)
      return null
    }
  }

  async getUserPlaylists(): Promise<Array<{ name: string; count: number }>> {
    if (!this.isLoggedIn()) return []
    
    const uin = this.extractUin()
    const url = 'https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss'
    const params = {
      cv: 10000, ct: 24, format: 'json', inCharset: 'utf-8', outCharset: 'utf-8',
      notice: 0, platform: 'yqq.json', needNewCode: 0, uin, hostUin: uin,
      sin: 0, ein: 19, sort: 2, g_tk: 5381
    }
    
    try {
      const { data } = await this.ctx.http.get(url, {
        params,
        headers: { 'Cookie': this.getCookie(), 'Referer:': 'https://y.qq.com' }
      })

      if (!data?.data?.data?.disslist) return []
      
      return data.data.data.disslist.map((item: any) => ({ 
        name: item.diss_name, 
        count: item.song_cnt 
      }))
    } catch (error) {
      this.serviceLogger.error('获取歌单失败:', error)
      return []
    }
  }
}

// ---------- 配置类型 ----------

interface QQMusicServiceConfig {
  defaultQuality: number
  cacheExpire: number
  userAgent: string
  requestTimeout: number
}

// ---------- Schema 配置 ----------

const LyricsConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('发送歌词'),
  maxLength: Schema.number().default(500).min(0).max(3000).description('歌词最大长度'),
  format: Schema.string().role('textarea').default('📜 歌词：\n{{lyrics}}').description('歌词格式模板'),
  showTimestamp: Schema.boolean().default(false).description('显示时间戳'),
  truncateText: Schema.string().default('...').description('截断提示文本'),
})

const SongInfoConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('发送歌曲信息'),
  format: Schema.string().role('textarea').default('{{prefix}} {{name}}\n🎤 歌手：{{singer}}\n💿 专辑：{{album}}\n⏱️ 时长：{{duration}}\n{{quality}}\n{{suffix}}').description('歌曲信息格式模板'),
  separator: Schema.string().default('──────────').description('分隔线样式'),
  showSeparator: Schema.boolean().default(true).description('显示分隔线'),
})

const VoiceConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('发送语音'),
  sendFirst: Schema.boolean().default(true).description('语音优先发送'),
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
    combineMessages: Schema.boolean().default(true).description('合并为单条消息'),
    messageDelay: Schema.number().default(500).min(0).max(5000).description('消息间隔（毫秒）'),
  }).description('全局设置'),
])

const GroupConfig = Schema.intersect([
  Schema.object({ enabled: Schema.boolean().default(true).description('在群聊中启用') }).description('基础设置'),
  Schema.object({
    maxResults: Schema.number().default(5).min(1).max(20).description('搜索结果数量'),
    imageMode: Schema.boolean().default(true).description('图片展示搜索结果'),
    imageFallback: Schema.boolean().default(true).description('图片失败回退文字'),
  }).description('搜索设置'),
  Schema.object({ messageFormat: MessageFormatConfig }).description('消息格式'),
  Schema.object({
    cooldown: Schema.number().default(10).min(0).max(300).description('冷却时间（秒）'),
    maxDuration: Schema.number().default(600).min(0).description('最大时长（秒，0无限制）'),
    vipTip: Schema.boolean().default(true).description('VIP 歌曲提示'),
  }).description('限制设置'),
])

const PrivateConfig = Schema.intersect([
  Schema.object({ enabled: Schema.boolean().default(true).description('在私聊中启用') }).description('基础设置'),
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

export interface Config {
  defaultQuality: number
  group: any
  private: any
  search: any
  advanced: any
  adminUsers: string[]
  blacklist: string[]
  whitelist: string[]
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    defaultQuality: Schema.union([
      Schema.const(128).description('标准 128kbps'),
      Schema.const(320).description('高品质 320kbps'),
      Schema.const(999).description('无损 FLAC')
    ]).default(128).description('默认音质'),
  }).description('播放设置'),
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
export const inject = {
  required: ['http', 'puppeteer'], // puppeteer 现在是必需的
}

const cooldowns = new Map<string, number>()
const dailyLimits = new Map<string, { count: number; date: string }>()
const userLocks = new Set<string>()
const loginLocks = new Set<string>() // 防止重复登录

setInterval(() => {
  const now = Date.now()
  const todayStr = new Date().toDateString()
  for (const [key, time] of cooldowns) {
    if (now - time > 86400000) cooldowns.delete(key)
  }
  for (const [key, record] of dailyLimits) {
    if (record.date !== todayStr) dailyLimits.delete(key)
  }
}, 86400000)

export function apply(ctx: Context, config: Config) {
  // 初始化服务
  ctx.plugin(QQMusicService, {
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
    const tempDir = path.join(ctx.baseDir, 'data', 'music-qq', 'temp')
    fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  // 辅助函数
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
    return config.adminUsers?.includes(session.userId) || 
           ((session.user as any)?.authorities?.includes(4) ?? false)
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
    const qualityText = song.quality >= 999 ? '🔥 无损音质' : song.quality >= 320 ? '🔥 高品质音质' : song.quality >= 128 ? '🎵 标准音质' : ''
    const vipText = song.payInfo?.pay_play ? '💎 VIP 专享' : ''
    const vars = { 
      prefix: '', 
      name: song.name, 
      singer: song.singer, 
      album: song.album, 
      duration: formatTime(song.duration), 
      quality: qualityText, 
      vip: vipText, 
      suffix: '' 
    }
    let message = formatTemplate(format.format, vars)
    if (format.showSeparator && format.separator) message += '\n' + format.separator
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
    
    const list = songs.map((s, i) => {
      const icon = s.payInfo?.pay_play ? '💎' : '🎵'
      const quality = s.quality >= 320 ? '🔥' : ''
      return `${i + 1}. ${icon}${quality} ${s.name}\n   🎤 ${s.singer} | 💿 ${s.album} | ⏱️ ${formatTime(s.duration)}`
    }).join('\n\n')
    
    await session.send(`🎼 找到以下歌曲：\n${list}\n\n回复数字选择，0取消`)
    return true
  }

  async function playSong(session: Session, song: SongInfo, quality?: number): Promise<string | undefined> {
    const env = getEnvConfig(session)
    const format = getMessageFormat(session)
    const isGroupChat = isGroup(session)
    
    if (isGroupChat && env?.maxDuration > 0 && song.duration > env.maxDuration) {
      return `❌ 歌曲过长（限制 ${formatTime(env.maxDuration)}）`
    }
    
    const lockKey = `${session.userId}:${song.mid}`
    if (userLocks.has(lockKey)) return '⏳ 正在处理中，请稍候...'
    userLocks.add(lockKey)
    
    try {
      await session.send(`⏳ 正在准备：${song.name}...`)
      const actualQuality = quality || format?.voice?.quality || config.defaultQuality
      const filePath = await ctx.qqMusic.downloadSong(song.mid, song.name, actualQuality)
      
      if (!filePath) {
        const { type } = await ctx.qqMusic.getPlayUrl(song.mid)
        if (type === 'vip' && env?.vipTip) return '💎 该歌曲为 VIP 专享，请开通会员后播放'
        return '❌ 歌曲下载失败，可能是版权受限或链接失效'
      }

      const lyricsPromise = format?.lyrics?.enabled 
        ? ctx.qqMusic.getLyrics(song.mid, format.lyrics.showTimestamp) 
        : Promise.resolve(null)

      // 先发语音
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

      const lyrics = await lyricsPromise
      const messages: string[] = []
      if (format?.globalPrefix) messages.push(format.globalPrefix)
      
      const songInfo = buildSongInfoMessage(song, format?.songInfo)
      if (songInfo) messages.push(songInfo)
      
      const lyricsMsg = buildLyricsMessage(lyrics, format?.lyrics)
      if (lyricsMsg) messages.push(lyricsMsg)
      
      if (format?.globalSuffix) messages.push(format.globalSuffix)

      // 发送文字信息
      if (format?.combineMessages && messages.length > 0) {
        await session.send(messages.join('\n\n'))
      } else {
        for (const msg of messages) {
          if (msg) {
            await session.send(msg)
            if (format?.messageDelay > 0) await new Promise(r => setTimeout(r, format.messageDelay))
          }
        }
      }

      // 后发语音
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

  // ========== 登录命令 ==========
  
  ctx.command('QQ音乐 <action:text>', 'QQ音乐登录与管理')
    .alias('qq音乐', 'QQ音乐登录')
    .usage('指令：QQ音乐 QQ登录 | QQ音乐 微信登录 | QQ音乐 退出登录 | QQ音乐 状态')
    .action(async ({ session }, action) => {
      // 仅允许私聊
      if (isGroup(session)) {
        return '❌ 登录功能仅限私聊使用，请私聊机器人'
      }

      // 检查权限4
      if (!isAdmin(session)) {
        return '❌ 仅限管理员使用（需要权限4）'
      }

      const cmd = action?.trim().toLowerCase() || ''

      // 退出登录
      if (cmd === '退出登录' || cmd === 'logout') {
        ctx.qqMusic.logout()
        return '✅ 已退出登录'
      }

      // 查看状态
      if (cmd === '状态' || cmd === 'status') {
        const state = ctx.qqMusic.getLoginState()
        if (!state) return '📵 当前未登录\n使用"QQ音乐 QQ登录"或"QQ音乐 微信登录"进行扫码登录'
        return `✅ 已登录 (${state.loginType === 'qq' ? 'QQ' : '微信'})\n👤 UIN: ${state.uin}\n${state.isVip ? '💎 VIP会员' : '👤 普通用户'}\n⏰ 登录时间: ${new Date(state.loginTime).toLocaleString()}`
      }

      // 处理登录
      let loginType: 'qq' | 'wechat' | null = null
      if (cmd.includes('qq') || cmd.includes('QQ')) loginType = 'qq'
      else if (cmd.includes('微信') || cmd.includes('wechat')) loginType = 'wechat'
      
      if (!loginType) {
        return '❌ 未知指令\n可用指令：QQ登录 | 微信登录 | 退出登录 | 状态'
      }

      // 检查是否已在登录中
      if (loginLocks.has(session.userId)) {
        return '⏳ 登录进行中，请完成当前扫码或等待超时'
      }

      // 检查是否已登录
      if (ctx.qqMusic.isLoggedIn()) {
        const current = ctx.qqMusic.getLoginState()
        return `⚠️ 当前已登录 (${current?.loginType === 'qq' ? 'QQ' : '微信'}: ${current?.uin})\n如需切换账号，请先发送"QQ音乐 退出登录"`
      }

      loginLocks.add(session.userId)
      
      try {
        await session.send(`🎵 正在启动${loginType === 'qq' ? 'QQ' : '微信'}扫码登录，请稍候...`)
        
        const success = await ctx.qqMusic.performLogin(
          loginType,
          async (message, imagePath) => {
            if (imagePath) {
              await session.send(message + '\n' + h.image('file://' + imagePath))
            } else {
              await session.send(message)
            }
          }
        )
        
        return success ? '' : '登录失败'
      } catch (error) {
        ctx.logger.error('登录命令失败:', error)
        return `❌ 登录失败: ${error.message}`
      } finally {
        loginLocks.delete(session.userId)
      }
    })

  // ========== 点歌命令 ==========

  const musicCmd = ctx.command('点歌 <keyword:text>', '搜索并播放 QQ 音乐')
    .alias('qq点歌', 'music')
    .option('n', '-n <num:number>', { fallback: 1 })
    .option('q', '-q <quality:number>', { fallback: 0 })
    .action(async ({ session, options }, keyword) => {
      if (!keyword) return '请输入歌曲名，如：点歌 周杰伦 晴天'
      
      // 检查登录状态
      if (!ctx.qqMusic.isLoggedIn()) {
        return '❌ 机器人未登录 QQ 音乐\n请联系管理员使用"QQ音乐 QQ登录"或"QQ音乐 微信登录"进行登录'
      }

      const env = getEnvConfig(session)
      
      // 检查权限和限制
      if (!checkPermission(session)) return
      if (!checkCooldown(session)) return
      if (!checkDailyLimit(session)) return

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

        const n = Number(options?.n ?? 0)
        if (n > 0 && n <= songs.length) {
          return await playSong(session, songs[n - 1], Number(options?.q)) ?? ''
        }
        if (n > songs.length) return `❌ 只有 ${songs.length} 首结果`

        // 发送列表等待选择
        const listSent = await sendSearchResult(session, songs, keyword)
        if (!listSent) return '❌ 发送失败'

        try {
          const res = await session.prompt(60000)
          if (!res || res === '0') return '已取消'
          
          const selectNum = parseInt(res)
          if (isNaN(selectNum) || selectNum < 1 || selectNum > songs.length) return '❌ 无效选择'
          
          const result = await playSong(session, songs[selectNum - 1], Number(options?.q))
          return result ?? ''
        } catch (promptErr) {
          return '⏰ 选择超时，请重新点歌'
        }
      } catch (err) {
        ctx.logger.error('点歌失败:', err)
        return '❌ 搜索失败: ' + err.message
      }
    })

  // ========== 其他命令 ==========

  ctx.command('我的歌单', '查看 QQ 音乐歌单').action(async ({ session }) => {
    if (!ctx.qqMusic.isLoggedIn()) return '❌ 机器人未登录 QQ 音乐'
    if (!checkPermission(session)) return
    
    try {
      const list = await ctx.qqMusic.getUserPlaylists()
      if (list.length === 0) return '📂 没有找到歌单'
      return '📚 我的歌单：\n' + list.map((p, i) => `${i + 1}. ${p.name} (${p.count}首)`).join('\n')
    } catch (error) {
      return '❌ 获取歌单失败'
    }
  })

  ctx.command('点歌状态', '查看点歌系统状态').action(async ({ session }) => {
    if (!isAdmin(session)) return '❌ 无权使用'
    
    try {
      const files = await fs.readdir(ctx.qqMusic['cacheDir']).catch(() => [] as string[])
      let size = 0
      for (const file of files) {
        try {
          const stat = await fs.stat(path.join(ctx.qqMusic['cacheDir'], file))
          size += stat.size
        } catch {}
      }
      
      const loginState = ctx.qqMusic.getLoginState()
      const loginInfo = loginState 
        ? `✅ 已登录 (${loginState.loginType}, ${loginState.uin}, ${loginState.isVip ? 'VIP' : '普通'})`
        : '❌ 未登录'
      
      return [
        '📊 系统状态',
        `登录状态: ${loginInfo}`,
        `缓存文件: ${files.length} 个`,
        `缓存大小: ${(size / 1024 / 1024).toFixed(1)} MB`,
        `群聊: ${config.group?.enabled ? '✅' : '❌'}`,
        `私聊: ${config.private?.enabled ? '✅' : '❌'}`
      ].join('\n')
    } catch (error) {
      return '❌ 读取状态失败'
    }
  })

  ctx.command('清理音乐缓存', '手动清理过期缓存').action(async ({ session }) => {
    if (!isAdmin(session)) return '❌ 无权使用'
    await ctx.qqMusic.cleanCache()
    return '✅ 缓存清理完成'
  })
}