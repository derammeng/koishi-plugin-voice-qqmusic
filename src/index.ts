// src/index.ts
import { Context, Schema, Service, h, Session, Logger } from 'koishi';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createCanvas, loadImage, CanvasRenderingContext2D } from 'canvas';

// 类型定义
interface SongInfo {
  mid: string;
  name: string;
  singer: string;
  album: string;
  albumMid: string;
  duration: number;
  songId: number;
  payInfo: any;
  quality: number;
  cover: string;
}

interface QQMusicApiResponse<T = any> {
  code: number;
  data: T;
  msg?: string;
}

// 反爬 UA 池
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
];

// 工具函数
function formatTime(s: number): string {
  const minutes = Math.floor(s / 60);
  const seconds = Math.floor(s % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 图片模板变量替换
function replaceTemplateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/<(\w+)>/g, (match, key) => vars[key] ?? match);
}

// QQMusicService 服务类
class QQMusicService extends Service {
  private httpClient: AxiosInstance;
  private apiBaseUrl: string;
  private cookies: string;
  private cacheDir: string;
  private tempDir: string;
  private serviceLogger: Logger;
  private guid: string;
  private static readonly MAX_CONCURRENT = 3;
  private currentDownloads = 0;
  private downloadQueue: Array<() => void> = [];

  constructor(ctx: Context, config: any) {
    super(ctx, 'qqMusic', true);
    this.serviceLogger = ctx.logger('qq-music');
    this.apiBaseUrl = config.apiBaseUrl || 'http://127.0.0.1:3300';
    this.cookies = config.cookies || '';
    this.guid = Math.floor(Math.random() * 2147483647).toString();
    this.cacheDir = path.join(ctx.baseDir, 'data', 'music-qq', 'cache');
    this.tempDir = path.join(ctx.baseDir, 'data', 'music-qq', 'temp');
    
    this.httpClient = axios.create({
      timeout: config.requestTimeout || 30000,
      headers: {
        'User-Agent': USER_AGENTS[0],
        'Cookie': this.cookies,
      },
    });

    this.createDirectories().catch((err: any) => {
      this.serviceLogger.error('创建目录失败:', err);
    });
  }

  static inject = ['http'];

