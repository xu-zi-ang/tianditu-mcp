# 天地图 MCP Server

AI 霞客的地理能力底座：把天地图 5 类 HTTP API 包装成 6 个 MCP 标准工具，供 CloudBase Agent / 任意 MCP Host 调用。

## 工具清单

| 工具 | 功能 | 典型提问 |
|---|---|---|
| `geocode` | 地址 → 经纬度 | "西湖在哪里" |
| `reverse_geocode` | 经纬度 → 地址 | "我现在在哪" |
| `search_poi` | 周边/普通/行政区/视野四合一搜索 | "附近有什么吃的" |
| `drive_route` | 驾车/步行路线（距离/时长/引导） | "从这到那怎么走" |
| `admin_district` | 行政区划（中心点/编码/下级） | "杭州有哪些区" |
| `travel_quick_check` | 复合：周边三类去处+距离一次返回 | "逛累了吃点啥" |

## 本地运行

```bash
npm install
# stdio（IDE 调试）
TIANDITU_TK=你的密钥 npm run start:stdio
# HTTP（部署/Agent 挂载）
TIANDITU_TK=你的密钥 PORT=8788 npm start
# 健康检查
curl http://localhost:8788/healthz
```

## 部署到 CloudBase 云托管

1. CloudBase 控制台 → 云托管 → 新建服务 → 上传本目录（或接 Git）
2. 环境变量：`TIANDITU_TK=你的天地图密钥`；监听端口 8788（或用默认 PORT 注入）
3. 部署后得到访问地址 `https://<env>.service.tcloudbase.com/mcp`（Streamable HTTP）
4. AI+ → Agent → 工具/MCP → 添加 MCP Server → 填该地址 → 勾选 6 个工具

## 坐标系说明

天地图 CGCS2000 ≈ WGS84，与小程序 `wx.getLocation` 同坐标系，**全程免纠偏**。

## 配额

个人认证 Key：每接口 2 万次/日。内置：LRU+TTL 缓存、单飞合并、令牌桶限流（8 rps）、429 退避重试，实际调用量可压缩 50%+。
