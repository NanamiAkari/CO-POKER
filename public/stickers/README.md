# 房间表情包

> 当前状态（2026-10-31）：已接入 16 个表情包，分为“默认”（8 个）和“八木唯”（8 个）两个标签页。素材目录迁移、更多主题和“每日推荐”暂缓，等素材更多后再设计；下方“每日推荐”仍是备选方案。

当前已接入 16 个表情包，`catalog.json` 不再是空数组。素材文件使用 ASCII 文件名，
`label` 仍然是中文，面板和消息中显示中文标签。

八木唯系列（按 catalog 顺序排在前面）：

| ID | 标签 | 文件 |
| --- | --- | --- |
| `ba-mu-wei-1` | 点赞 | `/stickers/ba-mu-wei-1.gif` |
| `ba-mu-wei-2` | 比耶 | `/stickers/ba-mu-wei-2.gif` |
| `ba-mu-wei-3` | 无语 | `/stickers/ba-mu-wei-3.gif` |
| `ba-mu-wei-4` | 差评 | `/stickers/ba-mu-wei-4.gif` |
| `ba-mu-wei-5` | 流汗 | `/stickers/ba-mu-wei-5.gif` |
| `ba-mu-wei-6` | 慌张 | `/stickers/ba-mu-wei-6.gif` |
| `ba-mu-wei-7` | 报警 | `/stickers/ba-mu-wei-7.gif` |
| `ba-mu-wei-8` | 困困 | `/stickers/ba-mu-wei-8.gif` |

补充：

| ID | 标签 | 文件 |
| --- | --- | --- |
| `si-kao` | 思考 | `/stickers/si-kao.png` |
| `wo-yao-yan-pai` | 我要验牌 | `/stickers/wo-yao-yan-pai.jpg` |
| `zhen-han-mei-wei` | 震撼美味 | `/stickers/zhen-han-mei-wei.jpg` |

其他：

| ID | 标签 | 文件 |
| --- | --- | --- |
| `ye-ting-hao` | 也挺好 | `/stickers/ye-ting-hao.gif` |
| `duan-cha` | 端茶 | `/stickers/duan-cha.gif` |
| `na-ni` | 纳尼 | `/stickers/na-ni.gif` |
| `jing-ya` | 惊讶 | `/stickers/jing-ya.gif` |
| `jing` | 惊 | `/stickers/jing.gif` |

## 添加单个表情包

将素材文件放在本目录，并向 `catalog.json` 添加条目：

```json
[
  { "id": "hello", "label": "打招呼", "src": "/stickers/hello.webp" }
]
```

只使用本地 SVG、PNG、JPEG、GIF 或 WebP，扩展名小写；路径和文件名使用英文、数字、
连字符、下划线。不要填写外部网址、数据网址或 `..` 路径。ID 保持稳定，`label` 用于按钮
和图片的无障碍文字，不超过 30 个 Unicode 码点；最多配置 60 项。

客户端点击条目后立即发送独立的表情包消息，不插入文字输入框。服务器按清单校验 ID。
素材与清单随正常版本发布；本地开发重启服务并刷新页面后生效。

## 主题标签页

当前表情面板已分为两栏：

- **默认**：思考、我要验牌、震撼美味、也挺好、端茶、纳尼、惊讶、惊，共 8 个。
- **八木唯**：八木唯系列 8 个。

“默认”固定排在第一栏，其他主题按 catalog 中首次出现的顺序排列。栏位切换是表情包面板下方的独立切换条；每次重新打开表情面板都会回到“默认”。

catalog 条目通过两个可选字段分组：

```json
{
  "id": "ba-mu-wei-1",
  "label": "点赞",
  "src": "/stickers/ba-mu-wei-1.gif",
  "theme": "ba-mu-wei",
  "themeLabel": "八木唯"
}
```

- `theme`：英文、数字、连字符或下划线，最长 32 个字符；省略时归入 `default`。
- `themeLabel`：标签页显示名，最多 30 个字符；省略时 `default` 显示“默认”，其他主题显示 `theme`。
- 同一主题的条目可以分散在 catalog 中，客户端会按首次出现顺序聚合。
- 新增主题不需要改服务端校验：服务端仍按所有 `id` 做白名单。

素材目录按主题分类仍然暂缓。当前文件名放在 `public/stickers/` 根目录；以后要迁移到
`public/stickers/<theme>/` 时，只需要同步修改 catalog 的 `src`。现有服务端路径校验和
`realpath` 校验已经支持安全子目录。

ID 必须在所有主题之间全局唯一，因为聊天消息只保存 `stickerId`。删除素材或 ID 会让历史
消息显示为“表情包暂不可用”，需要保留历史时不要复用或删除旧 ID。

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
