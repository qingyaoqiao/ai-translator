import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import OpenAI from 'openai'; // 只引入，不初始化！
import AdmZip from 'adm-zip';

const execPromise = util.promisify(exec);
const CONCURRENCY_LIMIT = 10; 

// XML 清洗工具
function escapeXml(unsafe) {
    if (!unsafe) return "";
    return unsafe.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// === 关键修改：工厂函数 ===
// 只有调用这个函数时，才会检查 Key，防止启动时崩馈
function createClient(apiKey, baseUrl) {
    return new OpenAI({ apiKey: apiKey, baseURL: baseUrl });
}

// B计划：接收 client 和 modelName
async function translateFallback(plainText, client, modelName) {
    plainText = plainText.replace(/\s+/g, ' ').trim();
    if (plainText.length < 1) return "";
    try {
        const completion = await client.chat.completions.create({
            model: modelName,
            messages: [{ role: "system", content: "翻译为简体中文。" }, { role: "user", content: plainText }],
            temperature: 0.3
        });
        return `<w:p><w:r><w:t>${escapeXml(completion.choices[0].message.content.trim())}</w:t></w:r></w:p>`;
    } catch (e) {
        return `<w:p><w:r><w:t>${escapeXml(plainText)}</w:t></w:r></w:p>`; 
    }
}

// A计划：接收 client 和 modelName
async function translateXMLChunk(xmlChunk, client, modelName) {
    if (!xmlChunk.includes('<w:t')) return xmlChunk;
    const simpleText = xmlChunk.replace(/<[^>]+>/g, '').trim();
    if (simpleText.length < 1) return xmlChunk;

    try {
        if (xmlChunk.length > 6000) throw new Error("XML_TOO_LONG");
        const completion = await client.chat.completions.create({
            model: modelName,
            messages: [
                { role: "system", content: "你是一个精通OpenXML的翻译引擎。将<w:t>内容翻译为中文。严禁修改标签。必须转义特殊字符。" },
                { role: "user", content: xmlChunk }
            ],
            temperature: 0.1
        });
        let res = completion.choices[0].message.content.replace(/```xml/g, '').replace(/```/g, '').trim();
        res = res.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;))/g, '&amp;');
        if (!res.includes('<w:t')) throw new Error("AI_BROKE_FORMAT");
        return res;
    } catch (e) {
        return await translateFallback(simpleText, client, modelName);
    }
}

async function translateDocx(inputPath, outputPath, client, modelName) {
    const zip = new AdmZip(inputPath);
    let contentXml = zip.readAsText("word/document.xml");
    const matches = contentXml.match(/<w:p[\s\S]*?<\/w:p>/g);

    if (matches) {
        const total = matches.length;
        console.log(`---> 启动翻译 (${modelName}), 并发数: ${CONCURRENCY_LIMIT}`);

        for (let i = 0; i < total; i += CONCURRENCY_LIMIT) {
            const batch = matches.slice(i, i + CONCURRENCY_LIMIT);
            const results = await Promise.all(batch.map(chunk => translateXMLChunk(chunk, client, modelName)));
            for (let j = 0; j < batch.length; j++) contentXml = contentXml.replace(batch[j], results[j]);
        }
    }
    zip.updateFile("word/document.xml", Buffer.from(contentXml, "utf-8"));
    zip.writeZip(outputPath);
}

// 主入口：接收 apiKey, baseUrl, modelName
export async function processFile(inputFile, outputDir, apiKey, baseUrl, modelName) {
    const ext = path.extname(inputFile).toLowerCase();
    const timestamp = Date.now();
    let finalFileName = ext === '.txt' ? `translated_${timestamp}.txt` : `translated_${timestamp}.docx`;
    const finalPath = path.join(outputDir, finalFileName);

    // 1. 在这里才创建客户端！
    const client = createClient(apiKey, baseUrl);
    
    console.log(`📄 处理文件: ${path.basename(inputFile)} | 模型: ${modelName}`);

    if (ext === '.txt') {
        const content = await fs.readFile(inputFile, 'utf-8');
        const chunks = content.match(/[\s\S]{1,1500}/g) || [];
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
        
        // 兼容 Linux/Docker 环境的 Python 调用
        const pythonCommand = process.platform === "win32" ? "python" : "python3";
        await execPromise(`${pythonCommand} converter.py "${inputFile}" "${tempDocx}"`);
        
        await translateDocx(tempDocx, finalPath, client, modelName);
    } 
    return finalPath;
}