// src/qrlogin.ts
/**
 * QQ音乐扫码登录核心模块
 * 基于 Rain120/qq-music-api 核心逻辑适配
 */
import axios from 'axios';
import * as crypto from 'crypto';

// 常量配置（来自 QQ音乐网页版）
const APP_ID = 100497308;           // QQ音乐网页版 appid
const DAID = 5;                      // 设备 ID
const REDIRECT_URI = 'https://y.qq.com/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// 工具函数：计算 ptqrtoken（经典算法）
function getQRToken(qrsig: string): string {
  let e = 0;
  for (let i = 0; i < qrsig.length; i++) {
    e += (e << 5) + qrsig.charCodeAt(i);
  }
  return (2147483647 & e).toString();
}

// 工具函数：生成随机字符串（用于请求防缓存）
function getRandomStr(): string {
  return Math.random().toString(36).substring(2, 15);
}

// 工具函数：解析 Cookie 字符串为对象
function parseCookie(cookieStr: string): Record<string, string> {
  const obj: Record<string, string> = {};
  cookieStr.split(';').forEach(pair => {
    const [key, val] = pair.trim().split('=');
    if (key && val) obj[key] = val;
  });
  return obj;
}

/**
 * 1. 获取登录二维码
 * @returns { qrsig: string; qrBase64: string } qrsig用于后续轮询，qrBase64可直接展示
 */
export async function getQRCode(): Promise<{ qrsig: string; qrBase64: string }> {
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

  // 从响应头中提取 qrsig
  const setCookie = response.headers['set-cookie'];
  if (!setCookie || !Array.isArray(setCookie)) {
    throw new Error('未获取到 qrsig');
  }
  const qrsigCookie = setCookie.find(c => c.startsWith('qrsig='));
  if (!qrsigCookie) throw new Error('未找到 qrsig cookie');
  
  const qrsig = qrsigCookie.split(';')[0].split('=')[1];

  // 将图片数据转为 Base64（用于发送给用户）
  const qrBase64 = `data:image/png;base64,${Buffer.from(response.data).toString('base64')}`;

  return { qrsig, qrBase64 };
}

/**
 * 2. 轮询二维码状态
 * @param qrsig 从 getQRCode 获取的 qrsig
 * @returns 状态对象
 *   - status: 'waiting'|'scanning'|'success'|'expired'|'other'
 *   - redirectUrl?: 登录成功时的重定向地址（含票据）
 *   - msg?: 附加信息
 */
export async function checkQRCode(qrsig: string): Promise<{
  status: 'waiting' | 'scanning' | 'success' | 'expired' | 'other';
  redirectUrl?: string;
  msg?: string;
}> {
  const ptqrtoken = getQRToken(qrsig);
  const url = 'https://ssl.ptlogin2.qq.com/ptqrlogin';
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
    login_sig: '', // 可为空
    pt_uistyle: 40,
    aid: APP_ID,
    daid: DAID,
  };

  const response = await axios.get(url, {
    params,
    headers: {
      Cookie: `qrsig=${qrsig}`,
      Referer: 'https://xui.ptlogin2.qq.com/',
      'User-Agent': USER_AGENT,
    },
  });

  // 返回数据格式： ptuiCB('0','0','https://y.qq.com/','0','登录成功！','用户名')
  const match = response.data.match(/ptuiCB\((.*)\)/);
  if (!match) throw new Error('解析返回数据失败');

  const args = JSON.parse(`[${match[1]}]`);
  const code = args[0];        // 0成功 65等待扫码 66二维码失效
  const msg = args[4];
  const redirectUrl = args[2];

  switch (code) {
    case '0':
      return { status: 'success', redirectUrl, msg };
    case '65':
      return { status: 'scanning', msg }; // 已扫描但未确认
    case '66':
      return { status: 'expired', msg };
    default:
      return { status: 'other', msg };
  }
}

/**
 * 3. 从重定向 URL 获取最终 musickey 和 refresh_token
 * @param redirectUrl 登录成功时返回的重定向地址
 * @returns 包含 musickey, refreshToken, expiresIn 的对象
 */
export async function getMusicKeyFromRedirect(redirectUrl: string): Promise<{
  musickey: string;
  refreshToken: string;
  expiresIn: number; // 单位：秒
}> {
  // 模拟浏览器访问重定向地址，以获取最终 Cookie
  const response = await axios.get(redirectUrl, {
    maxRedirects: 5, // 允许跟随重定向
    headers: {
      'User-Agent': USER_AGENT,
      Referer: 'https://xui.ptlogin2.qq.com/',
    },
  });

  // 合并所有重定向过程中收集的 Cookie
  const allCookies: string[] = [];
  if (response.config.headers?.Cookie) {
    allCookies.push(response.config.headers.Cookie as string);
  }
  if (response.headers['set-cookie']) {
    allCookies.push(...response.headers['set-cookie']);
  }

  const cookieStr = allCookies.join('; ');
  const cookies = parseCookie(cookieStr);

  // 提取关键字段
  const musickey = cookies['musickey'] || cookies['qqmusic_key'];
  const refreshToken = cookies['refresh_token'] || cookies['psrf_refresh_token'];
  
  // 过期时间从 Cookie 中提取（通常在 expires 字段，这里简单取 30 天）
  const expiresIn = 30 * 24 * 3600;

  if (!musickey) {
    throw new Error('未获取到 musickey');
  }

  return {
    musickey,
    refreshToken: refreshToken || '',
    expiresIn,
  };
}

/**
 * 4. 刷新 token（使用 refresh_token 换取新的 musickey）
 * @param refreshToken 之前获取的 refresh_token
 * @returns 新的 token 信息
 */
export async function refreshMusicKey(refreshToken: string): Promise<{
  musickey: string;
  refreshToken: string;
  expiresIn: number;
}> {
  // 刷新接口 URL 需通过抓包获取，以下是占位实现
  // 真实实现可参考 Rain120/qq-music-api 中的 refresh 逻辑
  try {
    const response = await axios.post('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      comm: { ct: 24, cv: 0 },
      req: {
        module: 'QQConnectLogin.RefreshToken',
        method: 'RefreshToken',
        param: { refresh_token: refreshToken }
      }
    }, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://y.qq.com/',
      }
    });

    const data = response.data;
    if (data.code === 0 && data.req?.data) {
      return {
        musickey: data.req.data.musickey,
        refreshToken: data.req.data.refresh_token,
        expiresIn: data.req.data.expires_in,
      };
    }
    throw new Error('刷新失败');
  } catch (error) {
    throw new Error(`刷新 token 失败: ${error.message}`);
  }
}