  private async createDirectories(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.cacheDir, { recursive: true }),
      fs.mkdir(this.tempDir, { recursive: true }),
    ]);
  }

  async updateCookies(cookies: string): Promise<void> {
    this.cookies = cookies;
    this.httpClient.defaults.headers['Cookie'] = cookies;
  }

  // 搜索歌曲
  async search(keyword: string, limit: number = 5): Promise<SongInfo[]> {
    try {
      const { data } = await this.httpClient.get(`${this.apiBaseUrl}/search`, {
        params: {
          key: keyword,
          pageNo: 1,
          pageSize: limit,
        },
      });

      if (data.code !== 200 || !data.data?.list) {
        throw new Error(data.msg || '搜索失败');
      }

      return data.data.list.map((song: any) => ({
        mid: song.songmid,
        name: song.songname,
        singer: song.singer?.map((s: any) => s.name).join('/') || '未知歌手',
        album: song.albumname || '未知专辑',
        albumMid: song.albummid,
        duration: song.interval || 0,
        songId: song.songid,
        payInfo: song.pay,
        quality: this.getSongQuality(song.size128, song.size320, song.sizeflac),
        cover: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.albummid}.jpg`,
      }));
    } catch (error: any) {
      this.serviceLogger.error('搜索失败:', error.message);
      throw new Error('搜索歌曲失败: ' + error.message);
    }
  }

  private getSongQuality(size128?: number, size320?: number, sizeFlac?: number): number {
    if (sizeFlac && sizeFlac > 0) return 999;
    if (size320 && size320 > 0) return 320;
    if (size128 && size128 > 0) return 128;
    return 0;
  }

  // 获取播放链接
  async getPlayUrl(songMid: string, quality: number = 128): Promise<{ url: string | null; type: 'success' | 'vip' | 'error'; quality: number }> {
    try {
      const qualityMap: Record<number, string> = {
        128: 'M500',
        320: 'M800',
        999: 'F000',
      };
      const filename = `${qualityMap[quality] || 'M500'}${songMid}.mp3`;

      const { data } = await this.httpClient.get(`${this.apiBaseUrl}/song/urls`, {
        params: {
          id: songMid,
          quality: quality >= 999 ? 'flac' : quality >= 320 ? '320' : '128',
        },
      });

      if (data.code !== 200 || !data.data?.[songMid]) {
        return { url: null, type: 'vip', quality: 0 };
      }

      const url = data.data[songMid];
      return { url, type: 'success', quality };
    } catch (error: any) {
      this.serviceLogger.error('获取播放链接失败:', error.message);
      return { url: null, type: 'error', quality: 0 };
    }
  }

  // 下载歌曲
  async downloadSong(songMid: string, songName: string, quality: number = 128): Promise<string | null> {
    if (this.currentDownloads >= QQMusicService.MAX_CONCURRENT) {
      await new Promise<void>(resolve => this.downloadQueue.push(resolve));
    }
    this.currentDownloads++;

    try {
      const { url, type } = await this.getPlayUrl(songMid, quality);
      if (!url) {
        this.serviceLogger.debug(type === 'vip' ? `VIP歌曲无法下载: ${songName}` : `获取链接失败: ${songName}`);
        return null;
      }

      const fileName = `${songMid}_${quality}_${Date.now()}.mp3`;
      const filePath = path.join(this.cacheDir, fileName);

      const response = await this.httpClient.get(url, {
        responseType: 'arraybuffer',
      });

      await fs.writeFile(filePath, response.data);

      const stats = await fs.stat(filePath);
      if (stats.size < 102400) {
        await fs.unlink(filePath);
        return null;
      }

      return filePath;
    } catch (error: any) {
      this.serviceLogger.error('下载失败:', error.message);
      return null;
    } finally {
      this.currentDownloads--;
      const next = this.downloadQueue.shift();
      next?.();
    }
  }

  // 获取歌词
  async getLyrics(songMid: string, showTimestamp: boolean = false): Promise<string | null> {
    try {
      const { data } = await this.httpClient.get(`${this.apiBaseUrl}/lyric`, {
        params: { songmid: songMid },
      });

      if (data.code !== 200 || !data.data?.lyric) {
        return null;
      }

      let lyrics = Buffer.from(data.data.lyric, 'base64').toString('utf-8');
      if (!showTimestamp) {
        lyrics = lyrics.replace(/\[\d+:\d+\.\d+\]/g, '').trim();
      }
      return lyrics;
    } catch (error: any) {
      this.serviceLogger.error('获取歌词失败:', error.message);
      return null;
    }
  }

  // 清理缓存
  async cleanCache(): Promise<void> {
    try {
      const now = Date.now();
      const expireTime = 24 * 3600000; // 24小时
      const files = await fs.readdir(this.cacheDir).catch(() => [] as string[]);
      
      for (const file of files) {
        const filePath = path.join(this.cacheDir, file);
        try {
          const stats = await fs.stat(filePath);
          if (now - stats.mtimeMs > expireTime) {
            await fs.unlink(filePath);
          }
        } catch {}
      }
    } catch (error: any) {
      this.serviceLogger.error('清理缓存失败:', error.message);
    }
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  getTempDir(): string {
    return this.tempDir;
  }
}

// Canvas 渲染服务
class CanvasRenderService {
  private ctx: Context;
  private logger: Logger;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.logger = ctx.logger('qq-music-canvas');
  }

  // 渲染歌曲信息图片
  async renderSongCard(song: SongInfo, template: string, width: number = 800): Promise<Buffer> {
    try {
      // 解析模板配置
      const config = this.parseTemplate(template);
      
      // 创建画布
      const canvas = createCanvas(width, 1200);
      const ctx = canvas.getContext('2d');

      // 绘制背景
      await this.drawBackground(ctx, width, 1200, config.background);

      // 加载封面图
      let coverImage: any = null;
      try {
        const coverResponse = await axios.get(song.cover, { responseType: 'arraybuffer' });
        coverImage = await loadImage(Buffer.from(coverResponse.data));
      } catch (e) {
        this.logger.warn('封面加载失败，使用占位符');
      }

      // 根据模板绘制各个元素
      let currentY = config.padding || 40;

      // 绘制封面（如果模板包含 <img>）
      if (template.includes('<img>') && coverImage) {
        const imgSize = config.imgSize || 300;
        const imgX = (width - imgSize) / 2;
        ctx.drawImage(coverImage, imgX, currentY, imgSize, imgSize);
        currentY += imgSize + 40;
      }

      // 绘制歌曲名
      if (template.includes('<musicname>')) {
        ctx.font = `bold ${config.titleSize || 48}px sans-serif`;
        ctx.fillStyle = config.titleColor || '#ffffff';
        ctx.textAlign = 'center';
        const name = this.truncateText(ctx, song.name, width - 80);
        ctx.fillText(name, width / 2, currentY);
        currentY += (config.titleSize || 48) + 20;
      }

      // 绘制歌手
      if (template.includes('<singer>')) {
        ctx.font = `${config.artistSize || 32}px sans-serif`;
        ctx.fillStyle = config.artistColor || '#cccccc';
        const singer = `🎤 ${this.truncateText(ctx, song.singer, width - 80)}`;
        ctx.fillText(singer, width / 2, currentY);
        currentY += (config.artistSize || 32) + 20;
      }

      // 绘制专辑
      if (template.includes('<album>')) {
        ctx.font = `${config.albumSize || 28}px sans-serif`;
        ctx.fillStyle = config.albumColor || '#aaaaaa';
        const album = `💿 ${this.truncateText(ctx, song.album, width - 80)}`;
        ctx.fillText(album, width / 2, currentY);
        currentY += (config.albumSize || 28) + 20;
      }

      // 绘制时长和音质信息
      ctx.font = `${config.infoSize || 24}px sans-serif`;
      ctx.fillStyle = config.infoColor || '#888888';
      const qualityText = song.quality >= 999 ? '🔥 无损音质' : song.quality >= 320 ? '🔥 高品质' : '🎵 标准音质';
      const infoText = `⏱️ ${formatTime(song.duration)} | ${qualityText}`;
      ctx.fillText(infoText, width / 2, currentY + 40);

      // 如果有VIP标识
      if (song.payInfo?.pay_play) {
        ctx.font = 'bold 24px sans-serif';
        ctx.fillStyle = '#ffd700';
        ctx.fillText('💎 VIP 专享', width / 2, currentY + 80);
      }

      return canvas.toBuffer('image/png');
    } catch (error: any) {
      this.logger.error('Canvas渲染失败:', error.message);
      throw error;
    }
  }

  // 渲染搜索结果列表
  async renderSearchList(songs: SongInfo[], keyword: string, template: string, width: number = 800): Promise<Buffer> {
    const itemHeight = 120;
    const headerHeight = 100;
    const footerHeight = 60;
    const height = headerHeight + songs.length * itemHeight + footerHeight;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 绘制背景
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#667eea');
    gradient.addColorStop(1, '#764ba2');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // 绘制标题
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🎵 QQ音乐搜索结果', width / 2, 50);
    ctx.font = '24px sans-serif';
    ctx.fillStyle = '#e0e0e0';
    ctx.fillText(`关键词: ${keyword}`, width / 2, 85);

    // 绘制歌曲列表
    songs.forEach((song, index) => {
      const y = headerHeight + index * itemHeight;
      
      // 背景条
      ctx.fillStyle = index % 2 === 0 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)';
      ctx.fillRect(20, y, width - 40, itemHeight - 10);
      
      // 序号
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 28px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${index + 1}`, 40, y + 50);

      // 歌曲名
      ctx.font = 'bold 24px sans-serif';
      let nameX = 80;
      if (song.payInfo?.pay_play) {
        ctx.fillStyle = '#ffd700';
        ctx.fillText('💎', nameX, y + 40);
        nameX += 35;
      }
      if (song.quality >= 320) {
        ctx.fillStyle = '#ff6b6b';
        ctx.fillText('🔥', nameX, y + 40);
        nameX += 35;
      }
      ctx.fillStyle = '#ffffff';
      const name = this.truncateText(ctx, song.name, width - 200);
      ctx.fillText(name, nameX, y + 40);

      // 歌手和专辑
      ctx.fillStyle = '#cccccc';
      ctx.font = '20px sans-serif';
      const meta = `🎤 ${song.singer} | 💿 ${song.album}`;
      ctx.fillText(this.truncateText(ctx, meta, width - 120), 80, y + 75);

      // 时长
      ctx.textAlign = 'right';
      ctx.fillText(formatTime(song.duration), width - 40, y + 60);
    });

    // 页脚提示
    ctx.fillStyle = '#aaaaaa';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('回复数字 1-' + songs.length + ' 选择歌曲，回复 0 取消', width / 2, height - 20);

    return canvas.toBuffer('image/png');
  }

  private parseTemplate(template: string): any {
    // 解析模板字符串中的配置
    const config: any = {
      background: '#1a1a2e',
      padding: 40,
      imgSize: 300,
      titleSize: 48,
      titleColor: '#ffffff',
      artistSize: 32,
      artistColor: '#cccccc',
      albumSize: 28,
      albumColor: '#aaaaaa',
      infoSize: 24,
      infoColor: '#888888',
    };

    // 可以扩展解析更多样式配置
    return config;
  }

  private async drawBackground(ctx: CanvasRenderingContext2D, width: number, height: number, color: string) {
    // 绘制渐变背景
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#1a1a2e');
    gradient.addColorStop(0.5, '#16213e');
    gradient.addColorStop(1, '#0f3460');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // 添加装饰性元素
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.arc(
        Math.random() * width,
        Math.random() * height,
        Math.random() * 100 + 50,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  }

  private truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    const metrics = ctx.measureText(text);
    if (metrics.width <= maxWidth) return text;
    
    let truncated = text;
    while (ctx.measureText(truncated + '...').width > maxWidth && truncated.length > 0) {
      truncated = truncated.slice(0, -1);
    }
    return truncated + '...';
  }
}

