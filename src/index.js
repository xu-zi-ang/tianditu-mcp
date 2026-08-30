// 天地图 MCP Server 入口
// 双传输模式：
//   node src/index.js            → Streamable HTTP（默认 :8788，CloudBase 云托管/Agent 挂载用）
//   node src/index.js --stdio    → stdio（本地调试 / IDE MCP 客户端用）
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { TOOLS } = require('./tools');

const server = new Server(
  { name: 'tianditu-mcp', version: '1.0.0' },
  {
    capabilities: { tools: {} },
  }
);

// 工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

// 工具调用
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: '未知工具: ' + name }) }], isError: true };
  }
  try {
    const result = await tool.handler(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 0) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }], isError: true };
  }
});

async function main() {
  const mode = process.argv.includes('--stdio') ? 'stdio' : 'http';

  if (mode === 'stdio') {
    const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
    await server.connect(new StdioServerTransport());
    console.error('[tianditu-mcp] stdio 模式已启动');
  } else {
    // Streamable HTTP：用官方 SDK 的 StreamableHTTPServerTransport
    const express = require('express');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const app = express();
    app.use(express.json());

    // 健康检查（云托管探活）
    app.get('/', (_req, res) => res.json({ status: 'ok', server: 'tianditu-mcp', version: '1.0.0' }));
    app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

    // 无状态模式：每请求一个 transport（CloudBase Agent 挂载场景简单可靠）
    app.post('/mcp', async (req, res) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    const port = process.env.PORT || 8788;
    app.listen(port, () => {
      console.log(`[tianditu-mcp] HTTP 模式已启动: http://0.0.0.0:${port}/mcp`);
    });
  }
}

main().catch(e => { console.error('[tianditu-mcp] 启动失败:', e); process.exit(1); });
