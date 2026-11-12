# 房间表情包

> 当前状态（2026-11-12）：已接入 17 个表情包，分为“默认”（9 个）和“八木唯”（8 个）两个标签页。素材按主题分目录存放，`catalog.json` 仍放在本目录根下。

## 目录结构

```
public/stickers/
├── catalog.json          # 表情包清单（所有主题共用）
├── default/              # “默认”标签页的素材
└── ba-mu-wei/            # “八木唯”标签页的素材
```

- 主题 ID 与目录名保持一致：`default`、`ba-mu-wei`。
- 新增主题时新建同名目录，并在 `catalog.json` 里给该主题的条目填 `theme` / `themeLabel`。
- `catalog.json` 里的 `src` 必须写成带子目录的绝对路径，例如 `/stickers/default/si-kao.png`。
- 服务端和客户端都会解析子目录，但只接受 `/stickers/` 下、由英文、数字、`-`、`_` 组成的路径；`..`、查询参数、外部网址一律丢弃。

## 已接入素材

默认（`/stickers/default/`）：

| ID | 标签 | 文件 |
| --- | --- | --- |
| `si-kao` | 思考 | `/stickers/default/si-kao.png` |
| `wo-yao-yan-pai` | 我要验牌 | `/stickers/default/wo-yao-yan-pai.jpg` |
| `zhen-han-mei-wei` | 震撼美味 | `/stickers/default/zhen-han-mei-wei.jpg` |
| `ye-ting-hao` | 也挺好 | `/stickers/default/ye-ting-hao.gif` |
| `duan-cha` | 端茶 | `/stickers/default/duan-cha.gif` |
| `na-ni` | 纳尼 | `/stickers/default/na-ni.gif` |
| `jing-ya` | 惊讶 | `/stickers/default/jing-ya.gif` |
| `jing` | 惊 | `/stickers/default/jing.gif` |
| `mao-wei-cao` | 猫尾草 | `/stickers/default/mao-wei-cao.webp` |

八木唯（`/stickers/ba-mu-wei/`）：

| ID | 标签 | 文件 |
| --- | --- | --- |
| `ba-mu-wei-1` | 点赞 | `/stickers/ba-mu-wei/ba-mu-wei-1.gif` |
| `ba-mu-wei-2` | 比耶 | `/stickers/ba-mu-wei/ba-mu-wei-2.gif` |
| `ba-mu-wei-3` | 无语 | `/stickers/ba-mu-wei/ba-mu-wei-3.gif` |
| `ba-mu-wei-4` | 差评 | `/stickers/ba-mu-wei/ba-mu-wei-4.gif` |
| `ba-mu-wei-5` | 流汗 | `/stickers/ba-mu-wei/ba-mu-wei-5.gif` |
| `ba-mu-wei-6` | 慌张 | `/stickers/ba-mu-wei/ba-mu-wei-6.gif` |
| `ba-mu-wei-7` | 报警 | `/stickers/ba-mu-wei/ba-mu-wei-7.gif` |
| `ba-mu-wei-8` | 困困 | `/stickers/ba-mu-wei/ba-mu-wei-8.gif` |

`mao-wei-cao` 的原始素材是 240×320、150 帧、约 4.2 MB 的 GIF；为控制面板加载体积，
已转成同尺寸、同帧率的动图 WebP（约 790 KB）。`catalog.json` 只引用 WebP 版本。

## 添加单个表情包

1. 把素材放进对应主题目录（新主题先建目录），文件名只用英文、数字、连字符、下划线。
2. 在 `catalog.json` 追加条目：

```json
[
  {
    "id": "hello",
    "label": "打招呼",
    "src": "/stickers/default/hello.webp",
    "theme": "default",
    "themeLabel": "默认"
  }
]
```

只使用本地 SVG、PNG、JPEG、GIF 或 WebP，扩展名小写。不要填写外部网址、数据网址或 `..` 路径。
ID 保持稳定，`label` 用于按钮和图片的无障碍文字，不超过 30 个 Unicode 码点；最多配置 60 项。

客户端点击条目后立即发送独立的表情包消息，不插入文字输入框。服务器按清单校验 ID。
素材与清单随正常版本发布；本地开发重启服务并刷新页面后生效。

## 主题标签页

表情面板按 `theme` 分栏：

- **默认**：固定排在第一位，包含默认主题的 9 个。
- **八木唯**：八木唯系列 8 个。

其他主题按 `catalog.json` 中首次出现的顺序追加在后面。栏位切换是表情包面板下方的独立切换条；每次重新打开表情面板都会回到“默认”。

catalog 条目通过两个可选字段分组：

```json
{
  "id": "ba-mu-wei-1",
  "label": "点赞",
  "src": "/stickers/ba-mu-wei/ba-mu-wei-1.gif",
  "theme": "ba-mu-wei",
  "themeLabel": "八木唯"
}
```

- `theme`：英文、数字、连字符或下划线，最长 32 个字符；省略时归入 `default`。
- `themeLabel`：标签页显示名，最多 30 个字符；省略时 `default` 显示“默认”，其他主题显示 `theme`。
- 同一主题的条目可以分散在 catalog 中，客户端会按首次出现顺序聚合。

ID 必须在所有主题之间全局唯一，因为聊天消息只保存 `stickerId`。删除素材或 ID 会让历史
消息显示为“表情包暂不可用”，需要保留历史时不要复用或删除旧 ID。

## 素材整理约定

- 一个角色或一组同一来源的表情放一个目录，目录名用主题 ID，避免所有文件堆在 `stickers/` 根下。
- 目录里不需要额外清单文件；分组信息只以 `catalog.json` 的 `theme` 字段为准。
- 超过 1 MB 的 GIF 建议先转成动图 WebP，或缩短帧数、缩小尺寸后再接入，避免打开面板时一次性下载过多。
- 移动素材到新目录时同步改 `src`，ID 保持不变，聊天历史里的表情包才不会失效。

## 每日推荐（规划中，尚未实现）

建议把“每日推荐”做成最前面的标签页，但不要放进 `catalog.json` 的普通主题里，而是使用
独立的 `daily.json`：

```json
{
  "timeZone": "Asia/Shanghai",
  "count": 6,
  "pool": ["ye-ting-hao", "duan-cha", "na-ni", "jing-ya", "jing"],
  "overrides": {
    "2026-12-25": ["jing", "na-ni"]
  }
}
```

客户端按 `Asia/Shanghai` 的当天日期，先从 `pool` 中过滤出仍在 catalog 里的 ID，再做
日期种子洗牌，取固定数量；`overrides` 允许手动指定某一天。这样不需要后端账号或数据库，
所有玩家看到同一组推荐，第二天自动变化。客户端可以请求
`/stickers/daily.json?date=YYYY-MM-DD`，避免静态文件缓存跨天。

如果以后要做“按用户个性化推荐”或运营后台即时调整，再增加服务端 `/api/stickers/daily`
接口；当前单机内存房间没有账号体系，静态日期轮换更合适。
