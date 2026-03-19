// src/api.ts
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { Logger } from 'koishi';

// QQ音乐 API 内部实现
export class QQMusicInternalAPI {
  private http: AxiosInstance;
  private cookies: string;
  private logger: Logger;
  private guid: string;
  private uin: string = '0';

  constructor(cookies: string = '', logger?: Logger) {
    this.cookies = cookies;
    this.logger = logger || console as any;
    this.guid = this.generateGuid();
    this.http = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://y.qq.com',
        'Cookie': this.cookies,
      },
    });
    this.extractUin();
  }

  updateCookies(cookies: string): void {
    this.cookies = cookies;
    this.http.defaults.headers['Cookie'] = cookies;
    this.extractUin();
  }

  getCookies(): string {
    return this.cookies;
  }

  private extractUin(): void {
    const match = this.cookies.match(/uin=o?(\d+)/);
    this.uin = match ? match[1] : '0';
  }

  private generateGuid(): string {
    return Math.floor(Math.random() * 2147483647).toString();
  }

  // 搜索歌曲
  async search(keyword: string, pageSize: number = 5): Promise<any[]> {
    const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp';
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
      n: pageSize,
      w: keyword,
      g_tk: 5381,
      loginUin: this.uin,
      hostUin: 0,
      format: 'json',
      inCharset: 'utf8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq',
      needNewCode: 0,
    };

    try {
      const { data } = await this.http.get(url, { params });
      
      let jsonData = data;
      if (typeof data === 'string') {
        const jsonStr = data.replace(/^(?:MusicJsonCallback|callback)\(/, '').replace(/\);\s*$/, '');
        jsonData = JSON.parse(jsonStr);
      }

      if (!jsonData.data?.song?.list) {
        return [];
      }

      return jsonData.data.song.list.map((song: any) => ({
        songmid: song.mid,
        songname: song.name,
        singer: song.singer?.map((s: any) => ({ name: s.name })) || [],
        albumname: song.album?.name || '未知专辑',
        albummid: song.album?.mid || '',
        interval: song.interval || 0,
        songid: song.id,
        pay: song.pay || {},
        size128: song.file?.size_128mp3 || 0,
        size320: song.file?.size_320mp3 || 0,
        sizeflac: song.file?.size_flac || 0,
      }));
    } catch (error: any) {
      this.logger.error('搜索失败:', error.message);
      throw error;
    }
  }

  // 获取播放链接
  async getSongUrl(songmid: string, quality: number = 128): Promise<{ url: string | null; quality: number }> {
    const guid = this.guid;
    const uin = this.uin;
    
    const reqData = {
      req: {
        module: 'CDN.SrfCdnDispatchServer',
        method: 'GetCdnDispatch',
        param: { guid, calltype: 0, userip: '' },
      },
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid,
          songmid: [songmid],
          songtype: [0],
          uin,
          loginflag: 1,
          platform: '20',
        },
      },
      comm: { uin, format: 'json', ct: 24, cv: 0 },
    };

    try {
      const { data } = await this.http.post('https://u.y.qq.com/cgi-bin/musicu.fcg', reqData);
      
      const midUrlInfo = data.req_0?.data?.midurlinfo?.[0];
      if (!midUrlInfo || !midUrlInfo.purl) {
        return { url: null, quality: 0 };
      }

      const url = `https://isure.stream.qqmusic.qq.com/${midUrlInfo.purl}`;
      const actualQuality = this.getQualityFromUrl(midUrlInfo.purl);
      
      return { url, quality: actualQuality };
    } catch (error: any) {
      this.logger.error('获取播放链接失败:', error.message);
      return { url: null, quality: 0 };
    }
  }

  private getQualityFromUrl(purl: string): number {
    if (purl.includes('F000')) return 999;
    if (purl.includes('M800')) return 320;
    return 128;
  }

  // 获取歌词
  async getLyric(songmid: string): Promise<{ lyric: string | null; trans: string | null }> {
    const url = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
    const params = {
      songmid,
      pcachetime: Date.now(),
      g_tk: 5381,
      loginUin: this.uin,
      hostUin: 0,
      format: 'json',
      inCharset: 'utf8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 0,
    };

    try {
      const { data } = await this.http.get(url, { params });
      
      let jsonData = data;
      if (typeof data === 'string') {
        const jsonStr = data.replace(/^(?:MusicJsonCallback|callback)\(/, '').replace(/\);\s*$/, '');
        jsonData = JSON.parse(jsonStr);
      }

      const lyric = jsonData.lyric ? Buffer.from(jsonData.lyric, 'base64').toString('utf-8') : null;
      const trans = jsonData.trans ? Buffer.from(jsonData.trans, 'base64').toString('utf-8') : null;

      return { lyric, trans };
    } catch (error: any) {
      this.logger.error('获取歌词失败:', error.message);
      return { lyric: null, trans: null };
    }
  }

  // 获取歌曲详情
  async getSongInfo(songmid: string): Promise<any> {
    const url = 'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg';
    const params = {
      songmid,
      format: 'json',
      inCharset: 'utf8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq',
      needNewCode: 0,
    };

    try {
      const { data } = await this.http.get(url, { params });
      return data.data?.[0] || null;
    } catch (error: any) {
      this.logger.error('获取歌曲详情失败:', error.message);
      return null;
    }
  }

  // 获取用户歌单
  async getUserPlaylists(): Promise<any[]> {
    if (this.uin === '0') return [];
    
    const url = 'https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss';
    const params = {
      cv: 10000,
      ct: 24,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 0,
      uin: this.uin,
      hostUin: this.uin,
      sin: 0,
      ein: 19,
      sort: 2,
      g_tk: 5381,
    };

    try {
      const { data } = await this.http.get(url, { params });
      return data.data?.data?.disslist || [];
    } catch (error: any) {
      this.logger.error('获取歌单失败:', error.message);
      return [];
    }
  }
}
