import os
import time
from flask import Flask, render_template, send_from_directory, request, jsonify

app = Flask(__name__)

# 디렉토리 설정
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GIF_DIR = os.path.join(BASE_DIR, "GIF")
SOURCE_DIR = os.path.join(BASE_DIR, "SOURCE")

# 필요한 디렉토리 생성
for d in [GIF_DIR, SOURCE_DIR]:
    if not os.path.exists(d):
        os.makedirs(d)

ALLOWED_IMAGE_EXTS = {'png', 'jpg', 'jpeg', 'webp', 'bmp'}

# Rust obamify가 폴링할 작업 상태 전역 변수
# { "source": filename, "target": filename, "status": "pending"|"processing"|"done" }
current_job = None

def allowed_image(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_IMAGE_EXTS

@app.route('/')
def index():
    return render_template('index.html')

# ─── 페이지 ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')

# ─── API ───────────────────────────────────────────────────────────────────────

@app.route('/api/gifs')
def api_gifs():
    """현재 GIF 폴더에 있는 GIF 목록을 JSON으로 반환"""
    gif_files = []
    if os.path.exists(GIF_DIR):
        gif_files = sorted(
            [f for f in os.listdir(GIF_DIR) if f.lower().endswith('.gif')],
            key=lambda f: os.path.getmtime(os.path.join(GIF_DIR, f)),
            reverse=True  # 최신 순 정렬
        )
    return jsonify({"gifs": gif_files})

@app.route('/gif/<filename>')
def get_gif(filename):
    """GIF 파일 반환"""
    return send_from_directory(GIF_DIR, filename)

@app.route('/source/<filename>')
def get_source(filename):
    """업로드된 소스 이미지 반환"""
    return send_from_directory(SOURCE_DIR, filename)

@app.route('/upload_images', methods=['POST'])
def upload_images():
    """사다네컷 프론트엔드에서 원본(Source) 이미지와 대상(Target) 이미지를 둘 다 업로드받는 API"""
    global current_job
    if 'source' not in request.files or 'target' not in request.files:
        print("[Flask] Upload failed: Source or target image is missing")
        return jsonify({"error": "Both source and target images are required."}), 400

    source_file = request.files['source']
    target_file = request.files['target']

    if source_file.filename == '' or target_file.filename == '':
        print("[Flask] Upload failed: Empty filename")
        return jsonify({"error": "Selected files cannot have empty filenames."}), 400

    user_id = request.form.get('user_id', 'output')

    if source_file and allowed_image(source_file.filename) and target_file and allowed_image(target_file.filename):
        timestamp = int(time.time() * 1000)
        
        src_ext = source_file.filename.rsplit('.', 1)[1].lower()
        tgt_ext = target_file.filename.rsplit('.', 1)[1].lower()

        src_name = f"source_{timestamp}.{src_ext}"
        tgt_name = f"target_{timestamp}.{tgt_ext}"

        src_path = os.path.join(SOURCE_DIR, src_name)
        tgt_path = os.path.join(SOURCE_DIR, tgt_name)

        source_file.save(src_path)
        target_file.save(tgt_path)

        # 새로운 작업을 설정하여 Rust가 폴링 시 가져가도록 함
        current_job = {
            "source": src_name,
            "target": tgt_name,
            "user_id": user_id,
            "status": "pending"
        }

        print(f"[Flask] ✅ Source saved: {src_name}, Target saved: {tgt_name}. User ID: {user_id}. Job created.")
        
        # --- AUTOMATIC SUBPROCESS TRIGGER ---
        # obamify 바이너리 경로 탐색 및 자동 실행
        import subprocess
        obamify_dir = os.path.abspath(os.path.join(BASE_DIR, "..", "..", "obamify"))
        obamify_exe = os.path.join(obamify_dir, "target", "release", "obamify.exe")
        if not os.path.exists(obamify_exe):
            # debug 빌드도 검색
            obamify_exe = os.path.join(obamify_dir, "target", "debug", "obamify.exe")
            
        if os.path.exists(obamify_exe):
            print(f"[Flask] Spawning obamify process for {user_id}: {obamify_exe}")
            # 서브프로세스의 환경 변수로 user_id 주입
            env = os.environ.copy()
            env["OBAMIFY_AUTO_USER_ID"] = user_id
            subprocess.Popen([obamify_exe, "--auto"], cwd=obamify_dir, env=env)
        else:
            print(f"[Flask] ⚠️ obamify.exe not found at target/release or target/debug. Please build it first.")

        return jsonify({
            "success": True,
            "source_filename": src_name,
            "target_filename": tgt_name,
            "user_id": user_id,
            "source_url": f"/source/{src_name}",
            "target_url": f"/source/{tgt_name}",
            "message": f"Both images uploaded successfully. Spawning Obamify process for {user_id}."
        }), 200

    return jsonify({"error": "Invalid file type. Use PNG, JPG, JPEG, WEBP, or BMP."}), 400

@app.route('/api/pending_job', methods=['GET'])
def get_pending_job():
    """Rust obamify 클라이언트가 작업 대기를 폴링하기 위해 호출하는 API"""
    global current_job
    if current_job and current_job["status"] == "pending":
        # 작업을 가져갔으므로 처리 중(processing) 상태로 전환
        current_job["status"] = "processing"
        return jsonify(current_job), 200
    return jsonify({"message": "No pending jobs"}), 204

@app.route('/upload_gif', methods=['POST'])
def upload_gif():
    """Rust obamify 백엔드로부터 완성된 GIF를 업로드받는 API"""
    global current_job
    if 'file' not in request.files:
        print("[Flask] GIF upload failed: No file part")
        return jsonify({"error": "No file part"}), 400

    file = request.files['file']
    if file.filename == '':
        print("[Flask] GIF upload failed: Empty filename")
        return jsonify({"error": "No selected file"}), 400

    if file and file.filename.lower().endswith('.gif'):
        save_path = os.path.join(GIF_DIR, file.filename)
        file.save(save_path)
        print(f"[Flask] ✅ GIF received and saved: {file.filename}")
        
        # 현재 처리하던 작업이 있다면 완료(done) 처리
        if current_job:
            current_job["status"] = "done"

        return jsonify({"success": True, "message": f"Saved {file.filename}"}), 200

    print(f"[Flask] GIF upload failed: Invalid type for {file.filename}")
    return jsonify({"error": "Invalid file type"}), 400

if __name__ == '__main__':
    app.run(debug=True, port=5000)
