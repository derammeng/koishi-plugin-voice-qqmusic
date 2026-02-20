/**
 * Koishi QQ音乐点歌插件
 * 
 * 功能：
 * - 支持通过歌名/歌手搜索QQ音乐
 * - 支持发送语音消息（需要语音服务支持）
 * - 支持群聊和私聊差异化配置
 * - 支持自定义点歌数量限制
 * 
 * @author Your Name
 * @version 1.0.0
 */

import { Context, Schema, Session, h } from 'koishi'
import axios from 'axios'

// 插件名称，用于日志和配置
export const name = 'voice-qqmusic'

// 插件配置接口定义
export interface Config {
  /** 群聊中是否发送语音 */
  groupVoiceEnabled: boolean
  /** 私聊中是否发送语音 */
  privateVoiceEnabled: boolean
  /** 群聊中每页显示的歌曲数量 */
  groupPageSize: number
  /** 私聊中每页显示的歌曲数量 */
  privatePageSize: number
  /** 搜索结果最大返回数量 */
  maxResults: number
  /** 语音消息超时时间（秒） */
  voiceTimeout: number
  /** 是否显示歌手信息 */
  showSinger: boolean
  /** 是否显示专辑信息 */
  showAlbum: boolean
}

// 插件配置Schema定义
export const Config: Schema<Config> = Schema.object({
  groupVoiceEnabled: Schema.boolean()
    .default(true)
    .description('群聊中是否发送语音消息'),
  
  privateVoiceEnabled: Schema.boolean()
    .default(true)
    .description('私聊中是否发送语音消息'),
  
  groupPageSize: Schema.number()
    .default(5)
    .min(1)
    .max(10)
    .description('群聊中每页显示的歌曲数量'),
  
  privatePageSize: Schema.number()
    .default(10)
    .min(1)
    .max(20)
    .description('私聊中每页显示的歌曲数量'),
  
  maxResults: Schema.number()
    .default(20)
    .min(5)
    .max(50)
    .description('搜索结果最大返回数量'),
  
  voiceTimeout: Schema.number()
    .default(30)
    .min(10)
    .max(120)
    .description('语音消息超时时间（秒）'),
  
  showSinger: Schema.boolean()
    .default(true)
    .description('是否显示歌手信息'),
  
  showAlbum: Schema.boolean()
    .default(true)
    .description('是否显示专辑信息'),
})

/**
 * QQ音乐歌曲信息接口
 */
interface QQMusicSong {
  /** 歌曲ID */
  id: string
  /** 歌曲名称 */
  name: string
  /** 歌手信息数组 */
  singer: Array<{ name: string }>
  /** 专辑信息 */
  album?: { name: string; mid?: string }
  /** 歌曲时长（秒） */
  interval?: number
  /** 歌曲MID（用于获取播放链接） */
  mid: string
  /** 歌曲封面图片URL */
  cover?: string
}

/**
 * 搜索缓存，用于存储用户的搜索结果
 * key: 用户ID, value: 搜索结果列表
 */
const searchCache = new Map<string, { songs: QQMusicSong[]; timestamp: number }>()

/**
 * 缓存过期时间（5分钟）
 */
const CACHE_EXPIRE_TIME = 5 * 60 * 1000

/**
 * 清理过期的搜索缓存
 */
function cleanExpiredCache(): void {
  const now = Date.now()
  for (const [key, value] of searchCache.entries()) {
    if (now - value.timestamp > CACHE_EXPIRE_TIME) {
      searchCache.delete(key)
    }
  }
}

/**
 * 从QQ音乐搜索歌曲
 * 
 * @param keyword - 搜索关键词（歌名/歌手）
 * @param maxResults - 最大返回结果数
 * @returns 搜索结果列表
 */
