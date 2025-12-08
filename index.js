import OpenAI from 'openai';
import dotenv from 'dotenv';
// 引入文件系统模块，用来读写文件
import fs from 'fs/promises'; 

dotenv.config();

const client = new OpenAI({
    apiKey: process.env.API_KEY, 
    baseURL: process.env.BASE_URL 
});

async function main() {
    try {
        console.log("1. 正在读取 source.txt 文件...");
        // 读取文件内容，'utf-8' 保证中文不乱码
        const textToTranslate = await fs.readFile('source.txt', 'utf-8');
        
        console.log(`2. 读取成功！字数：${textToTranslate.length}。正在发送给 AI...`);

        const completion = await client.chat.completions.create({
            model: "deepseek-ai/DeepSeek-V3", // 记得改成你实际用的模型名
            messages: [
                { 
                    role: "system", 
                    content: "你是一个专业的翻译助手。请直接输出翻译后的内容，不要包含任何解释性的话语。" 
                },
                { 
                    role: "user", 
                    content: `请把下面这段文字翻译成英文：\n\n${textToTranslate}` 
                }
            ],
        });

        const translatedText = completion.choices[0].message.content;

        console.log("3. 翻译完成！正在保存到 result.txt...");
        // 把结果写入新文件
        await fs.writeFile('result.txt', translatedText);

        console.log("✅ 搞定！请查看项目文件夹下的 result.txt 文件。");

    } catch (error) {
        console.error("❌ 出错了：", error);
    }
}

main();