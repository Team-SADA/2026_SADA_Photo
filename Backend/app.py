import json
import os
import subprocess
import time

import requests
from PIL import Image, ImageOps, ImageDraw, ImageWin
try:
    import win32ui
except ImportError:
    win32ui = None
from flask import Flask, jsonify, request, send_from_directory


app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.abspath(os.path.join(BASE_DIR, ".."))
IMAGE_DIR = os.path.join(BASE_DIR, "images")
OBAMIFY_DIR = os.path.join(PROJECT_DIR, "obamify")

# Final destination for the generated Obamify GIF.
SADANECUT_API_URL = "https://api.sada.ai.kr/api/v1/sadanecut"
SADANECUT_BOOTH_KEY = os.environ.get("SADANECUT_BOOTH_KEY")

ALLOWED_IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "bmp"}
current_job = None


os.makedirs(IMAGE_DIR, exist_ok=True)


def allowed_image(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_IMAGE_EXTS


def safe_filename(filename):
    return os.path.basename(filename).replace("\\", "")


def create_job_directory(label):
    safe_label = safe_filename(label).replace(" ", "-") or "job"
    job_id = f"{safe_label}-{int(time.time() * 1000)}"
    job_dir = os.path.join(IMAGE_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)
    return job_id, job_dir


def write_job_log(job_dir, event, **details):
    record = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, **details}
    with open(os.path.join(job_dir, "events.jsonl"), "a", encoding="utf-8") as log_file:
        log_file.write(json.dumps(record, ensure_ascii=False) + "\n")


def find_saved_file(filename):
    safe_name = safe_filename(filename)
    for root, _, files in os.walk(IMAGE_DIR):
        if safe_name in files:
            return root, safe_name
    return None


def archive_uploaded_file(file, job_dir, filename):
    file.stream.seek(0)
    file.save(os.path.join(job_dir, filename))
    file.stream.seek(0)


def find_obamify_exe():
    release_exe = os.path.join(OBAMIFY_DIR, "target", "release", "obamify.exe")
    debug_exe = os.path.join(OBAMIFY_DIR, "target", "debug", "obamify.exe")
    if os.path.exists(release_exe):
        return release_exe
    if os.path.exists(debug_exe):
        return debug_exe
    return None


@app.route("/")
def index():
    return jsonify({"ok": True, "service": "SADA Photo Backend"})


@app.route("/api/print", methods=["POST"])
def print_photo():
    image_file = request.files.get("image")
    if image_file is None or image_file.filename == "":
        return jsonify({"error": "image is required."}), 400
    job_id, job_dir = create_job_directory("print")
    archive_uploaded_file(image_file, job_dir, "print-image.jpg")
    write_job_log(job_dir, "print_file_saved")
    try:
        copies = int(request.form.get("copies", "1"))
    except ValueError:
        write_job_log(job_dir, "error", stage="printing", message="copies must be a number")
        return jsonify({"error": "copies must be a number between 0 and 4."}), 400
    if not 0 <= copies <= 4:
        write_job_log(job_dir, "error", stage="printing", message="copies must be between 0 and 4")
        return jsonify({"error": "copies must be between 0 and 4."}), 400
    if copies == 0:
        write_job_log(job_dir, "print_skipped", copies=0)
        return jsonify({"success": True, "copies": 0, "job_id": job_id})
    printer_name = os.environ.get("SELPHY_PRINTER_NAME", "Canon SELPHY CP1500")
    if win32ui is None:
        write_job_log(job_dir, "error", stage="printing", message="pywin32 is not installed.")
        return jsonify({"error": "pywin32 is not installed. Install it before printing."}), 503
    try:
        image = Image.open(image_file.stream).convert("RGB")
        # SELPHY can ignore all but the first page of a multi-page document.
        # Submit each requested copy as an independent printer job instead.
        for copy_number in range(1, copies + 1):
            dc = win32ui.CreateDC()
            dc.CreatePrinterDC(printer_name)
            printable_width = dc.GetDeviceCaps(8)
            printable_height = dc.GetDeviceCaps(10)
            scale = min(printable_width / image.width, printable_height / image.height)
            width, height = int(image.width * scale), int(image.height * scale)
            left, top = (printable_width - width) // 2, (printable_height - height) // 2
            dc.StartDoc(f"SADANECUT Photo {copy_number} of {copies}")
            dc.StartPage()
            ImageWin.Dib(image).draw(dc.GetHandleOutput(), (left, top, left + width, top + height))
            dc.EndPage()
            dc.EndDoc()
            dc.DeleteDC()
        write_job_log(job_dir, "print_complete", printer=printer_name, copies=copies)
        return jsonify({"success": True, "printer": printer_name, "copies": copies, "job_id": job_id})
    except Exception as error:
        app.logger.exception("Could not print photo")
        write_job_log(job_dir, "error", stage="printing", message=str(error), printer=printer_name)
        return jsonify({"error": str(error), "printer": printer_name}), 500


