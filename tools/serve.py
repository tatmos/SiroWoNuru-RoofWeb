"""ローカル確認用のサーバー。ファイルを直したらすぐ反映されるよう、ブラウザにキャッシュさせない。
使い方: python tools/serve.py [ポート]（start.bat から呼ばれる）
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".glb": "model/gltf-binary",
        ".wav": "audio/wav",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler)
    print(f"http://localhost:{port}/ で配っています（Ctrl+C か窓を閉じると止まります）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
