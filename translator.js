import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import AdmZip from 'adm-zip';

dotenv.config();

const execPromise = util.promisify(exec);

// === 配置区域 ===
const client = new OpenAI({ 
    apiKey: process.env.API_KEY, 
    baseURL: process.env.BASE_URL 
});

// 模型名称
const MODEL_NAME = "deepseek-ai/DeepSeek-V3"; 

// 并发数
const CONCURRENCY_LIMIT = 10; 

// === 核心工具：XML 强力清洗 (修复 Word 打不开的问题) ===
function escapeXml(unsafe) {
    if (!unsafe) return "";
    return unsafe
        // 1. 【新增】删除 ASCII 控制字符 (0-31)，这些是 Word 崩溃的元凶
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') 
        // 2. 标准 XML 转义
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ============================================================
//  B计划：纯文本翻译
// ============================================================
async function translateFallback(plainText) {
    plainText = plainText.replace(/\s+/g, ' ').trim();
    if (plainText.length < 1) return "";

    try {
        const completion = await client.chat.completions.create({
            model: MODEL_NAME,
            messages: [
                { 
                    role: "system", 
                    content: "你是一个翻译引擎。将原文直接翻译成【简体中文】。不要输出解释。" 
                },
                { role: "user", content: plainText }
            ],
            temperature: 0.3
        });
        
        let translatedText = completion.choices[0].message.content.trim();
        
        // 强力清洗
        const safeText = escapeXml(translatedText);

        return `<w:p><w:r><w:t>${safeText}</w:t></w:r></w:p>`;
    } catch (e) {
        return `<w:p><w:r><w:t>${escapeXml(plainText)}</w:t></w:r></w:p>`; 
    }
}

// ============================================================
//  A计划：XML 外科手术
// ============================================================
async function translateXMLChunk(xmlChunk) {
    if (!xmlChunk.includes('<w:t') || !xmlChunk.includes('>')) return xmlChunk;
    const simpleText = xmlChunk.replace(/<[^>]+>/g, '').trim();
    if (simpleText.length < 1) return xmlChunk;

    try {
        if (xmlChunk.length > 6000) throw new Error("XML_TOO_LONG");

        const completion = await client.chat.completions.create({
            model: MODEL_NAME,
            messages: [
                {
                    role: "system",
                    content: `你是一个精通 OpenXML 的翻译引擎。将 <w:t> 标签内的文本翻译成【简体中文】。
                    
                    严重警告 (XML Safety):
                    1. 必须使用 &amp;, &lt;, &gt; 转义特殊符号。
                    2. 【严禁】修改标签结构、属性。
                    3. 【严禁】分裂或合并标签。
                    4. 只输出翻译后的 XML 代码。`
                },
                { role: "user", content: xmlChunk }
            ],
            temperature: 0.1
        });

        let res = completion.choices[0].message.content
            .replace(/```xml/g, '')
            .replace(/```/g, '')
            .trim();
        
        // 【新增】强力清洗未转义的 & 符号，防止漏网之鱼
        res = res.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;))/g, '&amp;');

        // 检查关键标签
        if ((!res.includes('<w:p') && xmlChunk.includes('<w:p')) || !res.includes('<w:t')) {
            throw new Error("AI_BROKE_FORMAT");
        }
        return res;

    } catch (e) {
        return await translateFallback(simpleText);
    }
}

// ============================================================
//  Word 处理逻辑
// ============================================================
async function translateDocx(inputPath, outputPath) {
    const zip = new AdmZip(inputPath);
    let contentXml = zip.readAsText("word/document.xml");
    const PARAGRAPH_REGEX = /<w:p[\s\S]*?<\/w:p>/g;
    const matches = contentXml.match(PARAGRAPH_REGEX);

    if (matches) {
        const total = matches.length;
        console.log(`---> 共发现 ${total} 个段落，启动 ${CONCURRENCY_LIMIT} 线程加速...`);

        for (let i = 0; i < total; i += CONCURRENCY_LIMIT) {
            const batch = matches.slice(i, i + CONCURRENCY_LIMIT);
            const progress = Math.min(i + CONCURRENCY_LIMIT, total);
            process.stdout.write(`\r🚀 正在处理: ${progress}/${total} 段...`);

            const results = await Promise.all(batch.map(async (chunk) => {
                if (chunk.includes('<w:t')) return await translateXMLChunk(chunk);
                return chunk;
            }));

            for (let j = 0; j < batch.length; j++) {
                contentXml = contentXml.replace(batch[j], results[j]);
            }
        }
    }
    
    console.log("\n📦 打包保存中...");
    zip.updateFile("word/document.xml", Buffer.from(contentXml, "utf-8"));
    zip.writeZip(outputPath);
}

// ============================================================
//  TXT 处理
// ============================================================
async function translateTxt(filePath, outputPath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const chunks = content.match(/[\s\S]{1,1500}/g) || [];
    
    console.log(`---> TXT 切分为 ${chunks.length} 块，开始并发翻译...`);

    const translatedChunks = await Promise.all(chunks.map(async (chunk) => {
        try {
            const completion = await client.chat.completions.create({
                model: MODEL_NAME,
                messages: [{ role: "user", content: `请将以下文本翻译成简体中文：\n${chunk}` }]
            });
            return completion.choices[0].message.content;
        } catch (e) {
            return chunk;
        }
    }));

    await fs.writeFile(outputPath, translatedChunks.join("\n"));
}

// ============================================================
//  主入口 (修复了路径后缀名 BUG)
// ============================================================
export async function processFile(inputFile, outputDir) {
    const ext = path.extname(inputFile).toLowerCase();
    const timestamp = Date.now();
    
    // 【修复】不再把所有文件都叫 .docx，而是根据类型决定
    let finalFileName;
    if (ext === '.txt') {
        finalFileName = `translated_${timestamp}.txt`;
    } else {
        // PDF 和 Word 最后都生成 Docx
        finalFileName = `translated_${timestamp}.docx`;
    }
    
    const finalPath = path.join(outputDir, finalFileName);

    console.log(`\n📄 正在处理: ${path.basename(inputFile)}`);

    try {
        if (ext === '.txt') {
            await translateTxt(inputFile, finalPath);
        } 
        else if (ext === '.docx') {
            await translateDocx(inputFile, finalPath);
        } 
        else if (ext === '.pdf') {
            const tempDocx = path.join(outputDir, `temp_${timestamp}.docx`);
            console.log("🛠️  正在调用 Python 转换 PDF...");
            await execPromise(`python converter.py "${inputFile}" "${tempDocx}"`);
            console.log("✅ 转换完成，开始翻译...");
            await translateDocx(tempDocx, finalPath);
        } 
        else {
            throw new Error("不支持的文件格式！");
        }

        // 【关键】返回真实的文件路径，这样网页下载链接才是对的
        return finalPath;

    } catch (error) {
        console.error("\n❌ 处理出错:", error.message);
        throw error;
    }
}