// 配置 Schema 定义
const MessageTemplateConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('启用自定义模板'),
  template: Schema.string().role('textarea').default('<img>\n<musicname>\n<singer>\n<album>').description(
    '图片内容模板，可用变量：<musicname> 歌曲名, <singer> 歌手, <album> 专辑名, <img> 封面图位置'
  ),
  width: Schema.number().default(800).min(400).max(1200).description('图片宽度'),
  backgroundColor: Schema.string().default('#1a1a2e').description('背景颜色'),
  titleColor: Schema.string().default('#ffffff').description('歌曲名颜色'),
  artistColor: Schema.string().default('#cccccc').description('歌手颜色'),
  albumColor: Schema.string().default('#aaaaaa').description('专辑颜色'),
  fontSize: Schema.number().default(48).min(20).max(100).description('标题字体大小'),
});

const VoiceConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('发送语音'),
  sendFirst: Schema.boolean().default(true).description('语音优先发送'),
  atSender: Schema.boolean().default(true).description('语音@点歌者'),
  timeout: Schema.number().default(30).min(5).max(120).description('语音超时（秒）'),
  quality: Schema.union([
    Schema.const(128).description('标准 128kbps'),
    Schema.const(320).description('高品质 320kbps'),
    Schema.const(999).description('无损 FLAC')
  ]).default(128).description('语音音质'),
});

