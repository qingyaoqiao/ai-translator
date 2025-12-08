import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { processFile } from './translator.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// 优先使用云平台分配的 PORT，如果没有则使用 3000
const port = process.env.PORT || 3000;

// 配置上传
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use('/downloads', express.static('downloads'));

app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send({ success: false, message: '没有上传文件' });

    try {
        // 获取前端传来的 3 个参数
        const userApiKey = req.body.apiKey;
        const userBaseUrl = req.body.baseUrl || "https://api.siliconflow.cn/v1";
        const userModel = req.body.model || "deepseek-ai/DeepSeek-V3"; // 默认兜底

        // 重命名文件保留后缀
        const originalExt = path.extname(req.file.originalname);
        const inputPath = req.file.path + originalExt;
        await fs.promises.rename(req.file.path, inputPath);

        const outputDir = path.join(__dirname, 'downloads');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

        // 调用翻译引擎 (传入 model 参数)
        const finalFilePath = await processFile(inputPath, outputDir, userApiKey, userBaseUrl, userModel);
        
        const downloadFilename = path.basename(finalFilePath);
        res.json({ success: true, downloadUrl: `/downloads/${downloadFilename}` });

    } catch (error) {
        console.error("处理失败:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 增加 '0.0.0.0' 参数，确保不仅监听本地，也监听外部请求
app.listen(port, '0.0.0.0', () => {
    console.log(`\n🚀 服务器已启动，监听端口: ${port}`);
});