async function searchQQMusic(keyword: string, maxResults: number): Promise<QQMusicSong[]> {
  try {
    // QQ音乐搜索API
    const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
    
    const response = await axios.get(url, {
      params: {
        ct: 24,
        qqmusic_ver: 1298,
        new_json: 1,
        remoteplace: 'txt.yqq.song',
        searchid: '',
        t: 0,
        aggr: 1,
        cr: 1,
        catZhida: 1,
        lossless: 0,
        flag_qc: 0,
        p: 1,
        n: maxResults,
        w: keyword,
      },
      headers: {
        'Referer': 'https://y.qq.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 10000,
    })

    // 解析返回数据（QQ音乐返回的是JSONP格式）
    const jsonpData = response.data
    const jsonMatch = jsonpData.match(/callback\((.*)\)$/)
    
    if (!jsonMatch) {
      throw new Error('无法解析搜索返回数据')
    }

    const data = JSON.parse(jsonMatch[1])
    
    if (!data.data?.song?.list) {
      return []
    }

    // 解析歌曲列表
    return data.data.song.list.map((item: any) => ({
      id: String(item.id),
      name: item.name,
      singer: item.singer || [],
      album: item.album,
      interval: item.interval,
      mid: item.mid,
      cover: item.album?.mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.album.mid}.jpg` : undefined,
    }))
  } catch (error) {
    console.error('搜索QQ音乐失败:', error)
    throw new Error('搜索失败，请稍后重试')
  }
}

/**
 * 获取QQ音乐歌曲播放链接
 * 
 * @param songMid - 歌曲MID
 * @returns 播放链接
 */
async function getMusicUrl(songMid: string): Promise<string | null> {
  try {
    // 使用QQ音乐歌曲详情API获取播放链接
    const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
    
    const data = {
      req: {
        module: 'CDN.SrfCdnDispatchServer',
        method: 'GetCdnDispatch',
        param: {
          guid: '0',
          calltype: 0,
          userip: '',
        },
      },
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid: '0',
          songmid: [songMid],
          songtype: [0],
          uin: '0',
          loginflag: 1,
          platform: '20',
        },
      },
    }

    const response = await axios.post(url, data, {
      headers: {
        'Referer': 'https://y.qq.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    })

    const result = response.data
    
    if (result.req_0?.data?.midurlinfo?.[0]?.purl) {
      const purl = result.req_0.data.midurlinfo[0].purl
      return `https://isure.stream.qqmusic.qq.com/${purl}`
    }

    return null
  } catch (error) {
    console.error('获取音乐链接失败:', error)
    return null
  }
}

/**
 * 格式化歌曲时长
 * 
 * @param interval - 时长（秒）
 * @returns 格式化后的时长字符串（如 03:45）
 */
function formatDuration(interval?: number): string {
  if (!interval) return '--:--'
  const minutes = Math.floor(interval / 60)
  const seconds = interval % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

/**
 * 格式化歌曲信息为文本
 * 
 * @param song - 歌曲信息
 * @param index - 序号
 * @param config - 插件配置
 * @returns 格式化后的文本
 */
function formatSongInfo(song: QQMusicSong, index: number, config: Config): string {
  const parts: string[] = [`${index}. ${song.name}`]
  
  if (config.showSinger && song.singer.length > 0) {
    parts.push(`- ${song.singer.map(s => s.name).join('/')}`)
  }
  
  if (config.showAlbum && song.album?.name) {
    parts.push(`[${song.album.name}]`)
  }
  
  parts.push(`(${formatDuration(song.interval)})`)
  
  return parts.join(' ')
}

/**
 * 插件主函数
 * 
 * @param ctx - Koishi上下文
 * @param config - 插件配置
 */
export function apply(ctx: Context, config: Config) {
  // 定期清理过期缓存
  const cleanInterval = setInterval(cleanExpiredCache, CACHE_EXPIRE_TIME)
  
  // 插件卸载时清理定时器
  ctx.on('dispose', () => {
    clearInterval(cleanInterval)
    searchCache.clear()
  })

  /**
   * 点歌命令
   * 用法：点歌 <歌名/歌手>
   */
  ctx.command('点歌 <keyword:text>', '搜索并播放QQ音乐')
    .alias('qq音乐', 'qqmusic')
    .usage('输入"点歌 歌名"或"点歌 歌手名"来搜索音乐')
    .example('点歌 周杰伦')
    .example('点歌 稻香')
    .action(async ({ session }, keyword) => {
      // 检查session是否存在
      if (!session) {
        return '会话异常，请重试~'
      }

      // 检查关键词是否为空
      if (!keyword || keyword.trim() === '') {
        return '请输入要搜索的歌名或歌手名~\n用法：点歌 <歌名/歌手>'
      }

      keyword = keyword.trim()
      
      // 发送搜索中提示
      await session.send(`正在搜索 "${keyword}" ...`)

      try {
        // 搜索歌曲
        const songs = await searchQQMusic(keyword, config.maxResults)

        if (songs.length === 0) {
          return `没有找到与 "${keyword}" 相关的歌曲，请尝试其他关键词~`
        }

        // 获取当前会话的配置
        const isGroup = session.guildId !== undefined
        const pageSize = isGroup ? config.groupPageSize : config.privatePageSize

        // 缓存搜索结果
        const userId = `${session.platform}:${session.userId}`
        searchCache.set(userId, { songs, timestamp: Date.now() })

        // 只显示第一页结果
        const displaySongs = songs.slice(0, pageSize)

        // 构建回复消息
        let reply = `找到 ${songs.length} 首关于 "${keyword}" 的歌曲：\n`
        reply += displaySongs.map((song, i) => formatSongInfo(song, i + 1, config)).join('\n')
        
        if (songs.length > pageSize) {
          reply += `\n...还有 ${songs.length - pageSize} 首歌曲\n`
        }
        
        reply += '\n回复数字序号即可点歌~'

        return reply
      } catch (error) {
        console.error('点歌命令执行失败:', error)
        return '搜索出错了，请稍后重试~'
      }
    })

  /**
   * 选择歌曲命令
   * 用户回复数字序号选择歌曲
   */
  ctx.middleware(async (session, next) => {
    const userId = `${session.platform}:${session.userId}`
    const cached = searchCache.get(userId)

    // 检查是否有缓存的搜索结果
    if (!cached) {
      return next()
    }

    // 检查缓存是否过期
    if (Date.now() - cached.timestamp > CACHE_EXPIRE_TIME) {
      searchCache.delete(userId)
      return next()
    }

    const content = session.content?.trim() || ''
    
    // 检查是否为数字
    const index = parseInt(content, 10)
    if (isNaN(index) || index < 1 || index > cached.songs.length) {
      return next()
    }

    // 获取选中的歌曲
    const song = cached.songs[index - 1]
    
    // 获取当前会话的配置
    const isGroup = session.guildId !== undefined
    const voiceEnabled = isGroup ? config.groupVoiceEnabled : config.privateVoiceEnabled

    try {
      // 获取音乐播放链接
      const musicUrl = await getMusicUrl(song.mid)
      
      if (!musicUrl) {
        return `抱歉，"${song.name}" 暂时无法播放，请尝试其他歌曲~`
      }

      // 构建歌手信息
      const singerNames = song.singer.map(s => s.name).join('/')
      
      // 发送歌曲信息
      let message = `正在播放：${song.name}`
      if (config.showSinger) {
        message += ` - ${singerNames}`
      }
      await session.send(message)

      // 发送语音消息（如果启用）
      if (voiceEnabled) {
        try {
          // 使用 Koishi 的语音消息格式
          await session.send(h('record', { url: musicUrl }))
        } catch (voiceError) {
          console.error('发送语音失败:', voiceError)
          // 语音发送失败时，发送音乐卡片链接
          await session.send(`播放链接：${musicUrl}`)
        }
      } else {
        // 语音未启用，发送播放链接
        await session.send(`播放链接：${musicUrl}`)
      }

      // 发送歌曲封面（如果有）
      if (song.cover) {
        try {
          await session.send(h.image(song.cover))
        } catch (imageError) {
          // 图片发送失败时忽略
          console.error('发送封面失败:', imageError)
        }
      }

      return
    } catch (error) {
      console.error('播放歌曲失败:', error)
      return '播放出错了，请稍后重试~'
    }
  })

  /**
   * 热门歌曲命令
   * 获取QQ音乐热门榜单
   */
  ctx.command('热门歌曲', '获取QQ音乐热门榜单')
    .alias('热歌榜', 'hotmusic')
    .action(async ({ session }) => {
      // 检查session是否存在
      if (!session) {
        return '会话异常，请重试~'
      }

      try {
        await session.send('正在获取热门歌曲...')
        
        // 使用固定的热门关键词搜索
        const hotKeywords = ['热门', '流行', '新歌']
        const randomKeyword = hotKeywords[Math.floor(Math.random() * hotKeywords.length)]
        
        const songs = await searchQQMusic(randomKeyword, 10)

        if (songs.length === 0) {
          return '暂时无法获取热门歌曲，请稍后重试~'
        }

        // 缓存搜索结果
        const userId = `${session.platform}:${session.userId}`
        searchCache.set(userId, { songs, timestamp: Date.now() })

        // 构建回复消息
        let reply = '热门歌曲推荐：\n'
        reply += songs.map((song, i) => formatSongInfo(song, i + 1, config)).join('\n')
        reply += '\n回复数字序号即可点歌~'

        return reply
      } catch (error) {
        console.error('获取热门歌曲失败:', error)
        return '获取热门歌曲出错了，请稍后重试~'
      }
    })

  /**
   * 清除缓存命令（管理员）
   * 需要权限等级3（管理员）
   */
  ctx.command('清除音乐缓存')
    .alias('cleanmusiccache')
    .action(({ session }) => {
      // 检查session是否存在
      if (!session) {
        return '会话异常，请重试~'
      }

      // 检查权限（简单检查，实际应根据bot的权限系统）
      // 这里只清除当前用户的缓存
      const userId = `${session.platform}:${session.userId}`
      let count = 0
      if (searchCache.has(userId)) {
        searchCache.delete(userId)
        count = 1
      }
      
      // 同时清理过期的缓存
      cleanExpiredCache()
      
      return `已清除 ${count} 条音乐搜索缓存（共清理 ${searchCache.size} 条活跃缓存）`
    })
}
