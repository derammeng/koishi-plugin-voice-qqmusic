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
import { Context, Schema } from 'koishi';
export declare const name = "voice-qqmusic";
export interface Config {
    /** 群聊中是否发送语音 */
    groupVoiceEnabled: boolean;
    /** 私聊中是否发送语音 */
    privateVoiceEnabled: boolean;
    /** 群聊中每页显示的歌曲数量 */
    groupPageSize: number;
    /** 私聊中每页显示的歌曲数量 */
    privatePageSize: number;
    /** 搜索结果最大返回数量 */
    maxResults: number;
    /** 语音消息超时时间（秒） */
    voiceTimeout: number;
    /** 是否显示歌手信息 */
    showSinger: boolean;
    /** 是否显示专辑信息 */
    showAlbum: boolean;
}
export declare const Config: Schema<Config>;
/**
 * 插件主函数
 *
 * @param ctx - Koishi上下文
 * @param config - 插件配置
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map