const LyricsConfig = Schema.object({
  enabled: Schema.boolean().default(false).description('发送歌词'),
  maxLength: Schema.number().default(500).min(0).max(2000).description('歌词最大长度'),
  showTimestamp: Schema.boolean().default(false).description('显示时间戳'),
});

const GroupConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('在群聊中启用'),
  maxResults: Schema.number().default(5).min(1).max(10).description('搜索结果数量'),
  imageMode: Schema.boolean().default(true).description('使用图片展示结果'),
  cooldown: Schema.number().default(10).min(0).max(300).description('冷却时间（秒）'),
  maxDuration: Schema.number().default(600).min(0).description('最大时长限制（秒，0无限制）'),
  vipTip: Schema.boolean().default(true).description('VIP歌曲提示'),
  messageTemplate: MessageTemplateConfig.description('图片模板设置'),
  voice: VoiceConfig.description('语音设置'),
  lyrics: LyricsConfig.description('歌词设置'),
});

const PrivateConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('在私聊中启用'),
  maxResults: Schema.number().default(8).min(1).max(15).description('搜索结果数量'),
  imageMode: Schema.boolean().default(true).description('使用图片展示结果'),
  cooldown: Schema.number().default(0).min(0).max(300).description('冷却时间（秒）'),
  maxDaily: Schema.number().default(50).min(0).description('每日最大次数（0无限制）'),
  vipTip: Schema.boolean().default(true).description('VIP歌曲提示'),
  messageTemplate: MessageTemplateConfig.description('图片模板设置'),
  voice: VoiceConfig.description('语音设置'),
  lyrics: LyricsConfig.description('歌词设置'),
});

