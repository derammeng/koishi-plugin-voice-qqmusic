// src/qrlogin.ts
import axios from 'axios';
import * as crypto from 'crypto';

// 常量配置（可能随项目更新而变化，需留意）
const APP_ID = 100497308; // QQ音乐网页版常见appid，可从请求中抓取
const REDIRECT_URI = 'https://y.qq.com/';

// 工具函数：生成随机字符串
function getRandomStr(): string {
  return Math.random().toString(36).substring(2, 15);
}

// 获取二维码
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
      daid: '5',
      pt_3rd_aid: APP_ID,
    },
    responseType: 'arraybuffer',
  });

  // 解析返回的 Set-Cookie 获取 qrsig
  const cookies = response.headers['set-cookie'];
  const qrsigCookie = cookies?.find(c => c.startsWith('qrsig='));
  if (!qrsigCookie) throw new Error('未获取到 qrsig');
  const qrsig = qrsigCookie.split(';')[0].split('=')[1];

  // 将图片数据转为 Base64
  const qrBase64 = Buffer.from(response.data).toString('base64');

  return { qrsig, qrBase64: `data:image/png;base64,${qrBase64}` };
}

// 计算 qrsig 对应的 ptqrtoken（用于后续请求）
function getQRToken(qrsig: string): string {
  let e = 0;
  for (let i = 0; i < qrsig.length; i++) {
    e += (e << 5) + qrsig.charCodeAt(i);
  }
  return (2147483647 & e).toString();
}

// 轮询二维码状态
export async function checkQRCode(qrsig: string): Promise<{ status: string; msg?: string; code?: string }> {
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
    login_sig: '', // 可以从之前的请求中获取，通常可省略
    pt_uistyle: 40,
    aid: APP_ID,
    daid: 5,
  };

  const response = await axios.get(url, {
    params,
    headers: {
      Cookie: `qrsig=${qrsig}`,
      Referer: 'https://xui.ptlogin2.qq.com/',
      'User-Agent': 'Mozilla/5.0',
    },
  });

  // 返回数据格式如：'ptuiCB('0','0','https://y.qq.com/','0','登录成功！','用户名')'
  const match = response.data.match(/ptuiCB\((.*)\)/);
  if (!match) throw new Error('解析返回数据失败');
  const args = JSON.parse(`[${match[1]}]`);

  const code = args[0]; // 0成功 65等待 66二维码失效
  const msg = args[4];
  const urlRedirect = args[2];

  if (code === '0') {
    // 登录成功，需要从返回的 cookie 中提取 musickey
    // 或者访问 urlRedirect 获取最终凭证
    return { status: 'success', msg, code: urlRedirect };
  } else if (code === '65') {
    return { status: 'scanning' }; // 已扫描但未确认
  } else if (code === '66') {
    return { status: 'expired' };
  } else {
    return { status: 'other', msg };
  }
}

// 登录成功后，通过重定向URL获取 musickey（简化版，实际需提取URL中的参数）
export async function getMusicKeyFromRedirect(redirectUrl: string): Promise<{ musickey: string; refreshToken: string; expiresIn: number }> {
  // 实际上，你需要访问该URL，并提取最终 Cookies 中的 musickey
  // 这可能需要额外请求和处理。简化起见，此处仅示意，详细实现请参考开源项目。
  const response = await axios.get(redirectUrl, {
    maxRedirects: 0,
    validateStatus: status => status >= 200 && status < 400,
  });
  const cookies = response.headers['set-cookie'] || [];
  const musickeyCookie = cookies.find(c => c.includes('musickey='));
  if (!musickeyCookie) throw new Error('未获取到 musickey');
  const musickey = musickeyCookie.split(';')[0].split('=')[1];

  // 同时提取 refresh_token（可能来自另一个 cookie 或响应体）
  const refreshTokenCookie = cookies.find(c => c.includes('refresh_token='));
  const refreshToken = refreshTokenCookie ? refreshTokenCookie.split(';')[0].split('=')[1] : '';

  // 过期时间通常由另一个字段给出，此处简单设为30天
  const expiresIn = 30 * 24 * 3600;

  return { musickey, refreshToken, expiresIn };
}

// 刷新 token
export async function refreshMusicKey(refreshToken: string): Promise<{ musickey: string; refreshToken: string; expiresIn: number }> {
  // 调用刷新接口，具体 URL 和参数需逆向
  // 这里给出占位，实际可参考开源项目实现
  throw new Error('未实现');
}
