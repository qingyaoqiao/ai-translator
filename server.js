import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { processFile } from './translator.js';
import { fileURLToPath } from 'url';

// 解决 ES Module 路径问题
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// === 核心修改 1: 强制锁定端口为 3000 ===
// 不再读取环境变量，防止云平台分配奇怪的端口导致对不上
const port = 3000;

// 配置上传
const upload = multer({ dest: 'uploads/' });

// 静态文件服务
app.use(express.static('public'));
app.use('/downloads', express.static('downloads'));

// 处理上传请求
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send({ success: false, message: '没有上传文件' });
    }

    try {
        // 获取前端参数
        const userApiKey = req.body.apiKey;
        const userBaseUrl = req.body.baseUrl || "https://api.siliconflow.cn/v1";
        const userModel = req.body.model || "deepseek-ai/DeepSeek-V3";

        // 重命名文件保留后缀
        const originalExt = path.extname(req.file.originalname);
        const inputPath = req.file.path + originalExt;
        await fs.promises.rename(req.file.path, inputPath);

        // 确保下载目录存在
        const outputDir = path.join(__dirname, 'downloads');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }

        // 调用翻译引擎
        const finalFilePath = await processFile(inputPath, outputDir, userApiKey, userBaseUrl, userModel);
        
        // 返回下载链接
        const downloadFilename = path.basename(finalFilePath);
        res.json({ 
            success: true, 
            downloadUrl: `/downloads/${downloadFilename}` 
        });

    } catch (error) {
        console.error("处理失败:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// === 核心修改 2: 强制监听 0.0.0.0 ===
// 只有加上 '0.0.0.0'，云端的负载均衡器才能找到你的程序
app.listen(port, '0.0.0.0', () => {
    // 这里修复了之前日志显示 ${WEB_PORT} 的问题，现在会正确显示 3000
    console.log(`\n🚀 服务器已启动，监听端口: ${port}`);
});