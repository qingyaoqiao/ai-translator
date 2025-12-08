import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { processFile } from './translator.js'; // 引入刚才写的引擎
import { fileURLToPath } from 'url';

// 解决 ES Module 路径问题
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

// 配置上传
const upload = multer({ dest: 'uploads/' });

// 1. 允许访问 public 文件夹里的网页
app.use(express.static('public'));
// 2. 允许访问 downloads 文件夹里的文件
app.use('/downloads', express.static('downloads'));

// === API：处理上传和翻译 ===
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('没有上传文件');
    }

    console.log(`收到文件: ${req.file.originalname}`);

    try {
        // 从前端获取 Key 和 URL
        const userApiKey = req.body.apiKey;
        const userBaseUrl = req.body.baseUrl || "https://api.siliconflow.cn/v1";

        // 调用翻译引擎
        // req.file.path 是上传后的临时文件路径
        const outputDir = path.join(__dirname, 'downloads');
        
        // 为了保留原文件名后缀，我们需要重命名一下上传的文件
        const originalExt = path.extname(req.file.originalname);
        const inputPath = req.file.path + originalExt;
        await fs.promises.rename(req.file.path, inputPath);

        // ⚠️ 关键修改：把 key 和 url 传进 processFile
        const finalFilePath = await processFile(inputPath, outputDir, userApiKey, userBaseUrl);
        
        // 计算下载链接
        const downloadFilename = path.basename(finalFilePath);
        const downloadUrl = `/downloads/${downloadFilename}`;

        res.json({ 
            success: true, 
            message: '翻译成功！', 
            downloadUrl: downloadUrl 
        });

    } catch (error) {
        console.error("处理失败:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.listen(port, () => {
    console.log(`\n🚀 网站已启动！请在浏览器打开: http://localhost:${port}`);
});
