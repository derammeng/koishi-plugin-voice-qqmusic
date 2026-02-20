# koishi-plugin-voice-QQmusic

QQ音乐点歌插件，支持语音发送和群聊私聊差异化配置。

## 功能特性

- 搜索QQ音乐歌曲
- 支持语音消息发送
- 群聊和私聊差异化配置
- 可自定义搜索结果数量
- 显示歌曲封面图片
- 支持热门歌曲推荐

## 安装

```bash
npm install koishi-plugin-voice-qqmusic
```

## 使用方法

### 点歌命令

```
点歌 <歌名/歌手>
```

示例：
- `点歌 周杰伦`
- `点歌 稻香`
- `qqmusic 告白气球`

### 选择歌曲

搜索完成后，回复数字序号（如 `1`、`2`、`3`）即可播放对应歌曲。

### 热门歌曲

```
热门歌曲
```

获取QQ音乐热门榜单推荐。

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| groupVoiceEnabled | boolean | true | 群聊中是否发送语音消息 |
| privateVoiceEnabled | boolean | true | 私聊中是否发送语音消息 |
| groupPageSize | number | 5 | 群聊中每页显示的歌曲数量 |
| privatePageSize | number | 10 | 私聊中每页显示的歌曲数量 |
| maxResults | number | 20 | 搜索结果最大返回数量 |
| voiceTimeout | number | 30 | 语音消息超时时间（秒） |
| showSinger | boolean | true | 是否显示歌手信息 |
| showAlbum | boolean | true | 是否显示专辑信息 |

## 注意事项

1. 语音发送需要适配器支持语音消息格式
2. 部分歌曲可能因版权原因无法播放
3. 搜索结果缓存5分钟后自动清除
4. 需要 `http` 服务支持

## 依赖

- koishi: ^4.15.0
- axios: ^1.6.0

## 许可证

MIT
