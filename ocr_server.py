"""
ocr_server.py

Simple OCR server dùng Flask, bypass bug 'colors' của ddddocr API built-in.
Chỉ cần: pip install ddddocr flask
"""

import base64
import io
import sys
from flask import Flask, request, jsonify
import ddddocr

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except AttributeError:
    pass

app = Flask(__name__)

# Khởi tạo ddddocr 1 lần khi server start
print("🤖 Khởi tạo ddddocr...", flush=True)
ocr = ddddocr.DdddOcr(beta=True, show_ad=False)
print("✅ ddddocr sẵn sàng", flush=True)


@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "engine": "ddddocr-custom"})


@app.route('/ocr', methods=['POST'])
def solve_ocr():
    """
    Nhận ảnh base64 → trả text đọc được
    Body: { "image": "base64_string" }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({"error": "Thiếu field 'image'"}), 400

        # Decode base64 → bytes
        image_base64 = data['image']
        # Loại bỏ prefix "data:image/png;base64," nếu có
        if ',' in image_base64:
            image_base64 = image_base64.split(',', 1)[1]
        image_bytes = base64.b64decode(image_base64)

        # Gọi ddddocr classification - KHÔNG dùng tham số 'colors'
        result = ocr.classification(image_bytes)

        print(f"🔤 OCR: {result}", flush=True)

        return jsonify({
            "result": result,
            "processing_time": 0  # có thể đo thêm nếu cần
        })
    except Exception as e:
        print(f"❌ Error: {e}", flush=True)
        return jsonify({"error": str(e)}), 500


@app.route('/set_charset_range', methods=['POST'])
def set_charset():
    """
    Set charset range
    Body: { "charset_range": ["0","1",...] }
    """
    try:
        data = request.get_json()
        charset_range = data.get('charset_range', [])
        if charset_range:
            # ddddocr: set_ranges với string hoặc list
            charset_str = ''.join(charset_range)
            ocr.set_ranges(charset_str)
            return jsonify({"result": "OK", "length": len(charset_range)})
        return jsonify({"result": "OK", "message": "Empty range, bỏ qua"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    port = 8001
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    print(f"🚀 OCR server đang chạy tại http://localhost:{port}", flush=True)
    print(f"   Endpoints: /health, /ocr, /set_charset_range", flush=True)
    app.run(host='0.0.0.0', port=port, debug=False)
