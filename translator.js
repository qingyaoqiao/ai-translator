import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import OpenAI from 'openai';
import AdmZip from 'adm-zip';

const execPromise = util.promisify(exec);
// ⚠️ 调试模式：降低并发，方便看日志
const CONCURRENCY_LIMIT = 5; 

// XML 清洗工具
function escapeXml(unsafe) {
    if (!unsafe) return "";
    return unsafe.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function createClient(apiKey, baseUrl) {
    return new OpenAI({ apiKey: apiKey, baseURL: baseUrl });
}

// B计划：纯文本翻译
async function translateFallback(plainText, client, modelName) {
    plainText = plainText.replace(/\s+/g, ' ').trim();
    if (plainText.length < 1) return "";
    try {
        const completion = await client.chat.completions.create({
            model: modelName,
            messages: [{ role: "system", content: "翻译为简体中文。" }, { role: "user", content: plainText }],
            temperature: 0.3
        });
        const res = completion.choices[0].message.content.trim();
        // 调试日志
        console.log(`   🔸 [B计划] 原文: ${plainText.substring(0,10)}... => 译文: ${res.substring(0,10)}...`);
        return `<w:p><w:r><w:t>${escapeXml(res)}</w:t></w:r></w:p>`;
    } catch (e) {
        console.error(`   ❌ [B计划失败] ${e.message}`);
        return `<w:p><w:r><w:t>${escapeXml(plainText)}</w:t></w:r></w:p>`; 
    }
}

// A计划：XML 翻译
async function translateXMLChunk(xmlChunk, client, modelName) {
    // 检查是否有实质文字
    if (!xmlChunk.includes('<w:t')) return xmlChunk; // 没文字标签，直接跳过
    const simpleText = xmlChunk.replace(/<[^>]+>/g, '').trim();
    if (simpleText.length < 1) return xmlChunk; // 纯符号，跳过

    try {
        if (xmlChunk.length > 5000) throw new Error("XML_TOO_LONG");

        const completion = await client.chat.completions.create({
            model: modelName,
            messages: [
                { 
                    role: "system", 
                    content: `你是一个翻译引擎。你的任务是：
1. 找到 XML 标签 <w:t> 里面的文字。
2. 将其翻译为【简体中文】。
3. 保持所有 <...> 标签结构不变，不要删减标签。
4. 直接输出修改后的 XML 代码。` 
                },
                { role: "user", content: xmlChunk }
            ],
            temperature: 0.1
        });

        let res = completion.choices[0].message.content
            .replace(/```xml/g, '')
            .replace(/```/g, '')
            .trim();
        
        // 强力清洗 & 符号
        res = res.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;))/g, '&amp;');

        // 格式检查
        if (!res.includes('<w:t')) throw new Error("AI_BROKE_FORMAT");

        // 🔍 【显微镜日志】关键修改！
        const oldTxt = simpleText.substring(0, 15).replace(/\n/g, '');
        const newTxt = res.replace(/<[^>]+>/g, '').trim().substring(0, 15).replace(/\n/g, '');
        
        if (oldTxt === newTxt) {
            console.log(`   ⚠️ [未翻译] AI 返回了原文: "${oldTxt}"`);
        } else {
            console.log(`   ✅ [已翻译] "${oldTxt}" -> "${newTxt}"`);
        }

        return res;

    } catch (e) {
        // 如果 A 计划出错，尝试 B 计划
        if (e.message !== "XML_TOO_LONG" && e.message !== "AI_BROKE_FORMAT") {
            console.warn(`   ⚠️ [A计划出错] ${e.message} -> 转B计划`);
        }
        return await translateFallback(simpleText, client, modelName);
    }
}

async function translateDocx(inputPath, outputPath, client, modelName) {
    const zip = new AdmZip(inputPath);
    let contentXml = zip.readAsText("word/document.xml");
    
    // 正则优化：更精准匹配段落
    const matches = contentXml.match(/<w:p[\s\S]*?<\/w:p>/g);

    if (matches) {
        const total = matches.length;
        console.log(`---> 文档共 ${total} 段，开始翻译...`);

        for (let i = 0; i < total; i += CONCURRENCY_LIMIT) {
            const batch = matches.slice(i, i + CONCURRENCY_LIMIT);
            
            // 打印进度
            process.stdout.write(`\r🚀 进度: ${Math.min(i + CONCURRENCY_LIMIT, total)}/${total} `);

            const results = await Promise.all(batch.map(chunk => translateXMLChunk(chunk, client, modelName)));
            
            // 执行替换
            for (let j = 0; j < batch.length; j++) {
                // 只有当结果不同时才替换，避免无效操作
                if (results[j] !== batch[j]) {
                    // 使用 split/join 替换确保只替换当前这一个（防止重复段落误伤）
                    // 但为保性能，这里依然用 replace，通常段落 XML 唯一性足够
                    contentXml = contentXml.replace(batch[j], results[j]);
                }
            }
        }
    } else {
        console.log("❌ 未找到任何段落 (<w:p>)，可能是表格文档或特殊格式。");
    }
    console.log("\n📦 正在打包写入...");
    zip.updateFile("word/document.xml", Buffer.from(contentXml, "utf-8"));
    zip.writeZip(outputPath);
}

export async function processFile(inputFile, outputDir, apiKey, baseUrl, modelName) {
    const ext = path.extname(inputFile).toLowerCase();
    const timestamp = Date.now();
    let finalFileName = ext === '.txt' ? `translated_${timestamp}.txt` : `translated_${timestamp}.docx`;
    const finalPath = path.join(outputDir, finalFileName);
    const client = createClient(apiKey, baseUrl);

    console.log(`\n📄 开始处理: ${path.basename(inputFile)} | 模型: ${modelName}`);

    try {
        if (ext === '.txt') {
            const content = await fs.readFile(inputFile, 'utf-8');
            const chunks = content.match(/[\s\S]{1,1500}/g) || [];
            const translated = await Promise.all(chunks.map(async chunk => {
                const res = await client.chat.completions.create({
                    model: modelName, messages: [{ role: "user", content: `翻译成中文:\n${chunk}` }]
                });
                return res.choices[0].message.content;
            }));
            await fs.writeFile(finalPath, translated.join("\n"));
        } else if (ext === '.docx') {
            await translateDocx(inputFile, finalPath, client, modelName);
        } else if (ext === '.pdf') {
            const tempDocx = path.join(outputDir, `temp_${timestamp}.docx`);
            const pythonCommand = process.platform === "win32" ? "python" : "python3";
            await execPromise(`${pythonCommand} converter.py "${inputFile}" "${tempDocx}"`);
            await translateDocx(tempDocx, finalPath, client, modelName);
        } 
        return finalPath;
    } catch (error) {
        console.error("🔥 处理失败:", error);
        throw error;
    }
}