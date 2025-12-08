import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import OpenAI from 'openai';
import AdmZip from 'adm-zip';

const execPromise = util.promisify(exec);
// ⚠️ 调试模式：为了查错，先把并发数降为 1，避免刷屏
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

// === 打印错误日志的工具 ===
function logError(stage, error) {
    console.error(`\n❌ [${stage} 失败]`);
    if (error.response) {
        // API 返回的错误（最有用）
        console.error("   状态码:", error.status);
        console.error("   错误信息:", JSON.stringify(error.response.data, null, 2));
    } else {
        // 网络或其他错误
        console.error("   原因:", error.message);
    }
}

// B计划
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
        logError("B计划(纯文本)", e); // <--- 这里加了日志
        return `<w:p><w:r><w:t>${escapeXml(plainText)}</w:t></w:r></w:p>`; 
    }
}

// A计划
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
        // A计划经常失败转B计划，所以这里我们只打印警告，不当成错误
        // console.warn("A计划失败，转B计划..."); 
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
            
            // 打印进度
            process.stdout.write(`\r🚀 处理进度: ${i}/${total}`);

            const results = await Promise.all(batch.map(chunk => translateXMLChunk(chunk, client, modelName)));
            for (let j = 0; j < batch.length; j++) contentXml = contentXml.replace(batch[j], results[j]);
        }
    }
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
                try {
                    const res = await client.chat.completions.create({
                        model: modelName, messages: [{ role: "user", content: `翻译成中文:\n${chunk}` }]
                    });
                    return res.choices[0].message.content;
                } catch (e) { 
                    logError("TXT翻译", e); // <--- 这里加了日志
                    return chunk; 
                }
            }));
            await fs.writeFile(finalPath, translated.join("\n"));
        } else if (ext === '.docx') {
            await translateDocx(inputFile, finalPath, client, modelName);
        } else if (ext === '.pdf') {
            const tempDocx = path.join(outputDir, `temp_${timestamp}.docx`);
            // Linux 兼容性命令
            const pythonCommand = process.platform === "win32" ? "python" : "python3";
            await execPromise(`${pythonCommand} converter.py "${inputFile}" "${tempDocx}"`);
            await translateDocx(tempDocx, finalPath, client, modelName);
        } 
        return finalPath;
    } catch (error) {
        console.error("🔥 严重错误:", error);
        throw error;
    }
}