from flask import Flask, render_template, request, jsonify, send_file
import os
import json
import time
import shutil
from pathlib import Path
from datetime import datetime

app = Flask(__name__)

WWWROOT = Path("wwwroot")
HISTORY_DIR = WWWROOT / ".history"
CONFIG_FILE = Path(".workspace_config.json")

WWWROOT.mkdir(exist_ok=True)
HISTORY_DIR.mkdir(exist_ok=True)

# Global state for workspace configuration
workspace_config = {
    "mode": "server",  # "server" or "local"
    "local_path": None
}

def load_workspace_config():
    """Load workspace configuration from file"""
    global workspace_config
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r") as f:
                workspace_config = json.load(f)
        except:
            workspace_config = {"mode": "server", "local_path": None}

def save_workspace_config():
    """Save workspace configuration to file"""
    with open(CONFIG_FILE, "w") as f:
        json.dump(workspace_config, f, indent=2)

def get_workspace_root():
    """Get the current workspace root path"""
    if workspace_config.get("mode") == "local" and workspace_config.get("local_path"):
        return Path(workspace_config["local_path"])
    return WWWROOT

def is_local_mode():
    """Check if in local mode"""
    return workspace_config.get("mode") == "local"

load_workspace_config()


def normalize_relative_path(raw_path):
    """Normalize and validate a workspace-relative path."""
    if raw_path is None:
        return None

    path = str(raw_path).replace("\\", "/").strip().strip("/")
    if not path:
        return None

    parts = [part for part in path.split("/") if part and part != "."]
    if not parts or any(part == ".." for part in parts):
        return None

    return "/".join(parts)


def resolve_workspace_path(raw_path):
    """Resolve a relative path to an absolute path inside the workspace root."""
    normalized = normalize_relative_path(raw_path)
    if not normalized:
        return None, None

    workspace_root = get_workspace_root()
    absolute = (workspace_root / normalized).resolve()
    workspace_resolved = workspace_root.resolve()

    if absolute != workspace_resolved and workspace_resolved not in absolute.parents:
        return None, None

    return absolute, normalized

# Keep old function name for backward compatibility
def resolve_wwwroot_path(raw_path):
    """Deprecated: Use resolve_workspace_path instead."""
    return resolve_workspace_path(raw_path)

def get_file_list():
    """Get recursive list of .mmd and .md files in workspace root."""
    workspace_root = get_workspace_root()
    files = []

    if not workspace_root.exists():
        return files

    for file in workspace_root.rglob("*"):
        if ".history" in file.parts:
            continue
        if file.is_file() and file.suffix in [".mmd", ".md"]:
            files.append(file.relative_to(workspace_root).as_posix())
    return sorted(files)


def get_folder_list():
    """Get recursive list of folders in workspace root excluding .history."""
    workspace_root = get_workspace_root()
    folders = []

    if not workspace_root.exists():
        return folders

    for folder in workspace_root.rglob("*"):
        if not folder.is_dir():
            continue
        if ".history" in folder.parts:
            continue
        folders.append(folder.relative_to(workspace_root).as_posix())
    return sorted(folders)

def get_history_path(filename):
    """Get history directory for a file. Returns None if in local mode."""
    if is_local_mode():
        return None
    return HISTORY_DIR / filename