// 使用示例配置（只读展示）
const UsageExampleConfig = Schema.object({
  example: Schema.string().role('textarea').default(
    '【使用示例】\n\n' +
    '1. 点歌功能：\n' +
    '   点歌 周杰伦晴天\n' +
    '   点歌-陈奕迅-十年\n' +
    '   点歌 林俊杰 江南\n\n' +
    '2. 选择歌曲：\n' +
    '   搜索后会显示列表，直接回复数字 1-5 选择\n' +
    '   回复 0 取消选择\n\n' +
    '3. 模板变量说明：\n' +
    '   <musicname> - 歌曲名称\n' +
    '   <singer>    - 歌手名称\n' +
    '   <album>     - 专辑名称\n' +
    '   <img>       - 专辑封面图片位置\n\n' +
    '4. 配置说明：\n' +
    '   • 在"Cookies"字段填入QQ音乐的Cookie字符串\n' +
    '   • 可使用浏览器开发者工具从 y.qq.com 获取\n' +
    '   • 需要包含 uin 和 musickey 字段\n\n' +
    '5. 依赖服务：\n' +
    '   • 需要安装并启动 qq-music-api 服务\n' +
    '   • 默认地址：http://127.0.0.1:3300'
  ).disabled().description('使用说明（只读）'),
});

export interface Config {
  cookies: string;
  apiBaseUrl: string;
  defaultQuality: number;
  group: any;
  private: any;
  advanced: any;
  usage: any;
  adminUsers: string[];
  blacklist: string[];
  commandPrefix: string;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    cookies: Schema.string().role('textarea').default('').description(
      'QQ音乐Cookies（必需，从浏览器开发者工具获取，需包含 uin 和 musickey）'
    ),
    apiBaseUrl: Schema.string().default('http://127.0.0.1:3300').description('qq-music-api 服务地址'),
    defaultQuality: Schema.union([
      Schema.const(128).description('标准 128kbps'),
      Schema.const(320).description('高品质 320kbps'),
      Schema.const(999).description('无损 FLAC')
    ]).default(128).description('默认音质'),
    commandPrefix: Schema.string().default('点歌').description('命令触发前缀（正则匹配）'),
  }).description('基础配置'),
  Schema.object({ group: GroupConfig }).description('群聊设置'),
  Schema.object({ private: PrivateConfig }).description('私聊设置'),
  Schema.object({
    advanced: Schema.object({
      debug: Schema.boolean().default(false).description('调试日志'),
      cacheCleanInterval: Schema.number().default(24).min(1).max(168).description('缓存清理间隔（小时）'),
      requestTimeout: Schema.number().default(30000).min(10000).max(60000).description('请求超时（毫秒）'),
      concurrentDownloads: Schema.number().default(3).min(1).max(5).description('最大并发下载数'),
    }).description('高级设置'),
  }),
  Schema.object({ usage: UsageExampleConfig }).description('使用说明'),
  Schema.object({
    adminUsers: Schema.array(Schema.string()).default([]).description('管理员用户ID列表'),
    blacklist: Schema.array(Schema.string()).default([]).description('黑名单用户ID'),
  }).description('权限设置'),
]);

