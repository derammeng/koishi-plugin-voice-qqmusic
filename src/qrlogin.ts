// src/qrlogin.ts
import axios from 'axios';
import { Logger } from 'koishi';

const APP_ID = 100497308;
const DAID = 5;
const REDIRECT_URI = 'https://y.qq.com/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// 计算 ptqrtoken
function getQRToken(qrsig: string): string {
  let e = 0;
  for (let i = 0; i < qrsig.length; i++) {
    e += (e << 5) + qrsig.charCodeAt(i);
  }
  return (2147483647 & e).toString();
}

// 解析 Cookie
function parseCookie(cookieStr: string): Record<string, string> {
  const obj: Record<string, string> = {};
  cookieStr.split(';').forEach(pair => {
    const [key, val] = pair.trim().split('=');
    if (key && val) obj[key] = val;
  });
  return obj;
}

export interface QRCodeResult {
  qrsig: string;
  qrBase64: string;
}

export interface QRStatusResult {
  status: 'waiting' | 'scanning' | 'success' | 'expired' | 'error';
  cookies?: string;
  msg?: string;
  nickname?: string;
}

export class QQMusicQRLogin {
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || console as any;
  }

  // 获取二维码
  async getQRCode(): Promise<QRCodeResult> {
    try {
      const response = await axios.get('https://ssl.ptlogin2.qq.com/ptqrshow', {
        params: {
          appid: APP_ID,
          e: '2',
          l: 'M',
          s: '3',
          d: '72',
          v: '4',
          t: Math.random(),
          daid: DAID,
          pt_3rd_aid: APP_ID,
        },
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': USER_AGENT,
          Referer: 'https://xui.ptlogin2.qq.com/',
        },
      });

      // 提取 qrsig
      const setCookie = response.headers['set-cookie'];
      if (!setCookie || !Array.isArray(setCookie)) {
        throw new Error('未获取到 set-cookie');
      }

      const qrsigCookie = setCookie.find(c => c.startsWith('qrsig='));
      if (!qrsigCookie) throw new Error('未找到 qrsig');

      const qrsig = qrsigCookie.split(';')[0].split('=')[1];
      const qrBase64 = `data:image/png;base64,${Buffer.from(response.data).toString('base64')}`;

      return { qrsig, qrBase64 };
    } catch (error: any) {
      this.logger.error('获取二维码失败:', error.message);
      throw error;
    }
  }

  // 检查二维码状态
  async checkQRCode(qrsig: string): Promise<QRStatusResult> {
    try {
      const ptqrtoken = getQRToken(qrsig);
      const params = {
        u1: REDIRECT_URI,
        ptqrtoken,
        ptredirect: 0,
        h: 1,
        t: 1,
        g: 1,
        from_ui: 1,
        ptlang: 2052,
        action: `0-0-${Date.now()}`,
        js_ver: '22070114',
        js_type: 1,
        login_sig: '',
        pt_uistyle: 40,
        aid: APP_ID,
        daid: DAID,
      };

      const { data, headers } = await axios.get('https://ssl.ptlogin2.qq.com/ptqrlogin', {
        params,
        headers: {
          Cookie: `qrsig=${qrsig}`,
          Referer: 'https://xui.ptlogin2.qq.com/',
          'User-Agent': USER_AGENT,
        },
        maxRedirects: 0,
        validateStatus: (status) => status === 200 || status === 302,
      });

      // 解析返回数据 ptuiCB('0','0','url','0','msg','nickname')
      const match = data.match(/ptuiCB\((.*)\)/);
      if (!match) throw new Error('解析响应失败');

      const args = JSON.parse(`[${match[1]}]`);
      const code = args[0];
      const msg = args[4];
      const nickname = args[5];

      switch (code) {
        case '0': // 登录成功
          // 需要跟随重定向获取最终 cookies
          const redirectUrl = args[2];
          const cookies = await this.getCookiesFromRedirect(redirectUrl);
          return { 
            status: 'success', 
            cookies, 
            msg: '登录成功',
            nickname 
          };
        case '65':
          return { status: 'scanning', msg: '已扫描，等待确认' };
        case '66':
          return { status: 'waiting', msg: '等待扫码' };
        case '67':
          return { status: 'expired', msg: '二维码已过期' };
        default:
          return { status: 'error', msg: msg || '未知错误' };
      }
    } catch (error: any) {
      this.logger.error('检查二维码状态失败:', error.message);
      return { status: 'error', msg: error.message };
    }
  }

  // 从重定向 URL 获取 Cookies
  private async getCookiesFromRedirect(redirectUrl: string): Promise<string> {
    try {
      const response = await axios.get(redirectUrl, {
        maxRedirects: 5,
        headers: {
          'User-Agent': USER_AGENT,
          Referer: 'https://xui.ptlogin2.qq.com/',
        },
      });

      // 收集所有 cookies
      const cookies: string[] = [];
      
      // 从最终响应中获取
      if (response.headers['set-cookie']) {
        cookies.push(...response.headers['set-cookie']);
      }

      // 解析关键字段
      const cookieObj = parseCookie(cookies.join('; '));
      
      // 构建标准格式的 cookie 字符串
      const essentialCookies = [
        `uin=o${cookieObj['uin'] || cookieObj['qq_uin'] || ''}`,
        `skey=${cookieObj['skey'] || ''}`,
        `p_skey=${cookieObj['p_skey'] || ''}`,
        `p_uin=${cookieObj['p_uin'] || ''}`,
        `pt4_token=${cookieObj['pt4_token'] || ''}`,
        `musickey=${cookieObj['musickey'] || cookieObj['qqmusic_key'] || ''}`,
        `psrf_qqopenid=${cookieObj['psrf_qqopenid'] || ''}`,
        `psrf_qqaccess_token=${cookieObj['psrf_qqaccess_token'] || ''}`,
        `psrf_qqunionid=${cookieObj['psrf_qqunionid'] || ''}`,
      ].filter(c => !c.endsWith('=') && !c.endsWith('=undefined'));

      return essentialCookies.join('; ');
    } catch (error: any) {
      this.logger.error('获取 Cookies 失败:', error.message);
      throw error;
    }
  }
}
