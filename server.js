// 在最最最开头加一行日志，证明 Node.js 进程启动了
console.log("🔥 System booting up...");

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { processFile } from './translator.js';
import { fileURLToPath } from 'url';

// 捕获未处理的异常，防止程序静默闪退（关键！）
process.on('uncaughtException', (err) => {
    console.error('💥 未捕获的异常:', err);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// === 端口配置 (关键修改) ===
// Zeabur 会注入 PORT 环境变量，优先使用它。如果本地运行，则用 3000。
const port = process.env.PORT || 3000;

const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use('/downloads', express.static('downloads'));

app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send({ success: false, message: '没有上传文件' });
    try {
        const { apiKey, baseUrl, model } = req.body;
        const userBaseUrl = baseUrl || "https://api.siliconflow.cn/v1";
        const userModel = model || "deepseek-ai/DeepSeek-V3";
        
        const originalExt = path.extname(req.file.originalname);
        const inputPath = req.file.path + originalExt;
        await fs.promises.rename(req.file.path, inputPath);

        const outputDir = path.join(__dirname, 'downloads');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

        const finalFilePath = await processFile(inputPath, outputDir, apiKey, userBaseUrl, userModel);
        res.json({ success: true, downloadUrl: `/downloads/${path.basename(finalFilePath)}` });

    } catch (error) {
        console.error("❌ Request Failed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 监听 0.0.0.0 (必须!)
app.listen(port, '0.0.0.0', () => {
    console.log(`========================================`);
    console.log(`🚀 Server is running on port: ${port}`);
    console.log(`🌍 Listening on 0.0.0.0 (Public Access)`);
    console.log(`========================================`);
});