def save_to_history(filename, content):
    """Save current version to history with timestamp. Does nothing if in local mode."""
    if is_local_mode():
        return None

    history_path = get_history_path(filename)
    if not history_path:
        return None

    history_path.mkdir(exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    version_file = history_path / f"{timestamp}.txt"

    with open(version_file, "w", encoding="utf-8") as f:
        f.write(content)

    return timestamp

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/config", methods=["GET"])
def get_config():
    """Get current workspace configuration"""
    return jsonify({
        "mode": workspace_config.get("mode"),
        "local_path": workspace_config.get("local_path")
    })

@app.route("/config", methods=["POST"])
def set_config():
    """Set workspace configuration"""
    global workspace_config
    data = request.json or {}
    mode = data.get("mode", "server")
    local_path = data.get("local_path")

    if mode not in ["server", "local"]:
        return jsonify({"error": "Invalid mode"}), 400

    if mode == "local":
        if not local_path:
            return jsonify({"error": "Local path is required for local mode"}), 400

        workspace_root = Path(local_path).resolve()

        # Check if path exists and is a directory
        if not workspace_root.exists() or not workspace_root.is_dir():
            return jsonify({"error": "Local path does not exist or is not a directory"}), 400

        workspace_config = {
            "mode": "local",
            "local_path": str(workspace_root)
        }
    else:
        workspace_config = {
            "mode": "server",
            "local_path": None
        }

    save_workspace_config()
    return jsonify({
        "success": True,
        "mode": workspace_config.get("mode"),
        "local_path": workspace_config.get("local_path")
    })

@app.route("/files", methods=["GET"])
def files():
    """List all folders and .mmd/.md files recursively."""
    return jsonify({
        "folders": get_folder_list(),
        "files": get_file_list()
    })

@app.route("/load/<path:filepath>", methods=["GET"])
def load_file(filepath):
    """Load file content"""
    file_path, _ = resolve_workspace_path(filepath)

    if not file_path or not file_path.exists() or file_path.is_dir():
        return jsonify({"error": "File not found"}), 404

    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    return jsonify({"code": content})

@app.route("/save", methods=["POST"])
def save_file():
    """Save file content"""
    data = request.json or {}
    filename = data.get("filename")
    code = data.get("code", "")

    if not filename:
        return jsonify({"error": "Filename required"}), 400

    normalized_filename = normalize_relative_path(filename)
    if not normalized_filename:
        return jsonify({"error": "Invalid filename"}), 400

    if not normalized_filename.endswith(".mmd") and not normalized_filename.endswith(".md"):
        return jsonify({"error": "Only .mmd and .md files are supported"}), 400

    file_path, normalized_filename = resolve_workspace_path(normalized_filename)
    if not file_path:
        return jsonify({"error": "Invalid filename"}), 400

    file_path.parent.mkdir(parents=True, exist_ok=True)

    # Save to history if file exists (disabled in local mode)
    if file_path.exists() and not is_local_mode():
        with open(file_path, "r", encoding="utf-8") as f:
            old_content = f.read()
        save_to_history(normalized_filename, old_content)

    # Write new content
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(code)

    return jsonify({"success": True, "filename": normalized_filename})

@app.route("/rename", methods=["POST"])
def rename_file():
    """Rename an existing .mmd/.md file and its history folder."""
    data = request.json or {}
    old_filename = normalize_relative_path(data.get("oldFilename", ""))
    new_filename = normalize_relative_path(data.get("newFilename", ""))

    if not old_filename or not new_filename:
        return jsonify({"error": "Both old and new filenames are required"}), 400

    if not (old_filename.endswith(".mmd") or old_filename.endswith(".md")):
        return jsonify({"error": "Only .mmd and .md files can be renamed"}), 400

    if not (new_filename.endswith(".mmd") or new_filename.endswith(".md")):
        new_filename += ".mmd"

    if old_filename == new_filename:
        return jsonify({"success": True, "filename": new_filename})

    old_file_path, old_filename = resolve_workspace_path(old_filename)
    new_file_path, new_filename = resolve_workspace_path(new_filename)
    if not old_file_path or not new_file_path:
        return jsonify({"error": "Invalid filename"}), 400

    if not old_file_path.exists() or old_file_path.is_dir():
        return jsonify({"error": "Source file not found"}), 404

    if new_file_path.exists():
        return jsonify({"error": "Target filename already exists"}), 409

    new_file_path.parent.mkdir(parents=True, exist_ok=True)
    old_file_path.rename(new_file_path)

    # Handle history rename only if not in local mode
    if not is_local_mode():
        old_history_path = get_history_path(old_filename)
        new_history_path = get_history_path(new_filename)

        if new_history_path and new_history_path.exists():
            return jsonify({"error": "History already exists for target filename"}), 409

        if old_history_path and old_history_path.exists():
            new_history_path.parent.mkdir(parents=True, exist_ok=True)
            old_history_path.rename(new_history_path)

    return jsonify({"success": True, "filename": new_filename})


@app.route("/folder", methods=["POST"])
def create_folder():
    """Create a folder (including nested folders) in workspace."""
    data = request.json or {}
    folder_path = normalize_relative_path(data.get("path", ""))

    if not folder_path:
        return jsonify({"error": "Folder path is required"}), 400

    absolute_path, normalized_path = resolve_workspace_path(folder_path)
    if not absolute_path:
        return jsonify({"error": "Invalid folder path"}), 400

    if absolute_path.exists() and absolute_path.is_file():
        return jsonify({"error": "A file already exists at this path"}), 409

    absolute_path.mkdir(parents=True, exist_ok=True)
    return jsonify({"success": True, "path": normalized_path})


@app.route("/folder", methods=["DELETE"])
def delete_folder():
    """Delete a folder recursively from workspace."""
    data = request.json or {}
    folder_path = normalize_relative_path(data.get("path", ""))

    if not folder_path:
        return jsonify({"error": "Folder path is required"}), 400

    absolute_path, normalized_path = resolve_workspace_path(folder_path)
    workspace_root = get_workspace_root()
    if not absolute_path or not absolute_path.exists() or not absolute_path.is_dir():
        return jsonify({"error": "Folder not found"}), 404

    if absolute_path == workspace_root.resolve():
        return jsonify({"error": "Cannot delete workspace root"}), 400

    shutil.rmtree(absolute_path)

    if not is_local_mode():
        history_path = get_history_path(normalized_path)
        if history_path and history_path.exists():
            shutil.rmtree(history_path)

    return jsonify({"success": True})

@app.route("/folder/rename", methods=["POST"])
def rename_folder():
    """Rename a folder and all its contents."""
    data = request.json or {}
    old_path = normalize_relative_path(data.get("oldPath", ""))
    new_path = normalize_relative_path(data.get("newPath", ""))

    if not old_path or not new_path:
        return jsonify({"error": "Both old and new folder paths are required"}), 400

    if old_path == new_path:
        return jsonify({"success": True, "path": new_path})

    old_absolute, old_normalized = resolve_workspace_path(old_path)
    new_absolute, new_normalized = resolve_workspace_path(new_path)
    workspace_root = get_workspace_root()

    if not old_absolute or not new_absolute:
        return jsonify({"error": "Invalid folder path"}), 400

    if not old_absolute.exists() or not old_absolute.is_dir():
        return jsonify({"error": "Source folder not found"}), 404

    if new_absolute.exists():
        return jsonify({"error": "Target folder already exists"}), 409

    if old_absolute == workspace_root.resolve():
        return jsonify({"error": "Cannot rename workspace root"}), 400

    # Create parent directory if needed
    new_absolute.parent.mkdir(parents=True, exist_ok=True)

    # Rename the folder
    old_absolute.rename(new_absolute)

    # Rename history folder if it exists (only in server mode)
    if not is_local_mode():
        old_history_path = get_history_path(old_normalized)
        new_history_path = get_history_path(new_normalized)
        if old_history_path and old_history_path.exists():
            new_history_path.parent.mkdir(parents=True, exist_ok=True)
            old_history_path.rename(new_history_path)

    return jsonify({"success": True, "path": new_normalized})

@app.route("/upload", methods=["POST"])
def upload_file():
    """Upload a .mmd file (disabled in local mode)"""
    if is_local_mode():
        return jsonify({"error": "File upload is disabled in local mode. Edit files directly in your local workspace."}), 400

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    upload = request.files["file"]
    if not upload or not upload.filename:
        return jsonify({"error": "Invalid file"}), 400

    filename = Path(upload.filename).name.strip()
    if not filename:
        return jsonify({"error": "Invalid filename"}), 400

    if not filename.lower().endswith(".mmd"):
        return jsonify({"error": "Only .mmd files are allowed"}), 400

    if "/" in filename or "\\" in filename:
        return jsonify({"error": "Invalid filename"}), 400

    target_dir = normalize_relative_path(request.form.get("targetDir", ""))
    workspace_root = get_workspace_root()
    if target_dir:
        target_path, target_dir = resolve_workspace_path(target_dir)
        if not target_path:
            return jsonify({"error": "Invalid target directory"}), 400
        target_path.mkdir(parents=True, exist_ok=True)
        final_relative = f"{target_dir}/{filename}"
    else:
        target_path = workspace_root
        final_relative = filename

    file_path = target_path / filename
    if file_path.exists():
        return jsonify({"error": "File already exists"}), 409

    upload.save(file_path)
    return jsonify({"success": True, "filename": final_relative})

@app.route("/delete/<path:filepath>", methods=["DELETE"])
def delete_file(filepath):
    """Delete file"""
    file_path, normalized_path = resolve_workspace_path(filepath)

    if not file_path or not file_path.exists() or file_path.is_dir():
        return jsonify({"error": "File not found"}), 404

    file_path.unlink()

    # Also delete history if not in local mode
    if not is_local_mode():
        history_path = get_history_path(normalized_path)
        if history_path and history_path.exists():
            for version_file in history_path.glob("*.txt"):
                version_file.unlink()
            history_path.rmdir()

    return jsonify({"success": True})

@app.route("/history/<path:filepath>", methods=["GET"])
def list_history(filepath):
    """List all history versions for a file"""
    if is_local_mode():
        return jsonify([])

    _, normalized_path = resolve_workspace_path(filepath)
    if not normalized_path:
        return jsonify([])

    history_path = get_history_path(normalized_path)

    if not history_path or not history_path.exists():
        return jsonify([])

    versions = []
    for version_file in sorted(history_path.glob("*.txt"), reverse=True):
        timestamp = version_file.stem
        versions.append({
            "timestamp": timestamp,
            "date": datetime.strptime(timestamp, "%Y%m%d_%H%M%S").isoformat()
        })

    return jsonify(versions)

@app.route("/history/<path:filepath>/<timestamp>", methods=["GET"])
def load_history(filepath, timestamp):
    """Load specific version from history"""
    if is_local_mode():
        return jsonify({"error": "History is not available in local mode"}), 400

    _, normalized_path = resolve_workspace_path(filepath)
    if not normalized_path:
        return jsonify({"error": "Invalid path"}), 400

    history_path = get_history_path(normalized_path)
    if not history_path:
        return jsonify({"error": "History not available"}), 400

    version_file = history_path / f"{timestamp}.txt"

    if not version_file.exists():
        return jsonify({"error": "Version not found"}), 404

    with open(version_file, "r", encoding="utf-8") as f:
        content = f.read()

    return jsonify({"code": content})

if __name__ == "__main__":
    app.run(debug=True, port=5000)
