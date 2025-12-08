# 🌍 AI 全能文档翻译机 (AI Document Translator)

这是一个基于 Node.js + Python + DeepSeek/OpenAI API 的全能文档翻译工具。
支持保留 Word/PDF 的格式（表格、图片、字体样式），并提供简洁的网页界面。

## ✨ 功能特点
- **多格式支持**：支持 .txt, .docx, .pdf。
- **格式保留**：采用 XML 式替换，最大程度保留 Word 原文格式。
- **极速并发**：支持多线程并发翻译，加大长文档处理速度。
- **智能 PDF**：利用 Python `pdf2docx` 将 PDF 转换为可编辑文档后翻译。

## 🛠️ 技术栈
- **后端**：Node.js (Express), Python (pdf2docx)
- **前端**：HTML/CSS (原生)
- **AI**：OpenAI 接口 (推荐 DeepSeek V3)

本人还没弄完……
 * 翻译后的 Word 文档如果提示“发现无法读取的内容”，请点击“是”进行修复即可正常查看。这是由于 XML 修改导致的正常现象。
---