@app.route("/api/gifs")
def api_gifs():
    gif_files = []
    for root, _, files in os.walk(IMAGE_DIR):
        for filename in files:
            if filename.lower().endswith(".gif"):
                gif_files.append((filename, os.path.getmtime(os.path.join(root, filename))))
    gif_files = [filename for filename, _ in sorted(gif_files, key=lambda item: item[1], reverse=True)]
    return jsonify({"gifs": gif_files})


@app.route("/gif/<filename>", methods=["GET", "HEAD"])
def get_gif(filename):
    saved_file = find_saved_file(filename)
    if saved_file is None:
        return jsonify({"error": "GIF was not found."}), 404
    return send_from_directory(*saved_file)


@app.route("/source/<filename>")
def get_source(filename):
    saved_file = find_saved_file(filename)
    if saved_file is None:
        return jsonify({"error": "Source image was not found."}), 404
    return send_from_directory(*saved_file)


@app.route("/upload_images", methods=["POST"])
def upload_images():
    global current_job

    if "source" not in request.files or "target" not in request.files:
        return jsonify({"error": "Both source and target images are required."}), 400

    source_file = request.files["source"]
    target_file = request.files["target"]
    user_id = request.form.get("user_id", "output").strip() or "output"

    if source_file.filename == "" or target_file.filename == "":
        return jsonify({"error": "Selected files cannot have empty filenames."}), 400

    if not allowed_image(source_file.filename) or not allowed_image(target_file.filename):
        return jsonify({"error": "Invalid file type. Use PNG, JPG, JPEG, WEBP, or BMP."}), 400

    timestamp = int(time.time() * 1000)
    src_ext = source_file.filename.rsplit(".", 1)[1].lower()
    tgt_ext = target_file.filename.rsplit(".", 1)[1].lower()
    src_name = f"source_{timestamp}.{src_ext}"
    tgt_name = f"target_{timestamp}.{tgt_ext}"
    job_id, job_dir = create_job_directory(user_id)

    source_file.save(os.path.join(job_dir, src_name))
    target_file.save(os.path.join(job_dir, tgt_name))
    write_job_log(job_dir, "source_images_saved", source=src_name, target=tgt_name, user_id=user_id)

    current_job = {
        "job_id": job_id,
        "directory": job_dir,
        "source": src_name,
        "target": tgt_name,
        "user_id": user_id,
        "status": "pending",
    }

    obamify_exe = find_obamify_exe()
    if not obamify_exe:
        write_job_log(job_dir, "error", message="obamify.exe was not found.")
        return jsonify({
            "error": "obamify.exe was not found.",
            "obamify_dir": OBAMIFY_DIR,
        }), 500

    env = os.environ.copy()
    env["OBAMIFY_AUTO_USER_ID"] = user_id

    subprocess.Popen([obamify_exe, "--auto"], cwd=OBAMIFY_DIR, env=env)
    write_job_log(job_dir, "obamify_started", executable=obamify_exe)
    message = f"Images uploaded. Obamify started for {user_id}."

    return jsonify(
        {
            "success": True,
            "source_filename": src_name,
            "target_filename": tgt_name,
            "user_id": user_id,
            "gif_filename": f"{user_id}.gif",
            "source_url": f"/source/{src_name}",
            "target_url": f"/source/{tgt_name}",
            "message": message,
            "obamify_started": obamify_exe is not None,
        }
    )


