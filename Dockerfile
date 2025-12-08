# 1. 使用官方 Node.js 轻量版镜像
FROM node:18-slim

# 2. 更新软件源并安装 Python3 和 pip (为了运行 converter.py)
RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 3. 设置工作目录
WORKDIR /app

# 4. 复制依赖文件
COPY package*.json ./

# 5. 安装 Node.js 依赖
RUN npm install

# 6. 安装 Python 依赖 (pdf2docx)
# 直接在这里运行 pip，不需要额外的 requirements.txt 文件，减少出错概率
RUN pip3 install pdf2docx --break-system-packages

# 7. 复制所有项目代码
COPY . .

# 8. 暴露端口
EXPOSE 3000

# 9. 启动服务
CMD ["node", "server.js"]