export const name = 'koishi-plugin-voice-qqmusic';
export const inject = {
  required: ['http'],
  optional: ['puppeteer'],
};

// 全局状态管理
const cooldowns = new Map<string, number>();
const dailyLimits = new Map<string, { count: number; date: string }>();
const userLocks = new Set<string>();
const searchSessions = new Map<string, { songs: SongInfo[]; keyword: string; timestamp: number }>();

export function apply(ctx: Context, config: Config) {
  // 初始化服务
  ctx.plugin(QQMusicService, config);
  const canvasService = new CanvasRenderService(ctx);

  // 定期清理
  const cleanInterval = setInterval(() => {
    ctx.qqMusic?.cleanCache();
  }, (config.advanced?.cacheCleanInterval ?? 24) * 3600000);

  // 清理过期搜索会话
  setInterval(() => {
    const now = Date.now();
    for (const [key, session] of searchSessions) {
      if (now - session.timestamp > 600000) { // 10分钟过期
        searchSessions.delete(key);
      }
    }
  }, 300000);

  ctx.on('dispose', () => {
    clearInterval(cleanInterval);
  });

  // 辅助函数
  function isGroup(session: Session): boolean {
    return !!session.guildId;
  }

  function getEnvConfig(session: Session) {
    return isGroup(session) ? config.group : config.private;
  }

  function isAdmin(session: Session): boolean {
    if (config.adminUsers?.includes(session.userId)) return true;
    const authority = (session.user as any)?.authority;
    return typeof authority === 'number' && authority >= 4;
  }

  function checkCooldown(session: Session): boolean {
    if (isAdmin(session)) return true;
    const env = getEnvConfig(session);
    const key = `${isGroup(session) ? 'g' : 'p'}:${session.userId}`;
    const now = Date.now();
    const last = cooldowns.get(key);
    const cd = (env?.cooldown ?? 0) * 1000;
    
    if (last && now - last < cd) {
      const wait = Math.ceil((cd - (now - last)) / 1000);
      session.send(`⏳ 请等待 ${wait} 秒后再试`).catch(() => {});
      return false;
    }
    cooldowns.set(key, now);
    return true;
  }

  function checkDailyLimit(session: Session): boolean {
    if (isAdmin(session) || isGroup(session)) return true;
    const maxDaily = config.private?.maxDaily ?? 0;
    if (maxDaily === 0) return true;
    
    const key = `daily:${session.userId}`;
    const today = new Date().toDateString();
    const record = dailyLimits.get(key);
    
    if (!record || record.date !== today) {
      dailyLimits.set(key, { count: 1, date: today });
      return true;
    }
    if (record.count >= maxDaily) {
      session.send(`❌ 今日已达上限 (${maxDaily} 次)`).catch(() => {});
      return false;
    }
    record.count++;
    return true;
  }

  function checkPermission(session: Session): boolean {
    if (config.blacklist?.includes(session.userId)) {
      session.send('❌ 你已被列入黑名单').catch(() => {});
      return false;
    }
    return true;
  }

  // 发送搜索结果
  async function sendSearchResult(session: Session, songs: SongInfo[], keyword: string): Promise<void> {
    const env = getEnvConfig(session);
    const sessionKey = `${session.userId}:${session.guildId || 'private'}`;
    
    // 保存搜索会话
    searchSessions.set(sessionKey, { songs, keyword, timestamp: Date.now() });

    if (env?.imageMode) {
      try {
        const template = env.messageTemplate?.template || '<img>\n<musicname>\n<singer>\n<album>';
        const imageBuffer = await canvasService.renderSearchList(songs, keyword, template, env.messageTemplate?.width || 800);
        const imagePath = path.join(ctx.qqMusic.getTempDir(), `search_${Date.now()}.png`);
        await fs.writeFile(imagePath, imageBuffer);
        await session.send(h.image('file://' + imagePath));
        return;
      } catch (e) {
        ctx.logger.error('图片生成失败，回退到文字:', e);
      }
    }

    // 文字模式
    const list = songs.map((s, i) => {
      const icon = s.payInfo?.pay_play ? '💎' : '🎵';
      const quality = s.quality >= 320 ? '🔥' : '';
      return `${i + 1}. ${icon}${quality} ${s.name}\n   🎤 ${s.singer} | ⏱️ ${formatTime(s.duration)}`;
    }).join('\n\n');
    
    await session.send(`🎼 找到以下歌曲：\n${list}\n\n回复数字选择，0取消`);
  }

  // 播放歌曲
  async function playSong(session: Session, song: SongInfo, quality?: number): Promise<string | undefined> {
    const env = getEnvConfig(session);
    const format = env?.messageTemplate;
    const isGroupChat = isGroup(session);

    if (isGroupChat && env?.maxDuration > 0 && song.duration > env.maxDuration) {
      return `❌ 歌曲过长（限制 ${formatTime(env.maxDuration)}）`;
    }

    const lockKey = `${session.userId}:${song.mid}`;
    if (userLocks.has(lockKey)) return '⏳ 正在处理中，请稍候...';
    userLocks.add(lockKey);

    try {
      await session.send(`⏳ 正在准备：${song.name}...`);

      const actualQuality = quality || env?.voice?.quality || config.defaultQuality;
      const filePath = await ctx.qqMusic.downloadSong(song.mid, song.name, actualQuality);

      if (!filePath) {
        const { type } = await ctx.qqMusic.getPlayUrl(song.mid, actualQuality);
        if (type === 'vip' && env?.vipTip) return '💎 该歌曲为VIP专享，请开通会员后播放';
        return '❌ 歌曲下载失败，可能是版权受限';
      }

      // 获取歌词
      const lyricsPromise = env?.lyrics?.enabled 
        ? ctx.qqMusic.getLyrics(song.mid, env.lyrics.showTimestamp) 
        : Promise.resolve(null);

      // 发送语音
      if (env?.voice?.enabled && env.voice.sendFirst) {
        try {
          const atPrefix = isGroupChat && env.voice.atSender ? h.at(session.userId) + ' ' : '';
          await session.send(atPrefix + h('record', { 
            file: 'file://' + filePath, 
            timeout: env.voice.timeout * 1000 
          }));
        } catch (e) {
          ctx.logger.error('语音发送失败:', e);
        }
      }

      // 生成并发送信息卡片
      if (format?.enabled) {
        try {
          const template = format.template || '<img>\n<musicname>\n<singer>\n<album>';
          const imageBuffer = await canvasService.renderSongCard(song, template, format.width || 800);
          const imagePath = path.join(ctx.qqMusic.getTempDir(), `card_${Date.now()}.png`);
          await fs.writeFile(imagePath, imageBuffer);
          await session.send(h.image('file://' + imagePath));
        } catch (e) {
          ctx.logger.error('卡片生成失败:', e);
          // 回退到文字
          const msg = `🎵 ${song.name}\n🎤 ${song.singer}\n💿 ${song.album}\n⏱️ ${formatTime(song.duration)}`;
          await session.send(msg);
        }
      }

      // 发送歌词
      const lyrics = await lyricsPromise;
      if (lyrics && env?.lyrics?.enabled) {
        let text = lyrics;
        if (env.lyrics.maxLength > 0 && text.length > env.lyrics.maxLength) {
          text = text.substring(0, env.lyrics.maxLength) + '...';
        }
        await session.send(`📜 歌词：\n${text}`);
      }

      // 后发语音
      if (env?.voice?.enabled && !env.voice.sendFirst) {
        try {
          const atPrefix = isGroupChat && env.voice.atSender ? h.at(session.userId) + ' ' : '';
          await session.send(atPrefix + h('record', { 
            file: 'file://' + filePath, 
            timeout: env.voice.timeout * 1000 
          }));
        } catch (e) {
          ctx.logger.error('语音发送失败:', e);
        }
      }

      return undefined;
    } catch (err: any) {
      ctx.logger.error('播放失败:', err);
      return '❌ 播放失败，请稍后重试';
    } finally {
      userLocks.delete(lockKey);
    }
  }

  // 正则匹配命令：点歌 + <name>
  const musicPattern = new RegExp(`^${config.commandPrefix}\\s*[+\\-]?\\s*(.+)$`);
  
  ctx.middleware(async (session, next) => {
    const content = session.content?.trim();
    if (!content) return next();

    const match = content.match(musicPattern);
    if (!match) return next();

    const keyword = match[1].trim();
    if (!keyword) {
      await session.send(`请输入歌曲名，例如：${config.commandPrefix} 周杰伦 晴天`);
      return;
    }

    if (!checkPermission(session)) return;
    if (!checkCooldown(session)) return;
    if (!checkDailyLimit(session)) return;

    const env = getEnvConfig(session);
    if (!env?.enabled) {
      await session.send('❌ 当前环境已禁用点歌功能');
      return;
    }

    // 检查是否是选择数字（在搜索会话中）
    const sessionKey = `${session.userId}:${session.guildId || 'private'}`;
    const searchSession = searchSessions.get(sessionKey);
    
    if (searchSession && /^\d+$/.test(content)) {
      const num = parseInt(content);
      if (num === 0) {
        searchSessions.delete(sessionKey);
        await session.send('已取消选择');
        return;
      }
      if (num >= 1 && num <= searchSession.songs.length) {
        searchSessions.delete(sessionKey);
        const result = await playSong(session, searchSession.songs[num - 1]);
        if (result) await session.send(result);
        return;
      }
    }

    // 执行搜索
    await session.send('🔍 搜索中...');
    
    try {
      const songs = await ctx.qqMusic.search(keyword, env?.maxResults || 5);
      if (songs.length === 0) {
        await session.send('❌ 未找到相关歌曲');
        return;
      }

      await sendSearchResult(session, songs, keyword);
      
      // 等待用户选择
      try {
        const response = await session.prompt(60000);
        if (!response) {
          searchSessions.delete(sessionKey);
          await session.send('⏰ 选择超时');
          return;
        }
        
        const num = parseInt(response.trim());
        if (num === 0) {
          searchSessions.delete(sessionKey);
          await session.send('已取消');
          return;
        }
        if (isNaN(num) || num < 1 || num > songs.length) {
          searchSessions.delete(sessionKey);
          await session.send('❌ 无效选择');
          return;
        }
        
        searchSessions.delete(sessionKey);
        const result = await playSong(session, songs[num - 1]);
        if (result) await session.send(result);
      } catch (e) {
        searchSessions.delete(sessionKey);
        await session.send('⏰ 选择超时，请重新点歌');
      }
    } catch (err: any) {
      ctx.logger.error('点歌失败:', err);
      await session.send('❌ 搜索失败，请检查API服务是否正常');
    }
  });

  // 管理命令：更新Cookies
  ctx.command('qqmusic.setcookies <cookies:text>', '更新QQ音乐Cookies', { authority: 4 })
    .action(async ({ session }, cookies) => {
      if (!cookies) return '请提供Cookies字符串';
      await ctx.qqMusic.updateCookies(cookies);
      return '✅ Cookies已更新';
    });

  // 管理命令：查看状态
  ctx.command('qqmusic.status', '查看点歌系统状态', { authority: 3 })
    .action(async () => {
      try {
        const cacheDir = ctx.qqMusic.getCacheDir();
        const files = await fs.readdir(cacheDir).catch(() => [] as string[]);
        let size = 0;
        for (const file of files) {
          try {
            const stat = await fs.stat(path.join(cacheDir, file));
            size += stat.size;
          } catch {}
        }
        return [
          '📊 QQ音乐点歌系统状态',
          `API地址: ${config.apiBaseUrl}`,
          `缓存文件: ${files.length} 个`,
          `缓存大小: ${(size / 1024 / 1024).toFixed(1)} MB`,
          `群聊: ${config.group?.enabled ? '✅' : '❌'}`,
          `私聊: ${config.private?.enabled ? '✅' : '❌'}`,
        ].join('\n');
      } catch (error: any) {
        return '❌ 读取状态失败';
      }
    });

  // 管理命令：清理缓存
  ctx.command('qqmusic.clean', '手动清理缓存', { authority: 3 })
    .action(async () => {
      await ctx.qqMusic.cleanCache();
      return '✅ 缓存清理完成';
    });
}