@app.route("/api/pending_job", methods=["GET"])
def get_pending_job():
    global current_job

    if current_job and current_job["status"] == "pending":
        current_job["status"] = "processing"
        return jsonify(current_job)

    return jsonify({"message": "No pending jobs"}), 204


@app.route("/upload_gif", methods=["POST"])
def upload_gif():
    global current_job

    if "file" not in request.files:
        return jsonify({"error": "No file part"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No selected file"}), 400

    filename = safe_filename(file.filename)
    if not filename.lower().endswith(".gif"):
        return jsonify({"error": "Invalid file type"}), 400

    if current_job and current_job.get("directory"):
        job_dir = current_job["directory"]
    else:
        _, job_dir = create_job_directory("unmatched-gif")
    gif_path = os.path.join(job_dir, filename)
    file.save(gif_path)
    write_job_log(job_dir, "gif_saved", filename=filename)
    try:
        gif = Image.open(gif_path)
        frame_indices = [0, max(0, gif.n_frames // 3), max(0, (gif.n_frames * 2) // 3), gif.n_frames - 1]
        frames = []
        for index in frame_indices:
            gif.seek(index)
            frames.append(gif.convert("RGB").copy())
        for index, frame in enumerate(frames):
            frame.save(os.path.join(job_dir, f"{os.path.splitext(filename)[0]}-frame-{index}.jpg"), "JPEG", quality=92)
        cell = 480
        canvas = Image.new("RGB", (cell, cell * 4), "white")
        for index, frame in enumerate(frames):
            canvas.paste(ImageOps.fit(frame, (cell, cell)), (0, index * cell))
        fourcut_filename = f"{os.path.splitext(filename)[0]}-fourcut.jpg"
        canvas.save(os.path.join(job_dir, fourcut_filename), "JPEG", quality=92)
        write_job_log(job_dir, "fourcut_created", filename=fourcut_filename)
    except Exception as error:
        app.logger.exception("Could not create Obamify four-cut JPEG: %s", error)
        write_job_log(job_dir, "error", stage="fourcut_creation", message=str(error))

    if current_job:
        current_job["status"] = "done"
        current_job["gif_filename"] = filename

    return jsonify({"success": True, "filename": filename})


@app.route("/api/create_morph_gif", methods=["POST"])
def create_morph_gif():
    frames = request.files.getlist("frames")
    user_id = safe_filename(request.form.get("user_id", "morph").strip()) or "morph"
    if len(frames) < 2:
        return jsonify({"error": "At least two morph frames are required."}), 400
    job_id, job_dir = create_job_directory(user_id)
    try:
        images = [Image.open(frame.stream).convert("RGB") for frame in frames]
        for index, image in enumerate(images, start=1):
            image.save(os.path.join(job_dir, f"morph-input-{index}.jpg"), "JPEG", quality=92)
        filename = f"{user_id}.gif"
        images[0].save(
            os.path.join(job_dir, filename),
            save_all=True,
            append_images=images[1:],
            duration=70,
            loop=0,
            optimize=False,
        )
        write_job_log(job_dir, "morph_gif_created", filename=filename, input_count=len(images))
        return jsonify({"success": True, "filename": filename, "url": f"/gif/{filename}"})
    except Exception as error:
        app.logger.exception("Could not encode morph GIF")
        write_job_log(job_dir, "error", stage="morph_gif_creation", message=str(error))
        return jsonify({"error": "Could not encode morph GIF."}), 500


@app.route("/fourcut/<filename>")
def get_fourcut(filename):
    saved_file = find_saved_file(filename)
    if saved_file is None:
        return jsonify({"error": "Four-cut image was not found."}), 404
    return send_from_directory(*saved_file)


@app.route("/api/send_sadanecut_file", methods=["POST"])
def send_sadanecut_file():
    if not SADANECUT_BOOTH_KEY:
        return jsonify({"error": "SADANECUT_BOOTH_KEY is not configured."}), 503

    student_id = request.form.get("student_id", "").strip()
    image = request.files.get("image")
    gif = request.files.get("gif")
    if not student_id or image is None or image.filename == "":
        return jsonify({"error": "student_id and image are required."}), 400
    job_id, job_dir = create_job_directory(f"delivery-{student_id}")
    archive_uploaded_file(image, job_dir, "final-image.jpg")
    if gif is not None and gif.filename:
        archive_uploaded_file(gif, job_dir, "final-animation.gif")
    write_job_log(job_dir, "delivery_files_saved", student_id=student_id, has_gif=bool(gif and gif.filename))
    responses = []
    try:
        with image.stream as image_file:
            responses.append(requests.post(
                SADANECUT_API_URL,
                headers={"X-Booth-Key": SADANECUT_BOOTH_KEY},
                data={"student_id": student_id},
                files={"image": (image.filename, image_file, "image/jpeg")},
                timeout=60,
            ))
        if gif is not None and gif.filename:
            with gif.stream as gif_file:
                responses.append(requests.post(
                    SADANECUT_API_URL,
                    headers={"X-Booth-Key": SADANECUT_BOOTH_KEY},
                    data={"student_id": student_id},
                    files={"image": (gif.filename, gif_file, "image/gif")},
                    timeout=60,
                ))
    except requests.RequestException as error:
        app.logger.exception("Could not send files to SADA")
        write_job_log(job_dir, "error", stage="sada_upload", message=str(error))
        return jsonify({"error": "Could not reach SADA.", "job_id": job_id}), 502
    results = []
    for response in responses:
        try:
            body = response.json()
        except ValueError:
            body = response.text
        results.append({"success": response.ok, "status": response.status_code, "response": body})
    for result in results:
        app.logger.info("SADA upload result: status=%s body=%s", result["status"], result["response"])
    write_job_log(job_dir, "sada_upload_complete", results=results)
    # GIF support is being enabled separately. A GIF failure must not discard a
    # successful four-cut JPEG upload.
    status = 200 if results[0]["success"] else 502
    return jsonify({"success": status == 200, "jpeg": results[0], "gif": results[1] if len(results) > 1 else None}), status


@app.route("/api/send_sadanecut", methods=["POST"])
def send_sadanecut():
    if not SADANECUT_BOOTH_KEY:
        return jsonify({"error": "SADANECUT_BOOTH_KEY is not configured."}), 503

    student_id = request.form.get("student_id", "").strip()
    gif_filename = safe_filename(request.form.get("gif_filename", "").strip())

    if not student_id:
        return jsonify({"error": "student_id is required."}), 400
    if not gif_filename:
        return jsonify({"error": "gif_filename is required."}), 400

    saved_file = find_saved_file(gif_filename)
    if saved_file is None:
        return jsonify({"error": f"{gif_filename} was not found."}), 404
    gif_path = os.path.join(*saved_file)

    with open(gif_path, "rb") as gif_file:
        response = requests.post(
            SADANECUT_API_URL,
            headers={"X-Booth-Key": SADANECUT_BOOTH_KEY},
            data={"student_id": student_id},
            files={"image": (gif_filename, gif_file, "image/gif")},
            timeout=60,
        )

    try:
        body = response.json()
    except ValueError:
        body = response.text

    return jsonify(
        {
            "success": response.ok,
            "status": response.status_code,
            "response": body,
        }
    ), response.status_code


if __name__ == "__main__":
    app.run(debug=True, port=5000)
