# converter.py
from pdf2docx import Converter
import sys
import os

def pdf_to_word(pdf_file, docx_file):
    # 获取绝对路径，防止路径错误
    pdf_path = os.path.abspath(pdf_file)
    docx_path = os.path.abspath(docx_file)
    
    print(f"[Python] Starting conversion: {pdf_path} -> {docx_path}")
    
    try:
        cv = Converter(pdf_path)
        # start=0, end=None 转换所有页
        cv.convert(docx_path, start=0, end=None)
        cv.close()
        print("[Python] Conversion finished successfully.")
    except Exception as e:
        print(f"[Python] Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python converter.py input.pdf output.docx")
        sys.exit(1)
        
    input_pdf = sys.argv[1]
    output_docx = sys.argv[2]
    pdf_to_word(input_pdf, output_docx)