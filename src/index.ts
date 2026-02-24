// src/index.ts
/**
 * Koishi 插件 - QQ 音乐点歌
 * 支持扫码登录、自动续期、搜索、播放、歌词显示、图片列表、自定义消息格式等
 */
import { Context, Schema, Service, h, Session, Logger } from 'koishi';
import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import * as qrLogin from './qrlogin'; // 引入扫码登录模块

// 声明模块扩展
declare module 'koishi' {
  interface Context {
    qqMusic: QQMusicService;
    puppeteer: any;
  }
}

// 反爬 UA 池（保持不变）
const USER_AGENTS = [ /* ... 同前 ... */ ];

// 工具函数
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/{{(\w+)}}/g, (match, key) => vars[key] ?? match);
}

async function downloadFile(url: string, filePath: string, timeout: number = 30000): Promise<void> {
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout,
    headers: {
      'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
    }
  });
  const writer = await fs.open(filePath, 'w');
  try {
    const writeStream = writer.createWriteStream();
    await pipeline(Readable.from(response.data), writeStream);
  } finally {
    await writer.close();
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(s: number): string {
  const minutes = Math.floor(s / 60);
  const seconds = Math.floor(s % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function buildSongListHTML(songs: SongInfo[], keyword: string): string {
  // ... 同前，保持不变 ...
  return `...`;
}

async function htmlToImage(html: string, outputPath: string, ctx: Context): Promise<string | null> {
  // ... 同前，保持不变 ...
  return outputPath;
}

// ---------- 类型定义 ----------
interface RawSong { /* ... 同前 ... */ }
interface VkeyResponse { /* ... 同前 ... */ }
interface LyricResponse { /* ... 同前 ... */ }
interface PlaylistResponse { /* ... 同前 ... */ }

interface SongInfo {
  mid: string;
  name: string;
  singer: string;
  album: string;
  duration: number;
  songId: number;
  payInfo: any;
  quality: number;
}

// 新的用户登录态接口（基于 musickey）
interface UserSession {
  musickey: string;
  refreshToken: string;
  expiresAt: number; // 毫秒时间戳
  loginType: 'qq' | 'wechat'; // 保留字段
}

// ---------- QQMusicService ----------
class QQMusicService extends Service {
  private serviceConfig: QQMusicServiceConfig;
  private cacheDir: string;
  private tempDir: string;
  private guid: string;
  private serviceLogger: Logger;
  private static readonly MAX_CONCURRENT = 3;
  private currentDownloads = 0;
  private downloadQueue: Array<() => void> = [];

  // 用户登录态存储
  private userSessions = new Map<string, UserSession>();
  // 存储正在进行的登录流程（用于轮询控制和状态推送）
  private loginProcesses = new Map<string, {
    stopPolling: () => void;
    userId: string;
  }>();

  // 持久化文件路径
  private sessionsFile: string;

  constructor(ctx: Context, config: QQMusicServiceConfig) {
    super(ctx, 'qqMusic', true);
    this.serviceConfig = config;
    this.serviceLogger = ctx.logger('qq-music');
    this.guid = this.generateGuid();
    this.cacheDir = path.join(ctx.baseDir, 'data', 'music-qq', 'cache');
    this.tempDir = path.join(ctx.baseDir, 'data', 'music-qq', 'temp');
    this.sessionsFile = path.join(ctx.baseDir, 'data', 'music-qq', 'sessions.json');
    
    this.createDirectories().catch((err: any) => {
      this.serviceLogger.error('创建目录失败:', err);
    });
  }

  static inject = ['http'];

  private generateGuid(): string {
    return Math.floor(Math.random() * 2147483647).toString();
  }

  private async createDirectories(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.cacheDir, { recursive: true }),
      fs.mkdir(this.tempDir, { recursive: true })
    ]);
  }

  // ---------- 登录相关方法 ----------

  /**
   * 启动登录流程，返回二维码
   */
  async startLogin(userId: string): Promise<string> {
    // 检查是否已有登录流程
    if (this.loginProcesses.has(userId)) {
      throw new Error('已有登录流程进行中，请先完成或等待超时');
    }

    // 1. 获取二维码
    const { qrsig, qrBase64 } = await qrLogin.getQRCode();

    // 2. 启动后台轮询
    const stopPolling = this.startPolling(userId, qrsig);

    // 3. 记录进程
    this.loginProcesses.set(userId, { stopPolling, userId });

    // 4. 返回二维码 Base64
    return qrBase64;
  }

  /**
   * 开始轮询二维码状态
   */
  private startPolling(userId: string, qrsig: string): () => void {
    const interval = setInterval(async () => {
      try {
        const result = await qrLogin.checkQRCode(qrsig);
        
        switch (result.status) {
          case 'scanning':
            // 已扫描，等待确认
            this.sendToUser(userId, '📱 已扫描，请在手机上确认登录');
            break;
          
          case 'success':
            // 登录成功，获取最终令牌
            clearInterval(interval);
            this.loginProcesses.delete(userId);
            
            if (!result.redirectUrl) {
              this.sendToUser(userId, '❌ 登录失败：未获取到重定向地址');
              return;
            }

            try {
              const tokenData = await qrLogin.getMusicKeyFromRedirect(result.redirectUrl);
              const expiresAt = Date.now() + tokenData.expiresIn * 1000;
              
              const session: UserSession = {
                musickey: tokenData.musickey,
                refreshToken: tokenData.refreshToken,
                expiresAt,
                loginType: 'qq',
              };
              
              this.userSessions.set(userId, session);
              this.scheduleRefresh(userId, tokenData.expiresIn);
              await this.saveSessions(); // 持久化
              
              this.sendToUser(userId, '✅ QQ音乐登录成功！现在可以点歌了。');
            } catch (err) {
              this.sendToUser(userId, `❌ 获取登录凭证失败: ${err.message}`);
            }
            break;
          
          case 'expired':
            clearInterval(interval);
            this.loginProcesses.delete(userId);
            this.sendToUser(userId, '⏰ 二维码已过期，请重新发送登录命令');
            break;
          
          // waiting 状态不处理，继续轮询
        }
      } catch (err) {
        this.serviceLogger.error(`轮询出错 (用户${userId}):`, err);
        // 不停止轮询，继续尝试
      }
    }, 2000);

    // 设置 5 分钟超时
    const timeout = setTimeout(() => {
      clearInterval(interval);
      if (this.loginProcesses.has(userId)) {
        this.loginProcesses.delete(userId);
        this.sendToUser(userId, '⏰ 登录超时，请重新发送命令');
      }
    }, 5 * 60 * 1000);

    // 返回停止函数（合并清除 interval 和 timeout）
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }

  /**
   * 安排自动刷新
   */
  private scheduleRefresh(userId: string, expiresIn: number) {
    // 提前 3 天刷新（假设 expiresIn 是秒）
    const refreshMs = Math.max(0, (expiresIn - 3 * 24 * 3600) * 1000);
    
    setTimeout(async () => {
      const session = this.userSessions.get(userId);
      if (!session || !session.refreshToken) return;

      try {
        const newToken = await qrLogin.refreshMusicKey(session.refreshToken);
        session.musickey = newToken.musickey;
        session.refreshToken = newToken.refreshToken;
        session.expiresAt = Date.now() + newToken.expiresIn * 1000;
        
        await this.saveSessions();
        this.scheduleRefresh(userId, newToken.expiresIn); // 安排下一次
        this.serviceLogger.info(`用户 ${userId} token 已自动刷新`);
      } catch (err) {
        this.serviceLogger.error(`用户 ${userId} token 刷新失败:`, err);
        // 刷新失败，标记为过期
        this.userSessions.delete(userId);
        await this.saveSessions();
        this.sendToUser(userId, '⚠️ QQ音乐登录已过期，请重新登录');
      }
    }, refreshMs);
  }

  /**
   * 向用户发送私聊消息
   */
  private async sendToUser(userId: string, message: string) {
    try {
      await this.ctx.broadcast([`private:${userId}`], message);
    } catch (err) {
      this.serviceLogger.warn(`发送消息给用户 ${userId} 失败:`, err);
    }
  }

  /**
   * 获取用户 Cookie 字符串（用于 API 请求）
   */
  getUserCookie(userId: string): string | null {
    const session = this.userSessions.get(userId);
    if (!session) return null;
    
    if (Date.now() >= session.expiresAt) {
      this.userSessions.delete(userId);
      this.saveSessions(); // 异步，不等待
      return null;
    }
    
    // 构造标准 Cookie 字符串（包含 musickey）
    // 注意：QQ 音乐可能需要 uin 等其他字段，这里仅用 musickey 简化
    return `musickey=${session.musickey};`;
  }

  /**
   * 检查用户是否已登录
   */
  isLoggedIn(userId: string): boolean {
    const cookie = this.getUserCookie(userId);
    return cookie !== null;
  }

  /**
   * 退出登录
   */
  logout(userId: string) {
    this.userSessions.delete(userId);
    this.saveSessions();
  }

  // ---------- 持久化 ----------
  async loadSessions() {
    try {
      const data = await fs.readFile(this.sessionsFile, 'utf-8');
      const sessions = JSON.parse(data);
      for (const [userId, s] of Object.entries(sessions)) {
        const session = s as UserSession;
        this.userSessions.set(userId, session);
        // 重新安排刷新定时器
        if (session.expiresAt > Date.now()) {
          const remainingSec = Math.floor((session.expiresAt - Date.now()) / 1000);
          this.scheduleRefresh(userId, remainingSec);
        }
      }
      this.serviceLogger.info(`已加载 ${this.userSessions.size} 个用户登录态`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.serviceLogger.error('加载 sessions 失败:', err);
      }
    }
  }

  async saveSessions() {
    try {
      const sessions = Object.fromEntries(this.userSessions);
      await fs.writeFile(this.sessionsFile, JSON.stringify(sessions, null, 2));
    } catch (err) {
      this.serviceLogger.error('保存 sessions 失败:', err);
    }
  }

  // ---------- 原有的业务方法（需适配新登录态）----------
  async search(keyword: string, userId: string, limit: number = 5): Promise<SongInfo[]> {
    const cookie = this.getUserCookie(userId);
    if (!cookie) throw new Error('用户未登录或登录已过期');
    
    // 原有 search 逻辑，使用 cookie 变量
    // ... 复制之前的 search 实现，但将 cookies 参数改为内部使用
    const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp';
    const params = {
      ct: 24, qqmusic_ver: 1298, new_json: 1, remoteplace: 'txt.yqq.center',
      searchid: Math.floor(Math.random() * 1000000000), t: 0, aggr: 1, cr: 1,
      catZhida: 1, lossless: 0, flag_qc: 0, p: 1, n: limit, w: keyword,
      g_tk: 5381,
      // 注意：loginUin 从 cookie 提取
      loginUin: this.extractUinFromCookie(cookie),
      hostUin: 0, format: 'json', inCharset: 'utf8', outCharset: 'utf-8',
      notice: 0, platform: 'yqq', needNewCode: 0
    };

    try {
      const randomUA = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const { data } = await this.ctx.http.get(url, {
        params,
        headers: {
          'Referer': 'https://y.qq.com',
          'Cookie': cookie,
          'User-Agent': randomUA,
          // ... 其他头
        }
      });
      // ... 原有解析逻辑
      return result.data.song.list.map((song: RawSong) => ({ /* ... */ }));
    } catch (error) {
      this.serviceLogger.error('搜索失败:', error);
      throw new Error('搜索歌曲失败');
    }
  }

  // 从 cookie 中提取 uin 的辅助方法
  private extractUinFromCookie(cookie: string): string {
    const match = cookie.match(/uin=o?(\d+)/);
    return match ? match[1] : '0';
  }

  // 其他方法（getPlayUrl, downloadSong, getLyrics, getUserPlaylists, cleanCache）保持不变，
  // 但需要将参数中的 cookies: string 改为从内部获取或通过 userId 获取。
  // 为保持简洁，此处省略，实际需逐一适配。
  
  // 示例：getPlayUrl 需要 userId 参数
  async getPlayUrl(songMid: string, userId: string, quality?: number): Promise<{ url: string | null; type: 'success' | 'vip' | 'error'; quality: number }> {
    const cookie = this.getUserCookie(userId);
    if (!cookie) throw new Error('未登录');
    // ... 原有逻辑
  }

  // downloadSong, getLyrics, getUserPlaylists 同理
}

