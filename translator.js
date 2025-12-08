import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import OpenAI from 'openai'; // 只要引入类，不要在这里 new
import AdmZip from 'adm-zip';

const execPromise = util.promisify(exec);
const CONCURRENCY_LIMIT = 10; 

// 工具：清洗 XML
function escapeXml(unsafe) {
    if (!unsafe) return "";
    return unsafe.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// === 工厂函数：动态创建 OpenAI 客户端 ===
function createClient(apiKey, baseUrl) {
    return new OpenAI({ apiKey: apiKey, baseURL: baseUrl });
}

// === B计划 ===
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

// === A计划 ===
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

// === Word 处理 ===
async function translateDocx(inputPath, outputPath, client, modelName) {
    const zip = new AdmZip(inputPath);
    let contentXml = zip.readAsText("word/document.xml");
    const matches = contentXml.match(/<w:p[\s\S]*?<\/w:p>/g);

    if (matches) {
        const total = matches.length;
        // 动态检测：如果用户用的是 deepseek，模型名不同；如果是 openai，可能是 gpt-4o
        // 这里为了简单，我们做个简单的判断，或者你可以让用户在前台也输入模型名
        // 默认尝试 deepseek-chat (v3)
        console.log(`---> 启动翻译，并发数: ${CONCURRENCY_LIMIT}`);

        for (let i = 0; i < total; i += CONCURRENCY_LIMIT) {
            const batch = matches.slice(i, i + CONCURRENCY_LIMIT);
            const results = await Promise.all(batch.map(chunk => translateXMLChunk(chunk, client, modelName)));
            for (let j = 0; j < batch.length; j++) contentXml = contentXml.replace(batch[j], results[j]);
        }
    }
    zip.updateFile("word/document.xml", Buffer.from(contentXml, "utf-8"));
    zip.writeZip(outputPath);
}

// === 主入口 ===
// 接收 apiKey 和 baseUrl
export async function processFile(inputFile, outputDir, apiKey, baseUrl) {
    const ext = path.extname(inputFile).toLowerCase();
    const timestamp = Date.now();
    let finalFileName = ext === '.txt' ? `translated_${timestamp}.txt` : `translated_${timestamp}.docx`;
    const finalPath = path.join(outputDir, finalFileName);

    // 1. 创建该用户的专属客户端
    const client = createClient(apiKey, baseUrl);
    
    // 2. 简单的模型猜测 (你也可以在前端加个输入框让用户填模型名)
    // 如果 URL 包含 deepseek 或 siliconflow，通常用 deepseek-ai/DeepSeek-V3
    // 否则默认 gpt-3.5-turbo
    let modelName = "gpt-3.5-turbo";
    if (baseUrl.includes("deepseek") || baseUrl.includes("siliconflow")) {
        modelName = "deepseek-ai/DeepSeek-V3"; 
    }

    console.log(`处理文件: ${path.basename(inputFile)}, 使用模型: ${modelName}`);

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
        await execPromise(`python converter.py "${inputFile}" "${tempDocx}"`);
        await translateDocx(tempDocx, finalPath, client, modelName);
    } 
    return finalPath;
}