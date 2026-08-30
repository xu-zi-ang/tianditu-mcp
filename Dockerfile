# 天地图 MCP Server — CloudBase 云托管部署镜像
FROM node:20-alpine

WORKDIR /app

# 先拷 package.json 装依赖（利用镜像层缓存）
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# 拷源码
COPY src ./src

# 云托管通过环境变量 PORT 注入服务端口（默认 8788）
ENV PORT=8788
EXPOSE 8788

# tk 通过云托管「环境变量设置」注入，不进镜像
CMD ["node", "src/index.js"]
