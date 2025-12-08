import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import OpenAI from 'openai';
import AdmZip from 'adm-zip';

const execPromise = util.promisify(exec);

// === ⚙️ 配置区域 ===
const CONCURRENCY_LIMIT = 10; // 🚀 并发数提升到 10
const XML_LENGTH_LIMIT = 8000; // 📏 文本长度放宽

// === 🛠️ 工具函数 ===

// XML 强力清洗 (修复 Word 打不开的核心)
function escapeXml(unsafe) {
    if (!unsafe) return "";
    return unsafe
        // 1. 删除 ASCII 控制字符 (Word 崩溃元凶之一)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // 2. 【关键】删除换行符！Word 的 <w:t> 里不允许有 \n，必须删掉！
        .replace(/\n/g, '') 
        .replace(/\r/g, '')
        // 3. 标准转义
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function createClient(apiKey, baseUrl) {
    return new OpenAI({ apiKey: apiKey, baseURL: baseUrl });
}

// === B计划：纯文本兜底 ===
async function translateFallback(plainText, client, modelName) {
    plainText = plainText.replace(/\s+/g, ' ').trim();
    if (plainText.length < 1) return "";
    try {
        const completion = await client.chat.completions.create({
            model: modelName,
            messages: [{ role: "system", content: "翻译为简体中文，不带解释。" }, { role: "user", content: plainText }],
            temperature: 0.3
        });
        const res = completion.choices[0].message.content.trim();
        console.log(`   🔸 [B计划] 纯文本翻译成功`);
        return `<w:p><w:r><w:t>${escapeXml(res)}</w:t></w:r></w:p>`;
    } catch (e) {
        console.error(`   ❌ [B计划失败] ${e.message}`);
        return `<w:p><w:r><w:t>${escapeXml(plainText)}</w:t></w:r></w:p>`; 
    }
}

// === A计划：XML 外科手术 ===
async function translateXMLChunk(xmlChunk, client, modelName) {
    if (!xmlChunk.includes('<w:t')) return xmlChunk;
    const simpleText = xmlChunk.replace(/<[^>]+>/g, '').trim();
    if (simpleText.length < 1) return xmlChunk;

    try {
        if (xmlChunk.length > XML_LENGTH_LIMIT) throw new Error("XML_TOO_LONG");

        const completion = await client.chat.completions.create({
            model: modelName,
            messages: [
                { 
                    role: "system", 
                    content: `你是一个精通OpenXML的翻译引擎。
任务：将 <w:t> 标签内的文本翻译为【简体中文】。
规则：
1. 保持所有 <...> 标签结构绝对不变。
2. 不要输出 Markdown 标记。
3. 直接输出 XML 代码。` 
                },
                { role: "user", content: xmlChunk }
            ],
            temperature: 0.1
        });

        let res = completion.choices[0].message.content
            .replace(/```xml/g, '')
            .replace(/```/g, '')
            .trim();
        
        // 再次清洗：防止 AI 自己加了换行符或者漏了转义
        res = escapeXml(res.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')); 
        // 上面这行看着有点怪？解释一下：AI 有时候会返回已经转义的 &amp;，有时候返回 &。
        // 为了统一，我们先还原，再用 escapeXml 统一转义，防止 &amp;amp; 这种双重转义。
        // 但更稳妥的方式是针对性修复：
        
        // 【修正版清洗逻辑】
        // 1. 先去掉 Markdown
        let cleanRes = completion.choices[0].message.content.replace(/```xml/g, '').replace(/```/g, '').trim();
        // 2. 删掉换行
        cleanRes = cleanRes.replace(/\n/g, '');
        // 3. 修复 & 符号 (如果 AI 返回了 & 且后面不是转义符，就帮它转义)
        cleanRes = cleanRes.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;))/g, '&amp;');

        if (!cleanRes.includes('<w:t')) throw new Error("AI_BROKE_FORMAT");
        
        return cleanRes;

    } catch (e) {
        return await translateFallback(simpleText, client, modelName);
    }
}

// === Word 处理主循环 ===
async function translateDocx(inputPath, outputPath, client, modelName) {
    const zip = new AdmZip(inputPath);
    let contentXml = zip.readAsText("word/document.xml");
    const matches = contentXml.match(/<w:p[\s\S]*?<\/w:p>/g);

    if (matches) {
        const total = matches.length;
        console.log(`---> 启动翻译 (${modelName}), 并发数: ${CONCURRENCY_LIMIT}`);

        for (let i = 0; i < total; i += CONCURRENCY_LIMIT) {
            const batch = matches.slice(i, i + CONCURRENCY_LIMIT);
            process.stdout.write(`\r🚀 进度: ${Math.min(i + CONCURRENCY_LIMIT, total)}/${total} `);

            // 并发处理
            const results = await Promise.all(batch.map(chunk => translateXMLChunk(chunk, client, modelName)));
            
            // 替换回 XML
            for (let j = 0; j < batch.length; j++) {
                if (results[j] !== batch[j]) {
                    contentXml = contentXml.replace(batch[j], results[j]);
                }
            }
        }
    }
    console.log("\n📦 打包保存中...");
    zip.updateFile("word/document.xml", Buffer.from(contentXml, "utf-8"));
    zip.writeZip(outputPath);
}

// === 主入口 ===
export async function processFile(inputFile, outputDir, apiKey, baseUrl, modelName) {
    const ext = path.extname(inputFile).toLowerCase();
    const timestamp = Date.now();
    let finalFileName = ext === '.txt' ? `translated_${timestamp}.txt` : `translated_${timestamp}.docx`;
    const finalPath = path.join(outputDir, finalFileName);
    const client = createClient(apiKey, baseUrl);

    console.log(`\n📄 开始处理: ${path.basename(inputFile)}`);

    try {
        if (ext === '.txt') {
            const content = await fs.readFile(inputFile, 'utf-8');
            const chunks = content.match(/[\s\S]{1,2000}/g) || []; // TXT 切大点
            const translated = await Promise.all(chunks.map(async chunk => {
                try {
                    const res = await client.chat.completions.create({
                        model: modelName, messages: [{ role: "user", content: `翻译成中文:\n${chunk}` }]
                    });
                    return res.choices[0].message.content;
                } catch (e) { return chunk; }
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