// ---------- 配置 Schema 和 apply 函数 ----------
// ... 所有 Config 定义和 Schema 保持不变 ...

export const inject = {
  required: ['http'],
  optional: ['puppeteer'], // puppeteer 可选（用于图片生成）
};

// 全局变量
const cooldowns = new Map<string, number>();
const dailyLimits = new Map<string, { count: number; date: string }>();
const userLocks = new Set<string>();

setInterval(() => {
  // ... 清理 cooldowns 和 dailyLimits 的逻辑
}, 86400000);

export function apply(ctx: Context, config: Config) {
  // 注册服务
  ctx.plugin(QQMusicService, {
    defaultQuality: config.defaultQuality,
    cacheExpire: config.advanced?.cacheExpire ?? 24,
    userAgent: config.advanced?.userAgent ?? 'Mozilla/5.0',
    requestTimeout: config.advanced?.requestTimeout ?? 30000
  });

  // 加载持久化的 sessions
  ctx.on('ready', async () => {
    await ctx.qqMusic.loadSessions();
  });

  // 保存 sessions 到磁盘（定期保存 + 退出时保存）
  const saveInterval = setInterval(() => {
    ctx.qqMusic.saveSessions();
  }, 30 * 60 * 1000); // 30分钟保存一次

  ctx.on('dispose', () => {
    clearInterval(saveInterval);
    ctx.qqMusic.saveSessions();
    const tempDir = path.join(ctx.baseDir, 'data', 'music-qq', 'temp');
    fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // 辅助函数
  function isGroup(session: Session): boolean { return !!session.guildId; }
  function getEnvConfig(session: Session) { return isGroup(session) ? config.group : config.private; }
  function getMessageFormat(session: Session) { return getEnvConfig(session)?.messageFormat; }

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
      session.send(`⏳ 请等待 ${wait} 秒`).catch(() => {});
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
    const userId = session.userId;
    if (config.blacklist?.includes(userId)) {
      session.send('❌ 你已被列入黑名单').catch(() => {});
      return false;
    }
    if (config.whitelist?.length > 0 && !config.whitelist?.includes(userId)) {
      session.send('❌ 你不在白名单中').catch(() => {});
      return false;
    }
    return true;
  }

  // 构建消息的函数（保持不变）
  function buildSongInfoMessage(song: SongInfo, format: any): string { /* ... */ }
  function buildLyricsMessage(lyrics: string, format: any): string { /* ... */ }

  async function sendSearchResult(session: Session, songs: SongInfo[], keyword: string): Promise<boolean> {
    // ... 保持不变 ...
  }

  async function playSong(session: Session, song: SongInfo, quality?: number): Promise<string | undefined> {
    const env = getEnvConfig(session);
    const format = getMessageFormat(session);
    const isGroupChat = isGroup(session);

    if (isGroupChat && env?.maxDuration > 0 && song.duration > env.maxDuration) {
      return `❌ 歌曲过长（限制 ${formatTime(env.maxDuration)}）`;
    }

    const lockKey = `${session.userId}:${song.mid}`;
    if (userLocks.has(lockKey)) return '⏳ 正在处理中，请稍候...';
    userLocks.add(lockKey);

    try {
      // 检查登录态
      if (!ctx.qqMusic.isLoggedIn(session.userId)) {
        return '❌ 你还未登录 QQ 音乐，请使用“QQ音乐登录”命令扫码登录';
      }

      await session.send(`⏳ 正在准备：${song.name}...`);

      const actualQuality = quality || format?.voice?.quality || config.defaultQuality;
      // downloadSong 需要适配，传入 userId
      const filePath = await ctx.qqMusic.downloadSong(song.mid, song.name, actualQuality, session.userId);

      if (!filePath) {
        const { type } = await ctx.qqMusic.getPlayUrl(song.mid, session.userId, actualQuality);
        if (type === 'vip' && env?.vipTip) return '💎 该歌曲为 VIP 专享，请开通会员后播放';
        return '❌ 歌曲下载失败，可能是版权受限或链接失效';
      }

      const lyricsPromise = format?.lyrics?.enabled ? ctx.qqMusic.getLyrics(song.mid, format.lyrics.showTimestamp, session.userId) : Promise.resolve(null);

      // ... 发送语音和消息的逻辑保持不变 ...

      return undefined;
    } catch (err) {
      ctx.logger.error('播放失败:', err);
      return '❌ 播放失败，请稍后重试';
    } finally {
      userLocks.delete(lockKey);
    }
  }

  // ---------- 新登录命令 ----------
  ctx.command('QQ音乐登录', 'QQ音乐扫码登录（首次需扫码，后续自动续期）')
    .userFields(['authority'])
    .action(async ({ session }) => {
      if (!session) return;
      if (session.guildId) {
        return '❌ 该命令仅支持私聊使用，请在私聊中发送';
      }
      if (!isAdmin(session)) {
        return '❌ 你没有权限使用该命令';
      }

      try {
        const qrBase64 = await ctx.qqMusic.startLogin(session.userId);
        await session.send(h.image(qrBase64));
        await session.send('请使用手机QQ扫描上方二维码登录，有效期5分钟。\n登录成功后会自动保存，后续无需再次扫码。');
        return; // 登录结果将通过私聊推送
      } catch (err) {
        return `❌ 启动登录失败: ${err.message}`;
      }
    });

  // 退出登录命令
  ctx.command('QQ音乐退出登录', '退出当前QQ音乐账号')
    .action(async ({ session }) => {
      if (!session) return;
      ctx.qqMusic.logout(session.userId);
      return '✅ 已退出登录';
    });

  // 点歌命令（适配新登录态）
  const musicCmd = ctx.command('点歌 <keyword:text>', '搜索并播放 QQ 音乐')
    .alias('qq点歌', 'music')
    .option('n', '-n <num:number>', { fallback: 1 })
    .option('q', '-q <quality:number>', { fallback: 0 });

  musicCmd.action(async ({ session, options, args }) => {
    const keyword = args?.[0] as string;
    if (!keyword) return '请输入歌曲名，如：点歌 周杰伦 晴天';

    if (!checkPermission(session)) return;
    if (!checkCooldown(session)) return;
    if (!checkDailyLimit(session)) return;

    // 检查登录态
    if (!ctx.qqMusic.isLoggedIn(session.userId)) {
      return '❌ 请先在私聊中使用“QQ音乐登录”命令扫码登录';
    }

    const env = getEnvConfig(session);
    await session.send('🔍 搜索中...');

    try {
      // search 方法需要传入 userId
      let songs: SongInfo[] = [];
      const retryTimes = config.search?.retryTimes ?? 3;
      for (let i = 0; i < retryTimes; i++) {
        try {
          songs = await ctx.qqMusic.search(keyword, session.userId, env?.maxResults ?? 5);
          if (songs.length > 0) break;
        } catch (e) {
          if (i === retryTimes - 1) throw e;
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (songs.length === 0) return config.search?.fuzzyMatch === false ? '❌ 未找到精确匹配' : '❌ 未找到相关歌曲';

      const n = Number(options?.n ?? 0);
      if (n > 0 && n <= songs.length) return await playSong(session, songs[n - 1], Number(options?.q)) ?? '';
      if (n > songs.length) return `❌ 只有 ${songs.length} 首结果`;

      const listSent = await sendSearchResult(session, songs, keyword);
      if (!listSent) return '❌ 发送失败';

      try {
        const res = await session.prompt(60000);
        if (!res || res === '0') return '已取消';
        const selectNum = parseInt(res);
        if (isNaN(selectNum) || selectNum < 1 || selectNum > songs.length) return '❌ 无效选择';
        const result = await playSong(session, songs[selectNum - 1], Number(options?.q));
        return result ?? '';
      } catch (promptErr) {
        return '⏰ 选择超时，请重新点歌';
      }
    } catch (err) {
      ctx.logger.error('点歌失败:', err);
      return '❌ 搜索失败，请检查配置';
    }
  });

  // 我的歌单命令（需适配 userId）
  ctx.command('我的歌单', '查看 QQ 音乐歌单')
    .action(async ({ session }) => {
      if (!ctx.qqMusic.isLoggedIn(session.userId)) {
        return '❌ 请先使用“QQ音乐登录”命令登录';
      }
      try {
        const list = await ctx.qqMusic.getUserPlaylists(session.userId);
        if (list.length === 0) return '📂 没有找到歌单';
        return '📚 我的歌单：\n' + list.map((p, i) => `${i + 1}. ${p.name} (${p.count}首)`).join('\n');
      } catch (error) {
        return '❌ 获取歌单失败';
      }
    });

  // 其他命令（点歌状态、清理音乐缓存）保持不变
  ctx.command('点歌状态', '查看点歌系统状态')
    .userFields(['authority'])
    .action(async ({ session }) => {
      if (!isAdmin(session)) return '❌ 无权使用';
      // ... 原有逻辑
    });

  ctx.command('清理音乐缓存', '手动清理过期缓存')
    .userFields(['authority'])
    .action(async ({ session }) => {
      if (!isAdmin(session)) return '❌ 无权使用';
      await ctx.qqMusic.cleanCache();
      return '✅ 缓存清理完成';
    });
}
