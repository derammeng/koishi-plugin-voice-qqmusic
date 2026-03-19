// src/index.ts
import { Context, Schema, Service, h, Session, Logger } from 'koishi';
import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createCanvas, loadImage, CanvasRenderingContext2D } from 'canvas';
import { QQMusicInternalAPI } from './api';
import { QQMusicQRLogin } from './qrlogin';

// 声明模块扩展
declare module 'koishi' {
  interface Context {
    qqMusic: QQMusicService;
  }
}

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

interface SearchSession {
  songs: SongInfo[];
  keyword: string;
  timestamp: number;
}

// 工具函数
function formatTime(s: number): string {
  const minutes = Math.floor(s / 60);
  const seconds = Math.floor(s % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

// Canvas 渲染服务
class CanvasRenderService {
  private serviceLogger: Logger;

  constructor(logger: Logger) {
    this.serviceLogger = logger;
  }

  // 渲染搜索结果列表
  async renderSearchList(
    songs: SongInfo[], 
    keyword: string, 
    config: any
  ): Promise<Buffer> {
    const width = config.width || 800;
    const itemHeight = config.itemHeight || 100;
    const headerHeight = config.headerHeight || 120;
    const footerHeight = config.footerHeight || 80;
    const height = headerHeight + songs.length * itemHeight + footerHeight;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 绘制背景
    await this.drawBackground(ctx, width, height, config);

    // 绘制标题
    ctx.fillStyle = config.headerColor || '#ffffff';
    ctx.font = `bold ${config.headerFontSize || 36}px "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('🎵 QQ音乐搜索结果', width / 2, 50);
    
    ctx.font = `${config.subHeaderFontSize || 24}px "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = config.subHeaderColor || '#e0e0e0';
    ctx.fillText(`关键词: ${keyword}`, width / 2, 90);

    // 绘制歌曲列表
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      const y = headerHeight + i * itemHeight;
      
      // 背景条（斑马纹）
      ctx.fillStyle = i % 2 === 0 
        ? (config.itemBgColor1 || 'rgba(255,255,255,0.1)') 
        : (config.itemBgColor2 || 'rgba(255,255,255,0.05)');
      ctx.fillRect(20, y, width - 40, itemHeight - 5);

      // 序号（圆角背景）
      const numSize = 32;
      const numX = 40;
      const numY = y + (itemHeight - numSize) / 2;
      
      ctx.fillStyle = config.numberBgColor || '#667eea';
      this.roundRect(ctx, numX, numY, numSize, numSize, 16);
      ctx.fill();
      
      ctx.fillStyle = config.numberColor || '#ffffff';
      ctx.font = `bold ${config.numberFontSize || 18}px "Microsoft YaHei", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((i + 1).toString(), numX + numSize/2, numY + numSize/2);

      // 歌曲名
      let nameX = numX + numSize + 15;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      
      // VIP 标识
      if (song.payInfo?.pay_play) {
        ctx.font = '20px "Microsoft YaHei"';
        ctx.fillText('💎', nameX, y + 35);
        nameX += 28;
      }
      
      // 高品质标识
      if (song.quality >= 320) {
        ctx.fillStyle = config.qualityColor || '#ff6b6b';
        ctx.font = '20px "Microsoft YaHei"';
        ctx.fillText('🔥', nameX, y + 35);
        nameX += 28;
      }

      ctx.fillStyle = config.songNameColor || '#ffffff';
      ctx.font = `bold ${config.songNameSize || 22}px "Microsoft YaHei", sans-serif`;
      const displayName = this.truncateText(ctx, song.name, width - nameX - 150);
      ctx.fillText(displayName, nameX, y + 35);

      // 歌手和专辑
      ctx.fillStyle = config.metaColor || '#cccccc';
      ctx.font = `${config.metaSize || 18}px "Microsoft YaHei", sans-serif`;
      const metaText = `🎤 ${song.singer}  💿 ${song.album}`;
      ctx.fillText(this.truncateText(ctx, metaText, width - 100), numX + numSize + 15, y + 70);

      // 时长（右对齐）
      ctx.textAlign = 'right';
      ctx.fillStyle = config.durationColor || '#aaaaaa';
      ctx.font = `${config.durationSize || 16}px "Microsoft YaHei", sans-serif`;
      ctx.fillText(formatTime(song.duration), width - 40, y + 55);
    }

    // 页脚提示
    ctx.textAlign = 'center';
    ctx.fillStyle = config.footerColor || '#aaaaaa';
    ctx.font = `${config.footerSize || 20}px "Microsoft YaHei", sans-serif`;
    ctx.fillText(`回复数字 1-${songs.length} 选择歌曲，回复 0 取消`, width / 2, height - 30);

    return canvas.toBuffer('image/png');
  }

  // 渲染歌曲卡片
  async renderSongCard(
    song: SongInfo, 
    template: string, 
    config: any
  ): Promise<Buffer> {
    const width = config.width || 800;
    const height = config.height || 600;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 绘制背景
    await this.drawBackground(ctx, width, height, config);

    let currentY = config.padding || 40;

    // 绘制封面（如果模板包含 {img}）
    if (template.includes('{img}')) {
      try {
        const coverResponse = await axios.get(song.cover, { responseType: 'arraybuffer' });
        const coverImage = await loadImage(Buffer.from(coverResponse.data));
        const imgSize = config.imgSize || 200;
        const imgX = (width - imgSize) / 2;
        
        // 绘制圆角封面
        this.roundRect(ctx, imgX, currentY, imgSize, imgSize, 12);
        ctx.save();
        ctx.clip();
        ctx.drawImage(coverImage, imgX, currentY, imgSize, imgSize);
        ctx.restore();
        
        currentY += imgSize + 30;
      } catch (e) {
        this.serviceLogger.warn('封面加载失败');
        currentY += 40;
      }
    }

    // 绘制歌曲名
    if (template.includes('{musicname}')) {
      ctx.fillStyle = config.titleColor || '#ffffff';
      ctx.font = `bold ${config.titleSize || 40}px "Microsoft YaHei", sans-serif`;
      ctx.textAlign = 'center';
      const name = this.truncateText(ctx, song.name, width - 80);
      ctx.fillText(name, width / 2, currentY);
      currentY += (config.titleSize || 40) + 20;
    }

    // 绘制歌手
    if (template.includes('{singer}')) {
      ctx.fillStyle = config.artistColor || '#e0e0e0';
      ctx.font = `${config.artistSize || 28}px "Microsoft YaHei", sans-serif`;
      const singer = `🎤 ${song.singer}`;
      ctx.fillText(singer, width / 2, currentY);
      currentY += (config.artistSize || 28) + 15;
    }

    // 绘制专辑
    if (template.includes('{album}')) {
      ctx.fillStyle = config.albumColor || '#cccccc';
      ctx.font = `${config.albumSize || 24}px "Microsoft YaHei", sans-serif`;
      const album = `💿 ${song.album}`;
      ctx.fillText(album, width / 2, currentY);
      currentY += (config.albumSize || 24) + 20;
    }

    // 绘制时长和音质
    ctx.font = `${config.infoSize || 22}px "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = config.infoColor || '#aaaaaa';
    const qualityText = song.quality >= 999 ? '🔥 无损音质' : song.quality >= 320 ? '🔥 高品质' : '🎵 标准音质';
    ctx.fillText(`⏱️ ${formatTime(song.duration)}  |  ${qualityText}`, width / 2, currentY + 20);

    // VIP 标识
    if (song.payInfo?.pay_play) {
      ctx.font = 'bold 26px "Microsoft YaHei"';
      ctx.fillStyle = '#ffd700';
      ctx.fillText('💎 VIP 专享', width / 2, currentY + 60);
    }

    return canvas.toBuffer('image/png');
  }

  private async drawBackground(
    ctx: CanvasRenderingContext2D, 
    width: number, 
    height: number, 
    config: any
  ) {
    // 渐变背景
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, config.bgColor1 || '#1a1a2e');
    gradient.addColorStop(0.5, config.bgColor2 || '#16213e');
    gradient.addColorStop(1, config.bgColor3 || '#0f3460');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // 装饰圆形
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.arc(
        Math.random() * width,
        Math.random() * height,
        Math.random() * 150 + 50,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  }

  private roundRect(
    ctx: CanvasRenderingContext2D, 
    x: number, 
    y: number, 
    width: number, 
    height: number, 
    radius: number
  ) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
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

// QQMusicService 服务
class QQMusicService extends Service {
  public api: QQMusicInternalAPI;
  public qrLogin: QQMusicQRLogin;
  private cacheDir: string;
  private tempDir: string;
  private serviceLogger: Logger;
  private currentDownloads = 0;
  private downloadQueue: Array<() => void> = [];
  private maxConcurrent: number;
  private serviceConfig: any;

  constructor(ctx: Context, config: any) {
    super(ctx, 'qqMusic', true);
    this.serviceConfig = config;
    this.serviceLogger = ctx.logger('qq-music');
    this.api = new QQMusicInternalAPI(config.cookies || '', this.serviceLogger);
    this.qrLogin = new QQMusicQRLogin(this.serviceLogger);
    this.maxConcurrent = config.concurrentDownloads || 3;
    
    // 设置目录
    const baseDir = config.downloadDir 
      ? (path.isAbsolute(config.downloadDir) 
        ? config.downloadDir 
        : path.join(ctx.baseDir, config.downloadDir))
      : path.join(ctx.baseDir, 'data', 'music-qq');
    
    this.cacheDir = path.join(baseDir, 'cache');
    this.tempDir = path.join(baseDir, 'temp');
    
    this.createDirectories();
  }

  static inject = ['http'];

  private async createDirectories(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.cacheDir, { recursive: true }),
      fs.mkdir(this.tempDir, { recursive: true }),
    ]);
  }

  updateCookies(cookies: string): void {
    this.api.updateCookies(cookies);
  }

  getCookies(): string {
    return this.api.getCookies();
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  getTempDir(): string {
    return this.tempDir;
  }

  // 搜索歌曲
  async search(keyword: string, limit: number = 5): Promise<SongInfo[]> {
    const list = await this.api.search(keyword, limit);
    return list.map((song: any) => ({
      mid: song.songmid,
      name: song.songname,
      singer: song.singer.map((s: any) => s.name).join('/'),
      album: song.albumname,
      albumMid: song.albummid,
      duration: song.interval,
      songId: song.songid,
      payInfo: song.pay,
      quality: song.sizeflac > 0 ? 999 : song.size320 > 0 ? 320 : 128,
      cover: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.albummid}.jpg`,
    }));
  }

  // 下载歌曲
  async downloadSong(songMid: string, songName: string, quality: number = 128): Promise<string | null> {
    if (this.currentDownloads >= this.maxConcurrent) {
      await new Promise<void>(resolve => this.downloadQueue.push(resolve));
    }
    this.currentDownloads++;

    try {
      const { url } = await this.api.getSongUrl(songMid, quality);
      if (!url) {
        this.serviceLogger.debug(`无法获取播放链接: ${songName}`);
        return null;
      }

      const safeName = sanitizeFilename(songName);
      const fileName = `${safeName}_${songMid}_${quality}_${Date.now()}.mp3`;
      const filePath = path.join(this.cacheDir, fileName);

      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://y.qq.com',
        },
      });

      await fs.writeFile(filePath, response.data);

      // 检查文件大小
      const stats = await fs.stat(filePath);
      if (stats.size < 102400) { // 小于100KB认为无效
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
  async getLyrics(songMid: string): Promise<string | null> {
    const { lyric } = await this.api.getLyric(songMid);
    return lyric;
  }

  // 清理缓存
  async cleanCache(maxAge: number = 24 * 3600 * 1000): Promise<void> {
    try {
      const now = Date.now();
      const files = await fs.readdir(this.cacheDir).catch(() => [] as string[]);
      
      for (const file of files) {
        const filePath = path.join(this.cacheDir, file);
        try {
          const stats = await fs.stat(filePath);
          if (now - stats.mtimeMs > maxAge) {
            await fs.unlink(filePath);
            this.serviceLogger.info('清理过期缓存:', file);
          }
        } catch {}
      }
    } catch (error: any) {
      this.serviceLogger.error('清理缓存失败:', error.message);
    }
  }
}

// 配置 Schema
const ImageConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('启用图片展示'),
  width: Schema.number().default(800).min(400).max(1200).description('图片宽度'),
  bgColor1: Schema.string().default('#1a1a2e').description('背景色1'),
  bgColor2: Schema.string().default('#16213e').description('背景色2'),
  bgColor3: Schema.string().default('#0f3460').description('背景色3'),
  headerColor: Schema.string().default('#ffffff').description('标题颜色'),
  songNameColor: Schema.string().default('#ffffff').description('歌曲名颜色'),
  songNameSize: Schema.number().default(22).description('歌曲名字号'),
  metaColor: Schema.string().default('#cccccc').description('元信息颜色'),
  metaSize: Schema.number().default(18).description('元信息字号'),
  numberBgColor: Schema.string().default('#667eea').description('序号背景色'),
  numberColor: Schema.string().default('#ffffff').description('序号颜色'),
  qualityColor: Schema.string().default('#ff6b6b').description('高品质标识颜色'),
  durationColor: Schema.string().default('#aaaaaa').description('时长颜色'),
  footerColor: Schema.string().default('#aaaaaa').description('页脚颜色'),
});

const TextConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('启用文本列表（作为聊天记录合并发送）'),
  format: Schema.string().default('{n}. {name} ({singer})').description(
    '文本格式，可用变量：{n}序号, {name}歌曲名, {singer}歌手, {album}专辑, {duration}时长'
  ),
  maxLength: Schema.number().default(30).min(10).max(100).description('歌曲名最大长度（超出截断）'),
});

const VoiceConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('发送QQ语音'),
  sendFirst: Schema.boolean().default(false).description('优先发送语音（在图片之前）'),
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
  maxLength: Schema.number().default(500).min(0).max(2000).description('歌词最大长度（0为不限制）'),
  sendAsForward: Schema.boolean().default(true).description('将歌词作为合并转发消息发送'),
});

const CacheConfig = Schema.object({
  autoClean: Schema.boolean().default(true).description('启用自动清理缓存'),
  cleanInterval: Schema.number().default(24).min(1).max(168).description('清理间隔（小时）'),
  maxAge: Schema.number().default(24).min(1).max(168).description('缓存文件最大保留时间（小时）'),
});

const GroupConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('在群聊中启用'),
  maxResults: Schema.number().default(5).min(1).max(20).description('搜索结果数量'),
  image: ImageConfig.description('图片设置'),
  text: TextConfig.description('文本列表设置'),
  voice: VoiceConfig.description('语音设置'),
  lyrics: LyricsConfig.description('歌词设置'),
  cooldown: Schema.number().default(10).min(0).max(300).description('冷却时间（秒）'),
  maxDuration: Schema.number().default(600).min(0).description('最大时长限制（秒，0无限制）'),
  vipTip: Schema.boolean().default(true).description('VIP歌曲提示'),
});

const PrivateConfig = Schema.object({
  enabled: Schema.boolean().default(true).description('在私聊中启用'),
  maxResults: Schema.number().default(8).min(1).max(20).description('搜索结果数量'),
  image: ImageConfig.description('图片设置'),
  text: TextConfig.description('文本设置'),
  voice: VoiceConfig.description('语音设置'),
  lyrics: LyricsConfig.description('歌词设置'),
  cooldown: Schema.number().default(0).min(0).max(300).description('冷却时间（秒）'),
  maxDaily: Schema.number().default(50).min(0).description('每日最大次数（0无限制）'),
  vipTip: Schema.boolean().default(true).description('VIP歌曲提示'),
});

const UsageExampleConfig = Schema.object({
  example: Schema.string().role('textarea').default(
    '🎵 QQ音乐点歌插件使用说明\n\n' +
    '【点歌命令】\n' +
    '点歌 + 歌曲名\n' +
    '例如：点歌 周杰伦晴天\n' +
    '      点歌 陈奕迅 十年\n\n' +
    '【登录命令】\n' +
    '登录 扫码 - 扫码登录QQ音乐\n' +
    '登录 cookies - 手动输入Cookies\n\n' +
    '【选择歌曲】\n' +
    '搜索后回复数字 1-N 选择\n' +
    '回复 0 取消选择\n\n' +
    '【模板变量】\n' +
    '{musicname} - 歌曲名称\n' +
    '{singer}    - 歌手名称\n' +
    '{album}     - 专辑名称\n' +
    '{img}       - 专辑封面图片\n\n' +
    '【文本格式变量】\n' +
    '{n}         - 序号\n' +
    '{name}      - 歌曲名\n' +
    '{singer}    - 歌手\n' +
    '{album}     - 专辑\n' +
    '{duration}  - 时长'
  ).disabled().description('使用说明'),
});

// 配置类型定义
interface ConfigType {
  cookies: string;
  port: number;
  downloadDir: string;
  defaultQuality: 128 | 320 | 999;
  commandPrefix: string;
  group: any;
  private: any;
  cache: any;
  usage: any;
  adminUsers: string[];
  blacklist: string[];
}

export const Config: Schema<ConfigType> = Schema.intersect([
  Schema.object({
    cookies: Schema.string().role('textarea').default('').description(
      'QQ音乐Cookies（扫码登录后会自动更新，也可手动粘贴）'
    ),
    port: Schema.number().default(3300).min(1000).max(65535).description('内部API服务端口（一般无需修改）'),
    downloadDir: Schema.string().default('data/music-qq').description(
      '下载目录（绝对路径或相对于Koishi根目录的相对路径）'
    ),
    defaultQuality: Schema.union([
      Schema.const(128).description('标准 128kbps'),
      Schema.const(320).description('高品质 320kbps'),
      Schema.const(999).description('无损 FLAC')
    ]).default(128).description('默认音质'),
    commandPrefix: Schema.string().default('点歌').description('点歌命令前缀（正则匹配）'),
  }),
  Schema.object({ group: GroupConfig }),
  Schema.object({ private: PrivateConfig }),
  Schema.object({ cache: CacheConfig }),
  Schema.object({ usage: UsageExampleConfig }),
  Schema.object({
    adminUsers: Schema.array(Schema.string()).default([]).description('管理员用户ID'),
    blacklist: Schema.array(Schema.string()).default([]).description('黑名单用户ID'),
  }),
]);

export const name = 'koishi-plugin-voice-qqmusic';
export const inject = ['http'];

// 全局状态
const cooldowns = new Map<string, number>();
const dailyLimits = new Map<string, { count: number; date: string }>();
const userLocks = new Set<string>();
const searchSessions = new Map<string, SearchSession>();
const qrLoginSessions = new Map<string, { qrsig: string; interval?: NodeJS.Timeout }>();

export function apply(ctx: Context, config: ConfigType) {
  // 初始化服务
  ctx.plugin(QQMusicService, {
    cookies: config.cookies,
    downloadDir: config.downloadDir,
    concurrentDownloads: 3,
  });
  
  const canvasService = new CanvasRenderService(ctx.logger('qq-music-canvas'));

  // 自动清理缓存
  let cleanInterval: NodeJS.Timeout;
  if (config.cache?.autoClean) {
    cleanInterval = setInterval(() => {
      const maxAge = (config.cache?.maxAge || 24) * 3600 * 1000;
      ctx.qqMusic.cleanCache(maxAge);
    }, (config.cache?.cleanInterval || 24) * 3600 * 1000);
  }

  // 清理过期搜索会话
  const sessionCleaner = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of searchSessions) {
      if (now - session.timestamp > 600000) {
        searchSessions.delete(key);
      }
    }
  }, 300000);

  ctx.on('dispose', () => {
    clearInterval(cleanInterval);
    clearInterval(sessionCleaner);
    for (const [, session] of qrLoginSessions) {
      if (session.interval) clearInterval(session.interval);
    }
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

  // 构建文本列表（用于合并转发）
  function buildTextList(songs: SongInfo[], format: string): string[] {
    return songs.map((song, i) => {
      let text = format
        .replace(/{n}/g, (i + 1).toString())
        .replace(/{name}/g, song.name)
        .replace(/{singer}/g, song.singer)
        .replace(/{album}/g, song.album)
        .replace(/{duration}/g, formatTime(song.duration));
      
      const maxLen = config.group?.text?.maxLength || 30;
      if (text.length > maxLen + 10) {
        text = text.substring(0, maxLen + 10) + '...';
      }
      return text;
    });
  }

  // 发送搜索结果
  async function sendSearchResult(session: Session, songs: SongInfo[], keyword: string): Promise<void> {
    const env = getEnvConfig(session);
    const sessionKey = `${session.userId}:${session.guildId || 'private'}`;
    
    searchSessions.set(sessionKey, { songs, keyword, timestamp: Date.now() });

    const messages: any[] = [];

    // 生成图片
    if (env?.image?.enabled) {
      try {
        const imageBuffer = await canvasService.renderSearchList(songs, keyword, env.image);
        const imagePath = path.join(ctx.qqMusic.getTempDir(), `search_${Date.now()}.png`);
        await fs.writeFile(imagePath, imageBuffer);
        messages.push(h.image('file://' + imagePath));
      } catch (e) {
        ctx.logger.error('图片生成失败:', e);
      }
    }

    // 生成文本列表（合并转发）
    if (env?.text?.enabled) {
      const format = env.text?.format || '{n}. {name} ({singer})';
      const textList = buildTextList(songs, format);
      
      const forwardNodes = textList.map((text) => ({
        type: 'node',
        data: {
          name: 'QQ音乐',
          uin: session.selfId,
          content: text,
        },
      }));

      forwardNodes.push({
        type: 'node',
        data: {
          name: 'QQ音乐',
          uin: session.selfId,
          content: `回复数字 1-${songs.length} 选择歌曲，回复 0 取消`,
        },
      });

      messages.push(h('message', { forward: true }, forwardNodes.map((n: any) => 
        h('message', { userId: session.selfId, nickname: n.data.name }, n.data.content)
      )));
    }

    for (const msg of messages) {
      await session.send(msg);
    }
  }

  // 播放歌曲
  async function playSong(session: Session, song: SongInfo, quality?: number): Promise<string | undefined> {
    const env = getEnvConfig(session);
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
        if (song.payInfo?.pay_play && env?.vipTip) {
          return '💎 该歌曲为VIP专享，请开通会员后播放';
        }
        return '❌ 歌曲下载失败，可能是版权受限或需要登录';
      }

      // 发送语音
      if (env?.voice?.enabled) {
        try {
          const atPrefix = isGroupChat && env.voice.atSender ? h.at(session.userId) + ' ' : '';
          await session.send(atPrefix + h('record', { 
            file: 'file://' + filePath, 
            timeout: (env.voice.timeout || 30) * 1000 
          }));
        } catch (e) {
          ctx.logger.error('语音发送失败:', e);
        }
      }

      // 发送歌词
      if (env?.lyrics?.enabled) {
        const lyrics = await ctx.qqMusic.getLyrics(song.mid);
        if (lyrics) {
          let text = lyrics;
          const maxLen = env.lyrics.maxLength;
          if (maxLen > 0 && text.length > maxLen) {
            text = text.substring(0, maxLen) + '...';
          }
          
          if (env.lyrics.sendAsForward) {
            const lines = text.split('\n').filter((l: string) => l.trim());
            const chunks: string[][] = [];
            for (let i = 0; i < lines.length; i += 20) {
              chunks.push(lines.slice(i, i + 20));
            }
            
            const nodes = chunks.map((chunk, i) => 
              h('message', { 
                userId: session.selfId, 
                nickname: '歌词' 
              }, `📜 歌词 (${i + 1}/${chunks.length}):\n${chunk.join('\n')}`)
            );
            
            await session.send(h('message', { forward: true }, nodes));
          } else {
            await session.send(`📜 歌词：\n${text}`);
          }
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

  // 登录命令
  ctx.command('登录 <type>', 'QQ音乐登录')
    .action(async ({ session }, type) => {
      if (!session) return;
      if (!type) return '请指定登录方式：扫码 或 cookies';

      const userId = session.userId;

      if (type === '扫码') {
        const existing = qrLoginSessions.get(userId);
        if (existing?.interval) clearInterval(existing.interval);

        try {
          const { qrsig, qrBase64 } = await ctx.qqMusic.qrLogin.getQRCode();
          await session.send(h.image(qrBase64));
          await session.send('请使用手机QQ扫描上方二维码，有效期5分钟...');

          const interval = setInterval(async () => {
            try {
              const result = await ctx.qqMusic.qrLogin.checkQRCode(qrsig);
              
              if (result.status === 'scanning') {
                await session.send('📱 已扫描，请在手机上确认登录');
              } else if (result.status === 'success' && result.cookies) {
                clearInterval(interval);
                qrLoginSessions.delete(userId);
                
                ctx.qqMusic.updateCookies(result.cookies);
                config.cookies = result.cookies;
                
                await session.send(`✅ 登录成功！${result.nickname ? `欢迎，${result.nickname}` : ''}\nCookies已自动保存到配置中。`);
              } else if (result.status === 'expired') {
                clearInterval(interval);
                qrLoginSessions.delete(userId);
                await session.send('⏰ 二维码已过期，请重新登录');
              } else if (result.status === 'error') {
                clearInterval(interval);
                qrLoginSessions.delete(userId);
                await session.send(`❌ 登录失败：${result.msg}`);
              }
            } catch (e: any) {
              ctx.logger.error('轮询失败:', e);
            }
          }, 2000);

          setTimeout(() => {
            const s = qrLoginSessions.get(userId);
            if (s?.interval === interval) {
              clearInterval(interval);
              qrLoginSessions.delete(userId);
              session.send('⏰ 登录超时，请重新发送"登录 扫码"').catch(() => {});
            }
          }, 5 * 60 * 1000);

          qrLoginSessions.set(userId, { qrsig, interval });

        } catch (e: any) {
          return `❌ 获取二维码失败：${e.message}`;
        }
      } else if (type === 'cookies') {
        await session.send('请在30秒内发送你的Cookies字符串（可从浏览器开发者工具获取）：');
        
        try {
          const response = await session.prompt(30000);
          if (!response) {
            return '⏰ 输入超时';
          }
          
          const newCookies = response.trim();
          if (!newCookies.includes('uin=') || !newCookies.includes('skey=')) {
            return '❌ 无效的Cookies格式，需要包含 uin 和 skey 字段';
          }
          
          ctx.qqMusic.updateCookies(newCookies);
          config.cookies = newCookies;
          
          return '✅ Cookies已更新并保存到配置';
        } catch (e) {
          return '⏰ 输入超时';
        }
      } else {
        return '未知的登录方式，请使用：扫码 或 cookies';
      }
    });

  // 点歌命令（正则匹配）
  const commandPrefix = config.commandPrefix || '点歌';
  const musicPattern = new RegExp(`^${commandPrefix}\\s*[+\\-]?\\s*(.+)$`);
  
  ctx.middleware(async (session, next) => {
    const content = session.content?.trim() || '';
    if (!content) return next();

    const match = content.match(musicPattern);
    if (!match) return next();

    const keyword = match[1].trim();
    if (!keyword) {
      await session.send(`请输入歌曲名，例如：${commandPrefix} 周杰伦 晴天`);
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

    // 检查是否是选择数字
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
      const maxResults = env?.maxResults || 5;
      const songs = await ctx.qqMusic.search(keyword, maxResults);
      
      if (songs.length === 0) {
        await session.send('❌ 未找到相关歌曲');
        return;
      }

      await sendSearchResult(session, songs, keyword);
      
    } catch (err: any) {
      ctx.logger.error('点歌失败:', err);
      await session.send('❌ 搜索失败，请检查Cookies是否有效');
    }
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
        
        const cookiePreview = config.cookies 
          ? `${config.cookies.substring(0, 50)}...` 
          : '未设置';
        
        return [
          '📊 QQ音乐点歌系统状态',
          `Cookies: ${cookiePreview}`,
          `缓存文件: ${files.length} 个`,
          `缓存大小: ${(size / 1024 / 1024).toFixed(1)} MB`,
          `下载目录: ${config.downloadDir}`,
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

  // 管理命令：更新Cookies
  ctx.command('qqmusic.setcookies <cookies:text>', '更新Cookies', { authority: 4 })
    .action(async ({ session }, cookies) => {
      if (!cookies) return '请提供Cookies';
      ctx.qqMusic.updateCookies(cookies);
      config.cookies = cookies;
      return '✅ Cookies已更新';
    });
}
