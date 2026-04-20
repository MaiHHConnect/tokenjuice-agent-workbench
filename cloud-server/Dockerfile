FROM node:20-alpine

WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm install

# 复制源代码
COPY src/ ./src/
COPY public/ ./public/

# 暴露端口
EXPOSE 8085

# 设置环境变量
ENV NODE_ENV=production

# 启动命令
CMD ["npm", "start"]
