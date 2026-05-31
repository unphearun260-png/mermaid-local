// Global state
let editor;
let currentFile = null;
let currentFolder = null;
let isDarkMode = localStorage.getItem("theme") === "dark";
let currentZoomLevel = 1;
let currentPanX = 0;
let currentPanY = 0;
let isPanningDiagram = false;
let panStartClientX = 0;
let panStartClientY = 0;
let panStartX = 0;
let panStartY = 0;
let renderTimeout = null;
let lastRenderedContent = "";
let mermaidModulePromise = null;
let mermaidInitializedTheme = null;
let renderRequestId = 0;
let appBootstrapped = false;
let monacoInitStarted = false;
let monacoInitPromise = null;
let svgExportCandidates = [];
let collapsedFolders = new Set(JSON.parse(localStorage.getItem("collapsedFolders") || "[]"));
let lastSavedContent = ""; // Track last saved content for unsaved changes detection

// Mermaid themes configuration
const MERMAID_THEMES = {
    default: { name: "Default", mode: "light" },
    forest: { name: "Forest", mode: "light" },
    neutral: { name: "Neutral", mode: "light" },
    dark: { name: "Dark", mode: "dark" },
    base: { name: "Base", mode: "light" }
};

let selectedMermaidTheme = localStorage.getItem("mermaidTheme") || "default";

// Workspace configuration state
let workspaceConfig = {
    mode: "server",
    local_path: null,
    useFileSystemAPI: false,  // True if using FileSystem Access API
    folderHandle: null        // FileSystem API folder handle
};

// Backend availability state
let backendAvailable = true;

function setRenderStatus(text) {
    const statusElement = document.getElementById("renderStatus");
    if (statusElement) {
        statusElement.textContent = text;
    }
}

function showToast(message, duration = 3000) {
    const toast = document.createElement("div");
    toast.className = "toast";

    // Convert emoji icons to Font Awesome icons in the message
    let displayMessage = message;
    let iconClass = "";

    if (message.includes("✅")) {
        iconClass = "fa-circle-check";
        displayMessage = message.replace("✅ ", "").replace(" ✅", "");
    } else if (message.includes("❌")) {
        iconClass = "fa-circle-xmark";
        displayMessage = message.replace("❌ ", "").replace(" ❌", "");
    } else if (message.includes("⚠️")) {
        iconClass = "fa-triangle-exclamation";
        displayMessage = message.replace("⚠️ ", "").replace(" ⚠️", "");
    }

    if (iconClass) {
        toast.innerHTML = `<i class="fas ${iconClass}" style="margin-right: 8px;"></i>${displayMessage}`;
    } else {
        toast.textContent = message;
    }

    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    document.body.appendChild(toast);

    // Trigger animation
    setTimeout(() => toast.classList.add("show"), 10);

    // Remove after duration
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function getMarkdownPreview() {
    return document.getElementById("markdownPreview");
}

function getDiagramPreview() {
    const diagramPreview = document.getElementById("diagramPreview");
    if (diagramPreview) {
        return diagramPreview;
    }

    return null;
}

function createDiagramPreview() {
    const markdownPreview = getMarkdownPreview();
    if (!markdownPreview) {
        return null;
    }

    const existing = getDiagramPreview();
    if (existing) {
        return existing;
    }

    const diagramPreview = document.createElement("div");
    diagramPreview.id = "diagramPreview";
    diagramPreview.className = "diagram-preview";
    markdownPreview.parentNode.insertBefore(diagramPreview, markdownPreview);
    return diagramPreview;
}

function removeDiagramPreview() {
    const diagramPreview = getDiagramPreview();
    if (diagramPreview) {
        diagramPreview.remove();
    }
}

function getCurrentMermaidTheme() {
    // Check if selected theme is compatible with current mode
    const themeConfig = MERMAID_THEMES[selectedMermaidTheme];

    if (themeConfig && themeConfig.mode === (isDarkMode ? "dark" : "light")) {
        return selectedMermaidTheme;
    }

    // Fall back to default theme for the current mode
    if (isDarkMode && selectedMermaidTheme !== "dark") {
        return "dark";
    }

    // Find first light theme if in light mode
    for (const [key, config] of Object.entries(MERMAID_THEMES)) {
        if (config.mode === "light") {
            return key;
        }
    }

    return "default";
}

function getAvailableThemes() {
    // Return themes that match current mode
    const mode = isDarkMode ? "dark" : "light";
    return Object.entries(MERMAID_THEMES)
        .filter(([_, config]) => config.mode === mode)
        .map(([key, config]) => ({ key, ...config }));
}

function changeMermaidTheme(themeKey) {
    if (MERMAID_THEMES[themeKey]) {
        selectedMermaidTheme = themeKey;
        localStorage.setItem("mermaidTheme", themeKey);
        updateMermaidTheme();
        showToast(`✅ Theme changed to ${MERMAID_THEMES[themeKey].name}`, 2000);
    }
}

function getMarkedApi() {
    return window.marked || globalThis.marked || self.marked || null;
}

function isMonacoReady() {
    return Boolean(window.monaco && window.monaco.editor);
}

async function getMermaid() {
    if (!mermaidModulePromise) {
        mermaidModulePromise = import("https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs");
    }

    const { default: mermaid } = await mermaidModulePromise;
    const theme = getCurrentMermaidTheme();

    if (mermaidInitializedTheme !== theme) {
        // Reinitialize mermaid with new theme
        mermaid.initialize({
            startOnLoad: false,
            theme,
            securityLevel: "loose",
            logLevel: "error"
        });
        mermaidInitializedTheme = theme;
    }

    return mermaid;
}

// Initialize on load
document.addEventListener("DOMContentLoaded", async () => {
    if (appBootstrapped) {
        return;
    }
    appBootstrapped = true;

    initTheme();
    restoreSidebarState();
    await loadWorkspaceConfig();
    setupEventListeners();
    setupWorkspaceEventListeners();
    updateThemeSelector();

    // Warm up mermaid in the background so the first preview render is faster.
    getMermaid().catch(error => {
        console.warn("Mermaid preload failed:", error);
    });

    initMonaco();
});

function initMonaco() {
    if (editor) {
        return;
    }

    if (monacoInitPromise) {
        return monacoInitPromise;
    }

    monacoInitStarted = true;

    if (isMonacoReady()) {
        initMonacoEditor();
        loadFileList();
        monacoInitPromise = Promise.resolve();
        return monacoInitPromise;
    }

    monacoInitPromise = new Promise((resolve, reject) => {
        if (!window.require || !window.require.config) {
            reject(new Error("Monaco AMD loader is not available"));
            return;
        }

        window.require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs" } });

        window.require(["vs/editor/editor.main"], () => {
            if (!editor) {
                initMonacoEditor();
                loadFileList();
            }
            resolve();
        }, reject);
    });

    return monacoInitPromise;
}

// ==================== FileSystem Access API Support ====================

function supportsFileSystemAPI() {
    return typeof window.showDirectoryPicker !== "undefined";
}

async function selectFolderWithPicker() {
    try {
        if (!supportsFileSystemAPI()) {
            showToast("⚠️ Your browser doesn't support folder selection", 3000);
            return null;
        }

        const folderHandle = await window.showDirectoryPicker({
            mode: "readwrite",
            startIn: "documents"
        });

        // Verify folder handle works
        await folderHandle.queryPermission({ mode: "readwrite" });
        return folderHandle;
    } catch (error) {
        if (error.name !== "AbortError") {
            console.error("Error selecting folder:", error);
            showToast("❌ Failed to select folder", 3000);
        }
        return null;
    }
}

async function getFilesFromHandle(folderHandle, basePath = "") {
    const files = [];
    const folders = [];

    try {
        for await (const [name, handle] of folderHandle.entries()) {
            const fullPath = basePath ? `${basePath}/${name}` : name;

            if (handle.kind === "file") {
                if (name.endsWith(".mmd") || name.endsWith(".md")) {
                    files.push(fullPath);
                }
            } else if (handle.kind === "directory") {
                folders.push(fullPath);
                // Recursively get files from subdirectories
                const subResult = await getFilesFromHandle(handle, fullPath);
                files.push(...subResult.files);
                folders.push(...subResult.folders);
            }
        }
    } catch (error) {
        console.error("Error reading folder:", error);
    }

    return { files: files.sort(), folders: folders.sort() };
}

async function readFileFromHandle(folderHandle, filePath) {
    try {
        const parts = filePath.split("/");
        let currentHandle = folderHandle;

        // Navigate to the file
        for (let i = 0; i < parts.length - 1; i++) {
            currentHandle = await currentHandle.getDirectoryHandle(parts[i]);
        }

        const fileName = parts[parts.length - 1];
        const fileHandle = await currentHandle.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        return await file.text();
    } catch (error) {
        console.error("Error reading file:", error);
        throw new Error(`Failed to read file: ${error.message}`);
    }
}

async function writeFileFromHandle(folderHandle, filePath, content) {
    try {
        const parts = filePath.split("/");
        let currentHandle = folderHandle;

        // Create/navigate to parent directory
        for (let i = 0; i < parts.length - 1; i++) {
            currentHandle = await currentHandle.getDirectoryHandle(parts[i], { create: true });
        }

        const fileName = parts[parts.length - 1];
        const fileHandle = await currentHandle.getFileHandle(fileName, { create: true });

        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();

        return true;
    } catch (error) {
        console.error("Error writing file:", error);
        throw new Error(`Failed to write file: ${error.message}`);
    }
}

async function deleteFileFromHandle(folderHandle, filePath) {
    try {
        const parts = filePath.split("/");
        let currentHandle = folderHandle;

        // Navigate to parent directory
        for (let i = 0; i < parts.length - 1; i++) {
            currentHandle = await currentHandle.getDirectoryHandle(parts[i]);
        }

        const fileName = parts[parts.length - 1];
        await currentHandle.removeEntry(fileName);
        return true;
    } catch (error) {
        console.error("Error deleting file:", error);
        throw new Error(`Failed to delete file: ${error.message}`);
    }
}

// ==================== Workspace Configuration Management ====================

async function checkBackendAvailability() {
    try {
        const response = await fetch("/config", { method: "GET" });
        backendAvailable = response.ok;
    } catch {
        backendAvailable = false;
    }
}

async function loadWorkspaceConfig() {
    // Check if backend is available
    await checkBackendAvailability();

    // Load from backend if available
    if (backendAvailable) {
        try {
            const response = await fetch("/config");
            if (response.ok) {
                const config = await response.json();
                workspaceConfig = {
                    mode: config.mode,
                    local_path: config.local_path,
                    useFileSystemAPI: false,
                    folderHandle: null
                };
            }
        } catch (error) {
            console.warn("Failed to load workspace config from backend:", error);
        }
    }

    // Check for FileSystem API folder handle in localStorage
    const savedConfig = localStorage.getItem("workspaceConfig");
    if (savedConfig) {
        try {
            const config = JSON.parse(savedConfig);
            if (config.useFileSystemAPI) {
                // FileSystem API was previously used, but the handle is lost on refresh
                // Prompt user to re-select the folder
                workspaceConfig.useFileSystemAPI = true;
                workspaceConfig.mode = "local";
                workspaceConfig.folderHandle = null; // Handle is lost, needs re-selection

                // Show a toast to let user know they need to re-select folder
                setTimeout(() => {
                    showToast("📁 Please select your workspace folder again (browser security)", 5000);
                }, 1000);
            }
        } catch (error) {
            console.warn("Failed to load saved workspace config:", error);
        }
    }

    // Disable history button if in local mode
    const historyBtn = document.getElementById("historyBtn");
    if (historyBtn && workspaceConfig.mode === "local") {
        historyBtn.disabled = true;
        historyBtn.style.opacity = "0.5";
        historyBtn.title = "History is not available in local mode";
    }
}

function setupWorkspaceEventListeners() {
    const workspaceBtn = document.getElementById("workspaceBtn");
    const workspaceModal = document.getElementById("workspaceModal");
    const closeWorkspaceBtn = document.getElementById("closeWorkspaceBtn");
    const cancelWorkspaceBtn = document.getElementById("cancelWorkspaceBtn");
    const applyWorkspaceBtn = document.getElementById("applyWorkspaceBtn");
    const modeRadios = document.querySelectorAll('input[name="workspaceMode"]');
    const localPathSection = document.getElementById("localPathSection");
    const localPathInput = document.getElementById("localPathInput");
    const selectFolderBtn = document.getElementById("selectFolderBtn");
    const folderPickerGroup = document.getElementById("folderPickerGroup");
    const modeInfo = document.getElementById("modeDescription");

    if (!workspaceBtn || !workspaceModal) return;

    // Show FileSystem API folder picker if supported
    if (supportsFileSystemAPI()) {
        folderPickerGroup.classList.remove("hidden");
    }

    workspaceBtn.addEventListener("click", () => {
        // Populate modal with current config
        const modeRadio = document.querySelector(`input[name="workspaceMode"][value="${workspaceConfig.mode}"]`);
        if (modeRadio) {
            modeRadio.checked = true;
        }

        if (workspaceConfig.local_path && !workspaceConfig.useFileSystemAPI) {
            localPathInput.value = workspaceConfig.local_path;
        }

        updateWorkspaceModeInfo();
        workspaceModal.classList.remove("hidden");
    });

    // Handle folder picker button
    selectFolderBtn?.addEventListener("click", async () => {
        const folderHandle = await selectFolderWithPicker();
        if (folderHandle) {
            workspaceConfig.folderHandle = folderHandle;
            workspaceConfig.useFileSystemAPI = true;
            workspaceConfig.mode = "local";

            // Save config to localStorage
            localStorage.setItem("workspaceConfig", JSON.stringify({
                useFileSystemAPI: true,
                mode: "local"
            }));

            showToast("✅ Folder selected successfully", 3000);

            // Close modal and reload files
            workspaceModal.classList.add("hidden");
            loadFileList();
        }
    });

    closeWorkspaceBtn?.addEventListener("click", () => {
        workspaceModal.classList.add("hidden");
    });

    cancelWorkspaceBtn?.addEventListener("click", () => {
        workspaceModal.classList.add("hidden");
    });

    modeRadios.forEach(radio => {
        radio.addEventListener("change", () => {
            const isLocal = radio.value === "local";
            localPathSection.classList.toggle("hidden", !isLocal);
            updateWorkspaceModeInfo();
        });
    });

    applyWorkspaceBtn?.addEventListener("click", async () => {
        const selectedMode = document.querySelector('input[name="workspaceMode"]:checked')?.value || "server";
        const localPath = localPathInput.value.trim();

        if (selectedMode === "local" && !localPath) {
            showToast("⚠️ Please enter a local workspace path or select a folder");
            return;
        }

        try {
            if (selectedMode === "local" && backendAvailable) {
                // Using backend with local path
                const response = await fetch("/config", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        mode: selectedMode,
                        local_path: localPath
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    workspaceConfig = {
                        mode: data.mode,
                        local_path: data.local_path,
                        useFileSystemAPI: false,
                        folderHandle: null
                    };

                    showToast(`✅ Switched to local mode (backend)`);
                    workspaceModal.classList.add("hidden");
                    await loadFileList();
                } else {
                    const error = await response.json();
                    showToast(`❌ ${error.error || "Failed to apply workspace config"}`);
                }
            } else if (selectedMode === "server" && backendAvailable) {
                // Using server mode
                const response = await fetch("/config", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        mode: "server",
                        local_path: null
                    })
                });

                if (response.ok) {
                    workspaceConfig = {
                        mode: "server",
                        local_path: null,
                        useFileSystemAPI: false,
                        folderHandle: null
                    };
                    localStorage.removeItem("workspaceConfig");

                    showToast(`✅ Switched to server mode`);
                    workspaceModal.classList.add("hidden");
                    await loadFileList();
                }
            } else if (selectedMode === "server" && !backendAvailable) {
                showToast("⚠️ Backend server not available. No files to display.", 3000);
            }
        } catch (error) {
            console.error("Error applying workspace config:", error);
            showToast("❌ Error applying workspace config");
        }

        // Disable history button in local mode
        const historyBtn = document.getElementById("historyBtn");
        if (historyBtn) {
            historyBtn.disabled = selectedMode === "local";
            historyBtn.style.opacity = selectedMode === "local" ? "0.5" : "1";
        }
    });

    // Close modal when clicking outside
    workspaceModal?.addEventListener("click", (e) => {
        if (e.target === workspaceModal) {
            workspaceModal.classList.add("hidden");
        }
    });
}

function updateWorkspaceModeInfo() {
    const selectedMode = document.querySelector('input[name="workspaceMode"]:checked')?.value || "server";
    const modeInfo = document.getElementById("modeDescription");
    const folderPickerGroup = document.getElementById("folderPickerGroup");
    const pathInputGroup = document.getElementById("pathInputGroup");

    if (selectedMode === "local") {
        if (supportsFileSystemAPI()) {
            modeInfo.textContent = "Local mode: Use the 'Select Folder' button to choose a folder from your computer, or enter a server path if a backend is running. History tracking is disabled in this mode.";
            if (folderPickerGroup) folderPickerGroup.classList.remove("hidden");
            if (pathInputGroup) pathInputGroup.classList.remove("hidden");
        } else {
            modeInfo.textContent = "Local mode: Enter a server path (requires backend server running). History tracking is disabled in this mode.";
            if (folderPickerGroup) folderPickerGroup.classList.add("hidden");
            if (pathInputGroup) pathInputGroup.classList.remove("hidden");
        }
    } else {
        modeInfo.textContent = "Server mode: Files are stored on the server. You can upload files and track version history.";
        if (folderPickerGroup) folderPickerGroup.classList.add("hidden");
        if (pathInputGroup) pathInputGroup.classList.add("hidden");
    }
}

// Theme Management
function initTheme() {
    if (isDarkMode) {
        document.body.classList.add("dark-mode");
    }
}

function toggleTheme() {
    isDarkMode = !isDarkMode;
    document.body.classList.toggle("dark-mode");
    localStorage.setItem("theme", isDarkMode ? "dark" : "light");

    if (editor) {
        editor.updateOptions({
            theme: isDarkMode ? "mermaid-dark" : "mermaid-light"
        });
    }

    updateThemeSelector();
    updateMermaidTheme();
}

function updateThemeSelector() {
    const selector = document.getElementById("mermaidThemeSelect");
    if (!selector) return;

    // Get available themes for current mode
    const availableThemes = getAvailableThemes();

    // Update options
    selector.innerHTML = '<option value="">Select theme...</option>';
    availableThemes.forEach(theme => {
        const option = document.createElement("option");
        option.value = theme.key;
        option.textContent = theme.name;
        option.selected = selectedMermaidTheme === theme.key;
        selector.appendChild(option);
    });
}

async function updateMermaidTheme() {
    // Force mermaid reinitialization with new theme
    const mermaid = await getMermaid();

    // Clear mermaid's internal configuration to force reinitialize
    const theme = getCurrentMermaidTheme();
    mermaid.initialize({
        startOnLoad: false,
        theme,
        securityLevel: "loose",
        logLevel: "error"
    });

    // Clear rendered diagrams to force re-render
    const diagramPreview = getDiagramPreview();
    if (diagramPreview) {
        diagramPreview.innerHTML = "";
    }

    const markdownPreview = getMarkdownPreview();
    if (markdownPreview) {
        markdownPreview.innerHTML = "";
    }

    // Force complete re-render with new theme
    lastRenderedContent = ""; // Reset to force render
    renderPreview();
}

// Monaco Editor Setup
function registerMermaidLanguage() {
    // Register Mermaid language for syntax highlighting
    monaco.languages.register({ id: "mermaid" });

    // Define Mermaid syntax highlighting
    monaco.languages.setMonarchTokensProvider("mermaid", {
        tokenizer: {
            root: [
                // Comments
                { regex: /%%.*$/, action: { token: "comment" } },

                // Keywords: flowchart, graph, stateDiagram, sequenceDiagram, gantt, pie, etc.
                { regex: /\b(flowchart|graph|stateDiagram|sequenceDiagram|gantt|pie|erDiagram|requirementDiagram|classDiagram|gitGraph|C4Context|C4Container|C4Component|C4Dynamic|mindmap|timeline)\b/, action: { token: "keyword" } },

                // Directions: LR, RL, TD, BT, DU
                { regex: /\b(LR|RL|TD|BT|DU|TB)\b/, action: { token: "keyword.control" } },

                // Keywords for statements
                { regex: /\b(state|interface|abstract|class|enum|participant|actor|autonumber|alt|else|opt|loop|par|seq|strict|neg|critical|assert|break|par|break|check)\b/, action: { token: "keyword" } },

                // Keywords for node styles
                { regex: /\b(style|classDef|class|fill|stroke|color|background|fontSize|fontColor|padding|margin|lineHeight)\b/, action: { token: "keyword" } },

                // Special arrow types and connection syntax
                { regex: /-->|---|-\||\|-|==>|===|\.-->|\.\.\.>|x-->|o-->|<-->|<===|<\|/, action: { token: "operator" } },

                // Node IDs and labels in brackets
                { regex: /\[.*?\]/, action: { token: "string" } },
                { regex: /\(.*?\)/, action: { token: "string" } },
                { regex: /\{.*?\}/, action: { token: "string" } },
                { regex: /\|.*?\|/, action: { token: "string" } },

                // Subgraph declarations
                { regex: /\b(subgraph|end|break)\b/, action: { token: "keyword" } },

                // Numbers and booleans
                { regex: /\b(true|false|yes|no)\b/, action: { token: "constant.language" } },
                { regex: /-?\d+(\.\d+)?/, action: { token: "number" } },

                // Strings in quotes
                { regex: /"([^"\\]|\\.)*"/, action: { token: "string" } },
                { regex: /'([^'\\]|\\.)*'/, action: { token: "string" } },

                // Whitespace and operators
                { regex: /\s+/, action: { token: "white" } },
                { regex: /[=:;,.]/, action: { token: "operator" } },
            ]
        }
    });

    // Define color themes for Mermaid syntax
    monaco.editor.defineTheme("mermaid-light", {
        base: "vs",
        inherit: true,
        colors: {
            "editor.foreground": "#333333",
            "editor.background": "#ffffff",
            "editor.lineNumbersBackground": "#f5f5f5",
            "editorLineNumber.foreground": "#999999"
        },
        rules: [
            { token: "comment", foreground: "008000", fontStyle: "italic" },
            { token: "keyword", foreground: "0000FF", fontStyle: "bold" },
            { token: "keyword.control", foreground: "0070C1" },
            { token: "string", foreground: "A31515" },
            { token: "number", foreground: "098658" },
            { token: "constant.language", foreground: "000080" },
            { token: "operator", foreground: "D4D4D4" },
        ]
    });

    monaco.editor.defineTheme("mermaid-dark", {
        base: "vs-dark",
        inherit: true,
        colors: {
            "editor.foreground": "#e0e0e0",
            "editor.background": "#1e1e1e",
            "editor.lineNumbersBackground": "#1e1e1e",
            "editorLineNumber.foreground": "#666666"
        },
        rules: [
            { token: "comment", foreground: "6A9955", fontStyle: "italic" },
            { token: "keyword", foreground: "569CD6", fontStyle: "bold" },
            { token: "keyword.control", foreground: "4FC1FF" },
            { token: "string", foreground: "CE9178" },
            { token: "number", foreground: "B5CEA8" },
            { token: "constant.language", foreground: "9CDCFE" },
            { token: "operator", foreground: "D4D4D4" },
        ]
    });
}

function initMonacoEditor() {
    // Register Mermaid language before creating editor
    registerMermaidLanguage();

    editor = monaco.editor.create(document.getElementById("editor"), {
        value: "",
        language: "markdown",
        theme: isDarkMode ? "mermaid-dark" : "mermaid-light",
        minimap: { enabled: false },
        wordWrap: "on",
        automaticLayout: true,
        fontSize: 14,
        fontFamily: "'Courier New', monospace",
        scrollBeyondLastLine: false,
        renderWhitespace: "selection"
    });

    // Debounced render on content change
    editor.onDidChangeModelContent(() => {
        debouncedRenderPreview();
    });

    // Handle Ctrl+S to save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        saveFile();
    });
}

// Debounce render to avoid re-rendering on every keystroke
function debouncedRenderPreview() {
    clearTimeout(renderTimeout);
    setRenderStatus("Typing...");
    renderTimeout = setTimeout(() => {
        renderPreview();
    }, 250);
}

// File List Management
async function loadFileList() {
    try {
        let data;

        if (workspaceConfig.useFileSystemAPI && !workspaceConfig.folderHandle) {
            // FileSystem API was used before, but folder handle is lost (browser security)
            // Show a message and empty file list
            const fileList = document.getElementById("fileList");
            fileList.innerHTML = `
                <div style="padding: 20px; text-align: center; color: #666;">
                    <p>📁 Folder not selected</p>
                    <p style="font-size: 12px; margin-top: 10px;">
                        Click <strong>Workspace</strong> button and select your folder again
                    </p>
                </div>
            `;
            return;
        } else if (workspaceConfig.useFileSystemAPI && workspaceConfig.folderHandle) {
            // Load files from FileSystem API
            data = await getFilesFromHandle(workspaceConfig.folderHandle);
        } else if (backendAvailable) {
            // Load files from backend
            const response = await fetch("/files");
            data = await response.json();
        } else {
            // No backend and no FileSystem API folder selected
            data = { files: [], folders: [] };
        }

        const fileList = document.getElementById("fileList");
        fileList.innerHTML = "";

        renderFileTree(fileList, data.folders || [], data.files || []);

        if ((data.files || []).length > 0 && !currentFile) {
            openFile(data.files[0]);
        }
    } catch (error) {
        console.error("Error loading file list:", error);
        showToast("❌ Failed to load file list", 3000);
    }
}

function renderFileTree(container, folders, files) {
    // Build a map of folder → children
    const folderMap = new Map();

    // Initialize with root folder
    folderMap.set("", { type: "folder", path: "", depth: 0, children: [] });

    // Sort folders by depth (so parents are processed first)
    const sortedFolders = [...folders].sort((a, b) => {
        const depthA = a.split("/").length;
        const depthB = b.split("/").length;
        return depthA - depthB;
    });

    // Add folders to map
    sortedFolders.forEach(folder => {
        const depth = folder.split("/").length;
        folderMap.set(folder, { type: "folder", path: folder, depth, children: [] });
    });

    // Assign files and subfolders to their parent folder
    sortedFolders.forEach(folder => {
        const parentPath = folder.substring(0, folder.lastIndexOf("/")) || "";
        if (folderMap.has(parentPath)) {
            folderMap.get(parentPath).children.push(folder);
        }
    });

    files.forEach(file => {
        const parentPath = file.substring(0, file.lastIndexOf("/")) || "";
        if (folderMap.has(parentPath)) {
            folderMap.get(parentPath).children.push(file);
        }
    });

    // Render tree starting from root
    renderFolderContents(container, "", folderMap, 0);
}

function renderFolderContents(container, parentPath, folderMap, depth) {
    if (!folderMap.has(parentPath)) return;

    const folder = folderMap.get(parentPath);
    const children = folder.children || [];

    // Sort: folders first, then files
    children.sort((a, b) => {
        const aIsFolder = folderMap.has(a);
        const bIsFolder = folderMap.has(b);
        if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
        return a.localeCompare(b);
    });

    children.forEach(childPath => {
        if (folderMap.has(childPath)) {
            // It's a folder
            renderFolderItem(container, childPath, folderMap, depth);
        } else {
            // It's a file
            renderFileItem(container, childPath, depth);
        }
    });
}

function renderFolderItem(container, folderPath, folderMap, depth) {
    const folderName = folderPath.split("/").pop();
    const isCollapsed = collapsedFolders.has(folderPath);

    const row = document.createElement("div");
    row.className = "folder-item";
    row.style.setProperty("--depth", depth);
    row.dataset.folderPath = folderPath;
    row.title = folderPath; // Show full path on hover

    const toggle = document.createElement("i");
    toggle.className = `folder-toggle fas ${isCollapsed ? "fa-chevron-right" : "fa-chevron-down"}`;

    const icon = document.createElement("i");
    icon.className = "fas fa-folder";

    const name = document.createElement("span");
    name.textContent = folderName;
    name.className = "folder-name";

    row.appendChild(toggle);
    row.appendChild(icon);
    row.appendChild(name);

    // Handle folder toggle and selection
    row.addEventListener("click", (e) => {
        e.stopPropagation();

        // If clicking the toggle arrow, expand/collapse the folder
        if (e.target === toggle) {
            toggleFolder(folderPath);
        } else {
            // Otherwise, select the folder
            selectFolder(folderPath, row);
        }
    });

    // Make folder a drop target for file moves
    row.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("text/mermaidpath")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        row.classList.add("drop-target");
    });

    row.addEventListener("dragleave", (e) => {
        if (!row.contains(e.relatedTarget)) {
            row.classList.remove("drop-target");
        }
    });

    row.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove("drop-target");
        const srcPath = e.dataTransfer.getData("text/mermaidpath");
        if (!srcPath) return;
        await moveFile(srcPath, folderPath);
    });

    if (currentFolder === folderPath) {
        row.classList.add("active");
    }

    container.appendChild(row);

    // Render children if not collapsed
    if (!isCollapsed) {
        renderFolderContents(container, folderPath, folderMap, depth + 1);
    }
}

function renderFileItem(container, filePath, depth) {
    const item = document.createElement("div");
    item.className = "file-item";
    item.style.setProperty("--depth", depth);
    item.textContent = filePath.split("/").pop();
    item.title = filePath; // Show full path on hover
    item.dataset.filePath = filePath;
    item.addEventListener("click", () => openFile(filePath));

    // Make file draggable
    item.draggable = true;
    item.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/mermaidpath", filePath);
        e.dataTransfer.effectAllowed = "move";
        item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
        item.classList.remove("dragging");
        document.querySelectorAll(".folder-item.drop-target, .file-list.drop-target")
            .forEach(el => el.classList.remove("drop-target"));
    });

    if (currentFile === filePath) {
        item.classList.add("active");
    }

    container.appendChild(item);
}

function toggleFolder(folderPath) {
    if (collapsedFolders.has(folderPath)) {
        collapsedFolders.delete(folderPath);
    } else {
        collapsedFolders.add(folderPath);
    }
    localStorage.setItem("collapsedFolders", JSON.stringify([...collapsedFolders]));
    loadFileList();
}

function selectFolder(folderPath, element) {
    currentFolder = folderPath;
    currentFile = null; // Clear file selection when selecting a folder
    document.querySelectorAll(".folder-item").forEach(item => item.classList.remove("active"));
    document.querySelectorAll(".file-item").forEach(item => item.classList.remove("active"));
    element.classList.add("active");
}

async function checkUnsavedChanges() {
    if (!currentFile || !editor) return true;

    const currentContent = editor.getValue();
    if (currentContent !== lastSavedContent) {
        const choice = confirm(
            `File "${currentFile}" has unsaved changes.\n\n` +
            "Click OK to save before switching, or Cancel to discard changes."
        );

        if (choice) {
            // User chose to save
            await saveFile();
            return true;
        }
        // User chose to discard, allow switching
        return true;
    }
    return true;
}

async function openFile(filename) {
    try {
        if (!editor) {
            console.warn("Editor not ready yet");
            return;
        }

        // Check if in FileSystem API mode but folder handle is missing
        if (workspaceConfig.useFileSystemAPI && !workspaceConfig.folderHandle) {
            showToast("📁 Please select your workspace folder first", 3000);
            return;
        }

        // Check for unsaved changes before switching files
        if (currentFile && currentFile !== filename) {
            const canSwitch = await checkUnsavedChanges();
            if (!canSwitch) return;
        }

        let fileContent;

        if (workspaceConfig.useFileSystemAPI && workspaceConfig.folderHandle) {
            // Load file from FileSystem API
            fileContent = await readFileFromHandle(workspaceConfig.folderHandle, filename);
        } else {
            // Load file from backend
            const response = await fetch(`/load/${filename}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            fileContent = data.code;
        }

        // Set editor language based on file extension
        if (filename.endsWith(".mmd")) {
            editor.getModel().setLanguage("mermaid");
        } else if (filename.endsWith(".md")) {
            editor.getModel().setLanguage("markdown");
        } else {
            editor.getModel().setLanguage("plaintext");
        }

        editor.setValue(fileContent);
        currentFile = filename;
        currentFolder = null; // Clear folder selection when opening a file
        lastSavedContent = fileContent; // Track the saved content
        document.getElementById("filenameInput").value = filename;

        updateFileListUI();
        renderPreview();
    } catch (error) {
        console.error("Error opening file:", error);
        // Only show alert if user manually clicked a file
        if (currentFile) {
            showToast("❌ Failed to open file", 3000);
        }
    }
}

function updateFileListUI() {
    document.querySelectorAll(".file-item").forEach(item => {
        item.classList.toggle("active", item.dataset.filePath === currentFile);
    });
    document.querySelectorAll(".folder-item").forEach(item => {
        item.classList.toggle("active", item.dataset.folderPath === currentFolder);
    });
}

async function saveFile() {
    let filename = document.getElementById("filenameInput").value.trim();

    if (!filename) {
        showToast("⚠️ Please enter a filename", 3000);
        return;
    }

    if (!filename.endsWith(".mmd") && !filename.endsWith(".md")) {
        filename += ".mmd";
    }

    try {
        const editorContent = editor.getValue();

        if (workspaceConfig.useFileSystemAPI && !workspaceConfig.folderHandle) {
            showToast("📁 Please select your workspace folder first", 3000);
            return;
        }

        if (workspaceConfig.useFileSystemAPI && workspaceConfig.folderHandle) {
            // Save file using FileSystem API
            await writeFileFromHandle(workspaceConfig.folderHandle, filename, editorContent);
            currentFile = filename;
            lastSavedContent = editorContent;
            document.getElementById("filenameInput").value = currentFile;
            await loadFileList();
            showToast(`✅ File "${filename}" saved successfully!`, 3000);
        } else {
            // Save file via backend
            const response = await fetch("/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filename: filename,
                    code: editorContent
                })
            });

            if (response.ok) {
                const data = await response.json();
                currentFile = data.filename || filename;
                lastSavedContent = editorContent; // Update saved content tracking
                document.getElementById("filenameInput").value = currentFile;
                await loadFileList();
                showToast(`✅ File "${filename}" saved successfully!`, 3000);
            } else {
                try {
                    const errorData = await response.json();
                    showToast(`❌ ${errorData.error || "Error saving file"}`, 4000);
                } catch {
                    showToast("❌ Error saving file", 4000);
                }
            }
        }
    } catch (error) {
        console.error("Error saving file:", error);
        showToast(`❌ ${error.message || "Failed to save file"}`, 4000);
    }
}

async function deleteItem() {
    // Determine if we're deleting a file or folder
    if (currentFile) {
        await deleteFile();
    } else if (currentFolder) {
        await deleteFolder();
    } else {
        showToast("⚠️ No file or folder selected", 3000);
    }
}

async function deleteFile() {
    if (!currentFile) {
        showToast("⚠️ No file selected", 3000);
        return;
    }

    if (workspaceConfig.useFileSystemAPI && !workspaceConfig.folderHandle) {
        showToast("📁 Please select your workspace folder first", 3000);
        return;
    }

    if (!confirm(`Delete "${currentFile}"?`)) {
        return;
    }

    try {
        if (workspaceConfig.useFileSystemAPI && workspaceConfig.folderHandle) {
            // Delete file using FileSystem API
            await deleteFileFromHandle(workspaceConfig.folderHandle, currentFile);
        } else {
            // Delete file via backend
            const response = await fetch(`/delete/${currentFile}`, { method: "DELETE" });
            if (!response.ok) {
                throw new Error("Failed to delete file");
            }
        }

        currentFile = null;
        editor.setValue("");
        document.getElementById("filenameInput").value = "";
        await loadFileList();
        showToast("✅ File deleted", 3000);
    } catch (error) {
        console.error("Error deleting file:", error);
        showToast(`❌ ${error.message || "Failed to delete file"}`, 3000);
    }
}

async function renameCurrentFile() {
    // Prioritize file rename if a file is selected
    if (!currentFile) {
        // If no file selected, try to rename folder instead
        if (currentFolder) {
            await renameFolder();
        } else {
            showToast("⚠️ No file or folder selected", 3000);
        }
        return;
    }

    if (!currentFile.endsWith(".mmd") && !currentFile.endsWith(".md")) {
        showToast("⚠️ Only .mmd and .md files can be renamed", 3000);
        return;
    }

    let newFilename = prompt("Enter new filename:", currentFile);
    if (!newFilename) {
        return;
    }

    newFilename = newFilename.trim();
    if (!newFilename) {
        showToast("⚠️ Filename cannot be empty", 3000);
        return;
    }

    // Preserve original extension if not specified
    if (!newFilename.endsWith(".mmd") && !newFilename.endsWith(".md")) {
        const originalExt = currentFile.endsWith(".md") ? ".md" : ".mmd";
        newFilename += originalExt;
    }

    if (newFilename === currentFile) {
        return;
    }

    try {
        if (workspaceConfig.useFileSystemAPI && !workspaceConfig.folderHandle) {
            showToast("📁 Please select your workspace folder first", 3000);
            return;
        }

        if (workspaceConfig.useFileSystemAPI && workspaceConfig.folderHandle) {
            // Rename using FileSystem API: read, write to new name, delete old
            const content = await readFileFromHandle(workspaceConfig.folderHandle, currentFile);
            await writeFileFromHandle(workspaceConfig.folderHandle, newFilename, content);
            await deleteFileFromHandle(workspaceConfig.folderHandle, currentFile);
        } else {
            // Rename via backend
            const response = await fetch("/rename", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    oldFilename: currentFile,
                    newFilename
                })
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || "Rename failed");
            }
        }

        currentFile = newFilename;
        document.getElementById("filenameInput").value = currentFile;
        await loadFileList();
        updateFileListUI();
        showToast(`✅ File renamed to "${currentFile}"`, 3000);
    } catch (error) {
        console.error("Error renaming file:", error);
        showToast(error.message || "❌ Failed to rename file", 3000);
    }
}

async function renameFolder() {
    if (!currentFolder) {
        showToast("⚠️ No folder selected", 3000);
        return;
    }

    const folderName = currentFolder.split("/").pop();
    let newFolderPath = prompt("Enter new folder name:", folderName);
    if (!newFolderPath) {
        return;
    }

    newFolderPath = newFolderPath.trim();
    if (!newFolderPath) {
        showToast("⚠️ Folder name cannot be empty", 3000);
        return;
    }

    // If renaming a nested folder, keep the parent path
    if (currentFolder.includes("/")) {
        const parentPath = currentFolder.substring(0, currentFolder.lastIndexOf("/"));
        newFolderPath = `${parentPath}/${newFolderPath}`;
    }

    if (newFolderPath === currentFolder) {
        return;
    }

    try {
        const response = await fetch("/folder/rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                oldPath: currentFolder,
                newPath: newFolderPath
            })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || "Rename failed");
        }

        currentFolder = data.path;
        await loadFileList();
        updateFileListUI();
        showToast(`✅ Folder renamed to "${currentFolder}"`, 3000);
    } catch (error) {
        console.error("Error renaming folder:", error);
        showToast(error.message || "❌ Failed to rename folder", 3000);
    }
}

async function createNewFolder() {
    let folderPath = prompt("Enter folder path (e.g., 'MyFolder' or 'Parent/Child'):");
    if (!folderPath) {
        return;
    }

    folderPath = folderPath.trim();
    if (!folderPath) {
        showToast("⚠️ Folder path cannot be empty", 3000);
        return;
    }

    try {
        const response = await fetch("/folder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: folderPath })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || "Folder creation failed");
        }

        await loadFileList();
        showToast(`✅ Folder "${folderPath}" created successfully`, 3000);
    } catch (error) {
        console.error("Error creating folder:", error);
        showToast(error.message || "❌ Failed to create folder", 3000);
    }
}

async function deleteFolder() {
    if (!currentFolder) {
        showToast("⚠️ No folder selected", 3000);
        return;
    }

    if (!confirm(`Delete folder "${currentFolder}" and all its contents?`)) {
        return;
    }

    try {
        const response = await fetch("/folder", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: currentFolder })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || "Folder deletion failed");
        }

        // If current file is inside deleted folder, clear it
        if (currentFile && currentFile.startsWith(currentFolder + "/")) {
            currentFile = null;
            document.getElementById("filenameInput").value = "";
            editor.setValue("");
        }

        currentFolder = null;
        await loadFileList();
        showToast("✅ Folder deleted successfully", 3000);
    } catch (error) {
        console.error("Error deleting folder:", error);
        showToast(error.message || "❌ Failed to delete folder", 3000);
    }
}

async function moveFile(srcPath, targetFolder) {
    const fileName = srcPath.split("/").pop();
    const destPath = targetFolder ? `${targetFolder}/${fileName}` : fileName;

    if (srcPath === destPath) return;

    try {
        const response = await fetch("/rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ oldFilename: srcPath, newFilename: destPath })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Move failed");

        if (currentFile === srcPath) {
            currentFile = data.filename;
            document.getElementById("filenameInput").value = currentFile;
        }
        await loadFileList();
    } catch (error) {
        showToast(error.message || "❌ Failed to move file", 3000);
    }
}

async function uploadMmdFile(file) {
    const formData = new FormData();
    formData.append("file", file, file.name);

    const response = await fetch("/upload", {
        method: "POST",
        body: formData
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || `Failed to upload ${file.name}`);
    }

    return data.filename;
}

function setupFileDropUpload() {
    const sidebar = document.querySelector(".sidebar");
    const fileList = document.getElementById("fileList");

    if (!sidebar || !fileList) {
        return;
    }

    const dropTargets = [sidebar, fileList];

    const preventDefaults = (e) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const setDropActive = (isActive) => {
        sidebar.classList.toggle("drop-active", isActive);
    };

    dropTargets.forEach(target => {
        target.addEventListener("dragenter", (e) => {
            preventDefaults(e);
            setDropActive(true);
        });

        target.addEventListener("dragover", (e) => {
            preventDefaults(e);
            setDropActive(true);
        });

        target.addEventListener("dragleave", (e) => {
            preventDefaults(e);
            if (!sidebar.contains(e.relatedTarget)) {
                setDropActive(false);
            }
        });

        target.addEventListener("drop", async (e) => {
            preventDefaults(e);
            setDropActive(false);

            // If dragging internal files, skip OS upload handler
            if (e.dataTransfer.types.includes("text/mermaidpath")) {
                return;
            }

            // Check if in local mode
            if (workspaceConfig.mode === "local") {
                showToast("⚠️ File upload is disabled in local mode. Edit files directly in your local workspace.", 3000);
                return;
            }

            const droppedFiles = Array.from(e.dataTransfer?.files || []);
            const mmdFiles = droppedFiles.filter(file => file.name.toLowerCase().endsWith(".mmd"));

            if (mmdFiles.length === 0) {
                showToast("⚠️ Only .mmd files can be uploaded", 3000);
                return;
            }

            const uploaded = [];
            const failed = [];

            for (const file of mmdFiles) {
                try {
                    const uploadedFilename = await uploadMmdFile(file);
                    uploaded.push(uploadedFilename);
                } catch (error) {
                    failed.push(`${file.name}: ${error.message}`);
                }
            }

            await loadFileList();

            if (!currentFile && uploaded.length > 0) {
                await openFile(uploaded[0]);
            }

            if (failed.length > 0) {
                showToast(`⚠️ Uploaded ${uploaded.length} file(s), failed ${failed.length}`, 4000);
            } else {
                showToast(`✅ Uploaded ${uploaded.length} .mmd file(s) successfully`, 3000);
            }
        });
    });

    // Add root file-list as drop target for moving files to root
    fileList.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("text/mermaidpath")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        fileList.classList.add("drop-target");
    });

    fileList.addEventListener("dragleave", (e) => {
        if (!fileList.contains(e.relatedTarget)) {
            fileList.classList.remove("drop-target");
        }
    });

    fileList.addEventListener("drop", async (e) => {
        if (!e.dataTransfer.types.includes("text/mermaidpath")) return;
        e.preventDefault();
        fileList.classList.remove("drop-target");
        const srcPath = e.dataTransfer.getData("text/mermaidpath");
        if (!srcPath) return;
        await moveFile(srcPath, ""); // "" = root
    });
}

function createNewFile() {
    const defaultName = currentFolder ? `${currentFolder}/` : "";
    let filename = prompt("Enter new filename:", defaultName);
    if (filename) {
        filename = filename.trim();
        if (!filename.endsWith(".mmd") && !filename.endsWith(".md")) {
            filename += ".mmd";
        }
        document.getElementById("filenameInput").value = filename;

        // Set editor language based on file extension
        if (filename.endsWith(".mmd")) {
            editor.getModel().setLanguage("mermaid");
        } else if (filename.endsWith(".md")) {
            editor.getModel().setLanguage("markdown");
        } else {
            editor.getModel().setLanguage("plaintext");
        }

        editor.setValue("");
        currentFile = null;
        renderPreview();
    }
}

// Detect if content looks like Mermaid syntax
function isMermaidSyntax(content) {
    const mermaidKeywords = [
        "flowchart", "graph", "stateDiagram", "sequenceDiagram",
        "gantt", "pie", "classDiagram", "erDiagram", "gitGraph",
        "mindmap", "timeline", "state", "participant", "actor"
    ];
    return mermaidKeywords.some(keyword => content.includes(keyword));
}

// Preview Rendering
async function renderPreview() {
    const requestId = ++renderRequestId;
    const renderStartedAt = performance.now();
    const content = editor.getValue();

    // Skip if content hasn't changed
    if (content === lastRenderedContent) {
        return;
    }

    setRenderStatus("Rendering...");

    lastRenderedContent = content;
    const markdownPreview = getMarkdownPreview();
    const diagramPreview = getDiagramPreview();

    // Reset
    if (diagramPreview) {
        diagramPreview.innerHTML = "";
    }
    if (markdownPreview) {
        markdownPreview.innerHTML = "";
    }
    removeDiagramPreview();

    // Detect if content is markdown or mermaid
    const hasMermaid = content.includes("```mermaid");
    const hasMarkdownCodeBlock = content.includes("```");
    const hasMarkdownHeading = content.includes("#");
    const looksLikeMermaid = isMermaidSyntax(content);

    // Render as pure mermaid only if it looks like mermaid and has no markdown syntax
    if (looksLikeMermaid && !hasMarkdownCodeBlock && !hasMarkdownHeading && content.trim()) {
        const activeDiagramPreview = createDiagramPreview();
        await renderMermaid(content, activeDiagramPreview, requestId);
    }
    // Render markdown (with or without mermaid blocks)
    else if (content.trim()) {
        await renderMarkdownWithMermaid(content, markdownPreview, diagramPreview, requestId);
    }

    if (requestId === renderRequestId) {
        const durationMs = Math.round(performance.now() - renderStartedAt);
        setRenderStatus(`${durationMs} ms`);
    }
}

// Check if marked.js is loaded
async function ensureMarkedLoaded() {
    // Marked.js should be loaded synchronously from the script tag in HTML
    // Just return whether it's available
    const marked = getMarkedApi();
    if (marked) {
        return true;
    }
    // If marked is not available, we'll use the fallback renderer
    return false;
}

async function renderMermaid(diagramCode, container, requestId) {
    try {
        const mermaid = await getMermaid();
        const diagramId = `mermaid-diagram-${requestId}`;
        const svgElement = await mermaid.render(diagramId, diagramCode);

        if (requestId !== renderRequestId) {
            return;
        }

        container.innerHTML = svgElement.svg;

        // Add click handler to SVG
        const svg = container.querySelector("svg");
        if (svg) {
            svg.addEventListener("click", () => openDiagramZoom(svg));
        }
    } catch (error) {
        container.innerHTML = `<p style="color: red;">Error rendering diagram: ${error.message}</p>`;
    }
}

async function renderMarkdownWithMermaid(content, markdownContainer, diagramContainer) {
    try {
        const requestId = renderRequestId;
        const mermaid = await getMermaid();

        // Ensure marked is loaded
        const markedReady = await ensureMarkedLoaded();

        // Extract mermaid blocks - more flexible regex to handle variations
        const mermaidRegex = /```mermaid\s*\n([\s\S]*?)\n```/g;
        const mermaidBlocks = [];
        const htmlContent = content.replace(mermaidRegex, (match, blockCode) => {
            // Trim the code block but preserve internal formatting
            const trimmedCode = blockCode.trim();
            const blockIndex = mermaidBlocks.push(trimmedCode) - 1;
            return `<div class="mermaid-placeholder" id="mermaid-${requestId}-${blockIndex}"></div>`;
        });

        // Convert markdown to HTML
        let html;
        const markedApi = getMarkedApi();
        if (markedReady && markedApi) {
            html = await markedApi.parse(htmlContent);
        } else {
            // Fallback: simple markdown-like rendering
            // Extract code blocks first to protect them from other replacements
            const codeBlocks = [];
            html = htmlContent.replace(/```(.*?)\n([\s\S]*?)\n```/g, (match, lang, code) => {
                const escapedCode = code
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/"/g, "&quot;");
                const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
                codeBlocks.push(`<pre><code class="language-${lang}">${escapedCode}</code></pre>`);
                return placeholder;
            });

            // Now apply other markdown replacements
            html = html
                .replace(/^### (.*?)$/gm, "<h3>$1</h3>")
                .replace(/^## (.*?)$/gm, "<h2>$1</h2>")
                .replace(/^# (.*?)$/gm, "<h1>$1</h1>")
                .replace(/\n/g, "<br>")
                .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                .replace(/\*(.*?)\*/g, "<em>$1</em>")
                .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

            // Restore code blocks
            codeBlocks.forEach((block, index) => {
                html = html.replace(`__CODE_BLOCK_${index}__`, block);
            });
        }

        if (requestId !== renderRequestId) {
            return;
        }

        markdownContainer.innerHTML = html;

        // Render mermaid diagrams
        for (let i = 0; i < mermaidBlocks.length; i++) {
            const placeholder = document.getElementById(`mermaid-${requestId}-${i}`);
            if (placeholder) {
                try {
                    const svgElement = await mermaid.render(`mermaid-block-${requestId}-${i}`, mermaidBlocks[i]);

                    if (requestId !== renderRequestId) {
                        return;
                    }

                    placeholder.innerHTML = svgElement.svg;
                    placeholder.className = "mermaid-diagram";

                    // Add click handler to SVG
                    const svg = placeholder.querySelector("svg");
                    if (svg) {
                        svg.addEventListener("click", () => openDiagramZoom(svg));
                    }
                } catch (diagramError) {
                    // Show error for this specific diagram block only
                    placeholder.innerHTML = `<div style="background: #fee; border: 1px solid #c33; border-radius: 4px; padding: 12px; color: #c00;"><strong>⚠️ Diagram Error:</strong> ${diagramError.message}</div>`;
                    placeholder.className = "mermaid-error";
                }
            }
        }
    } catch (error) {
        markdownContainer.innerHTML = `<p style="color: red;">Error rendering content: ${error.message}</p>`;
    }
}

// Export Functions
async function exportAsSVG() {
    svgExportCandidates = getRenderedDiagrams();
    if (svgExportCandidates.length === 0) {
        showToast("⚠️ No diagram to export", 3000);
        return;
    }

    const svgExportList = document.getElementById("svgExportList");
    svgExportList.innerHTML = "";

    svgExportCandidates.forEach((_, index) => {
        const item = document.createElement("label");
        item.className = "svg-export-item";
        item.innerHTML = `
            <input type="checkbox" class="svg-export-checkbox" value="${index}" checked>
            Diagram ${index + 1}
        `;
        svgExportList.appendChild(item);
    });

    const selectAll = document.getElementById("selectAllSvgDiagrams");
    selectAll.checked = true;

    document.getElementById("exportSvgModal").classList.remove("hidden");
}

function getRenderedDiagrams() {
    return Array.from(document.querySelectorAll("#preview svg"));
}

function exportSelectedSVGs() {
    const selectedIndexes = Array.from(document.querySelectorAll(".svg-export-checkbox:checked"))
        .map(input => parseInt(input.value, 10))
        .filter(index => !Number.isNaN(index));

    if (selectedIndexes.length === 0) {
        showToast("⚠️ Please select at least one diagram", 3000);
        return;
    }

    const baseName = (currentFile || "diagram").replace(/\.[^.]+$/, "") || "diagram";

    selectedIndexes.forEach((index, selectedOrder) => {
        const svg = svgExportCandidates[index];
        if (!svg) {
            return;
        }

        const svgString = new XMLSerializer().serializeToString(svg);
        const blob = new Blob([svgString], { type: "image/svg+xml" });
        const fileName = selectedIndexes.length === 1
            ? `${baseName}.svg`
            : `${baseName}-diagram-${selectedOrder + 1}.svg`;

        downloadFile(blob, fileName);
    });

    closeExportSvgModal();
}

async function exportAsPNG() {
    const diagramPreview = document.getElementById("diagramPreview");
    if (!diagramPreview) {
        showToast("⚠️ No diagram to export", 3000);
        return;
    }

    const svg = diagramPreview.querySelector("svg");

    if (!svg) {
        showToast("⚠️ No diagram to export", 3000);
        return;
    }

    const scale = parseFloat(document.getElementById("exportScale").value) || 3;
    const transparent = document.getElementById("transparentBg").checked;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const svgRect = svg.getBoundingClientRect();
    canvas.width = svgRect.width * scale;
    canvas.height = svgRect.height * scale;

    if (!transparent) {
        ctx.fillStyle = isDarkMode ? "#1e1e1e" : "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const svgString = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.onload = () => {
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);

        canvas.toBlob(blob => {
            downloadFile(blob, `${currentFile || "diagram"}.png`);
            closeExportModal();
        });
    };

    img.src = "data:image/svg+xml;base64," + btoa(svgString);
}

function downloadFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// History Management
async function showHistory() {
    if (!currentFile) {
        showToast("⚠️ No file selected", 3000);
        return;
    }

    try {
        const response = await fetch(`/history/${currentFile}`);
        const versions = await response.json();

        const historyList = document.getElementById("historyList");
        historyList.innerHTML = "";

        if (versions.length === 0) {
            historyList.innerHTML = "<p>No history available</p>";
        } else {
            versions.forEach(version => {
                const item = document.createElement("div");
                item.className = "history-item";
                const date = new Date(version.date);
                item.innerHTML = `
                    <span>${date.toLocaleString()}</span>
                    <button class="btn" onclick="restoreVersion('${version.timestamp}')">Restore</button>
                `;
                historyList.appendChild(item);
            });
        }

        document.getElementById("historyModal").classList.remove("hidden");
    } catch (error) {
        console.error("Error loading history:", error);
        showToast("❌ Failed to load history", 3000);
    }
}

async function restoreVersion(timestamp) {
    try {
        const response = await fetch(`/history/${currentFile}/${timestamp}`);
        const data = await response.json();

        editor.setValue(data.code);
        renderPreview();
        closeHistoryModal();
        showToast("✅ Version restored. Don't forget to save!", 3000);
    } catch (error) {
        console.error("Error restoring version:", error);
        showToast("❌ Failed to restore version", 3000);
    }
}

// Zoom Modal for Diagrams
function openDiagramZoom(svgElement) {
    const zoomModal = document.getElementById("zoomModal");
    const zoomDiagram = document.getElementById("zoomDiagram");

    // Clone the SVG for display
    const clonedSvg = svgElement.cloneNode(true);
    zoomDiagram.innerHTML = "";
    zoomDiagram.appendChild(clonedSvg);

    // Reset zoom level
    currentZoomLevel = 1;
    currentPanX = 0;
    currentPanY = 0;
    updateZoomDisplay();

    zoomModal.classList.remove("hidden");
    setupZoomModalScroll();
    setupZoomModalPan();

    // Auto-fit diagram after modal is visible
    requestAnimationFrame(() => {
        autoFitDiagram();
    });
}

function closeDiagramZoom() {
    document.getElementById("zoomModal").classList.add("hidden");
    currentZoomLevel = 1;
    currentPanX = 0;
    currentPanY = 0;
    isPanningDiagram = false;
    updateZoomDisplay();

    // Clean up scroll listener
    const zoomModalBody = document.querySelector(".zoom-modal-body");
    zoomModalBody.removeEventListener("wheel", handleZoomScroll);

    const zoomContainer = document.getElementById("zoomDiagramContainer");
    if (zoomContainer) {
        zoomContainer.removeEventListener("mousedown", handleZoomPanStart);
        zoomContainer.classList.remove("dragging");
    }

    document.removeEventListener("mousemove", handleZoomPanMove);
    document.removeEventListener("mouseup", handleZoomPanEnd);
}

function updateZoomDisplay() {
    const zoomDiagram = document.getElementById("zoomDiagram");
    const zoomLevelDisplay = document.getElementById("zoomLevel");

    zoomDiagram.style.transform = `translate(${currentPanX}px, ${currentPanY}px) scale(${currentZoomLevel})`;
    zoomLevelDisplay.textContent = `${Math.round(currentZoomLevel * 100)}%`;
}

function zoomDiagramIn() {
    currentZoomLevel = Math.min(5, currentZoomLevel + 0.1);
    updateZoomDisplay();
}

function zoomDiagramOut() {
    currentZoomLevel = Math.max(0.5, currentZoomLevel - 0.1);
    updateZoomDisplay();
}

function resetDiagramZoom() {
    currentZoomLevel = 1;
    currentPanX = 0;
    currentPanY = 0;
    updateZoomDisplay();
}

function autoFitDiagram() {
    const zoomContainer = document.getElementById("zoomDiagramContainer");
    const zoomDiagram = document.getElementById("zoomDiagram");
    const svg = zoomDiagram?.querySelector("svg");

    if (!zoomContainer || !svg) {
        return;
    }

    const containerWidth = zoomContainer.clientWidth;
    const containerHeight = zoomContainer.clientHeight;

    // Get the SVG's actual rendered dimensions using getBoundingClientRect
    const svgRect = svg.getBoundingClientRect();
    const svgWidth = svgRect.width;
    const svgHeight = svgRect.height;

    if (svgWidth <= 0 || svgHeight <= 0 || containerWidth <= 0 || containerHeight <= 0) {
        return;
    }

    const padding = 20;
    const availableWidth = containerWidth - padding * 2;
    const availableHeight = containerHeight - padding * 2;

    const scaleX = availableWidth / svgWidth;
    const scaleY = availableHeight / svgHeight;

    currentZoomLevel = Math.min(scaleX, scaleY);
    currentPanX = 0;
    currentPanY = 0;

    updateZoomDisplay();
}

function setupZoomModalScroll() {
    const zoomModalBody = document.querySelector(".zoom-modal-body");

    // Remove any existing scroll listeners (to avoid duplicates)
    zoomModalBody.removeEventListener("wheel", handleZoomScroll);

    // Add scroll listener
    zoomModalBody.addEventListener("wheel", handleZoomScroll, { passive: false });
}

function setupZoomModalPan() {
    const zoomContainer = document.getElementById("zoomDiagramContainer");
    if (!zoomContainer) {
        return;
    }

    zoomContainer.removeEventListener("mousedown", handleZoomPanStart);
    document.removeEventListener("mousemove", handleZoomPanMove);
    document.removeEventListener("mouseup", handleZoomPanEnd);

    zoomContainer.addEventListener("mousedown", handleZoomPanStart);
    document.addEventListener("mousemove", handleZoomPanMove);
    document.addEventListener("mouseup", handleZoomPanEnd);
}

function handleZoomPanStart(e) {
    if (e.button !== 0) {
        return;
    }

    const zoomDiagram = document.getElementById("zoomDiagram");
    if (!zoomDiagram || !zoomDiagram.contains(e.target)) {
        return;
    }

    isPanningDiagram = true;
    panStartClientX = e.clientX;
    panStartClientY = e.clientY;
    panStartX = currentPanX;
    panStartY = currentPanY;

    const zoomContainer = document.getElementById("zoomDiagramContainer");
    if (zoomContainer) {
        zoomContainer.classList.add("dragging");
    }

    e.preventDefault();
}

function handleZoomPanMove(e) {
    if (!isPanningDiagram) {
        return;
    }

    const deltaX = e.clientX - panStartClientX;
    const deltaY = e.clientY - panStartClientY;

    currentPanX = panStartX + deltaX;
    currentPanY = panStartY + deltaY;
    updateZoomDisplay();
}

function handleZoomPanEnd() {
    if (!isPanningDiagram) {
        return;
    }

    isPanningDiagram = false;
    const zoomContainer = document.getElementById("zoomDiagramContainer");
    if (zoomContainer) {
        zoomContainer.classList.remove("dragging");
    }
}

function handleZoomScroll(e) {
    e.preventDefault();

    // Scroll up = zoom in, scroll down = zoom out
    const scrollDelta = -e.deltaY;
    const zoomSpeed = 0.1;

    if (scrollDelta > 0) {
        // Zoom in
        currentZoomLevel = Math.min(5, currentZoomLevel + zoomSpeed);
    } else {
        // Zoom out
        currentZoomLevel = Math.max(0.5, currentZoomLevel - zoomSpeed);
    }

    updateZoomDisplay();
}

function setupDiagramClickZoom() {
    // Fallback: Global click handler for any SVG in diagram containers
    document.addEventListener("click", (e) => {
        // Check if clicked element is an SVG or inside an SVG
        let svg = null;
        if (e.target.tagName === "svg") {
            svg = e.target;
        } else if (e.target.closest("svg")) {
            svg = e.target.closest("svg");
        }

        // Check if SVG is in a diagram container
        if (svg && svg.closest(".diagram-preview, .mermaid-diagram")) {
            openDiagramZoom(svg);
        }
    });
}

// Search Files
function setupSearchFilter() {
    const searchInput = document.getElementById("searchInput");
    searchInput.addEventListener("input", (e) => {
        const query = e.target.value.toLowerCase();
        document.querySelectorAll(".file-item").forEach(item => {
            item.classList.toggle("hidden", !item.textContent.toLowerCase().includes(query));
        });
    });
}

// Modal Management
function closeHistoryModal() {
    document.getElementById("historyModal").classList.add("hidden");
}

function closeExportModal() {
    document.getElementById("exportModal").classList.add("hidden");
}

function closeExportSvgModal() {
    document.getElementById("exportSvgModal").classList.add("hidden");
}

function getPaneLayoutMetrics() {
    const mainContent = document.querySelector(".main-content");
    const sidebar = document.querySelector(".sidebar");
    const resizer = document.getElementById("editorResizer");

    if (!mainContent || !sidebar) {
        return null;
    }

    const sidebarWidth = sidebar.classList.contains("collapsed") ? 0 : sidebar.offsetWidth;
    const resizerWidth = resizer ? resizer.offsetWidth : 4;
    const availableWidth = mainContent.offsetWidth - sidebarWidth - resizerWidth;

    return {
        availableWidth,
        resizerWidth
    };
}

function fitPanesToAvailableWidth() {
    const editorContainer = document.querySelector(".editor-container");
    const previewContainer = document.querySelector(".preview-container");
    const metrics = getPaneLayoutMetrics();

    if (!editorContainer || !previewContainer || !metrics || metrics.availableWidth <= 0) {
        return;
    }

    const isCustomSized = editorContainer.style.flex.startsWith("0 0") || previewContainer.style.width;
    if (!isCustomSized) {
        return;
    }

    const minEditor = 200;
    const minPreview = 200;
    const currentEditor = editorContainer.offsetWidth;
    const currentPreview = previewContainer.offsetWidth;
    const currentTotal = currentEditor + currentPreview;

    if (currentTotal <= 0) {
        return;
    }

    let nextEditor = Math.round((currentEditor / currentTotal) * metrics.availableWidth);
    let nextPreview = metrics.availableWidth - nextEditor;

    if (nextEditor < minEditor) {
        nextEditor = minEditor;
        nextPreview = metrics.availableWidth - nextEditor;
    }

    if (nextPreview < minPreview) {
        nextPreview = minPreview;
        nextEditor = metrics.availableWidth - nextPreview;
    }

    if (nextEditor < minEditor || nextPreview < minPreview) {
        editorContainer.style.flex = "1";
        previewContainer.style.width = "350px";
    } else {
        editorContainer.style.flex = `0 0 ${nextEditor}px`;
        previewContainer.style.width = `${nextPreview}px`;
    }

    if (editor) {
        editor.layout();
    }
}

// Sidebar Toggle
function toggleSidebar() {
    const sidebar = document.querySelector(".sidebar");
    sidebar.classList.toggle("collapsed");

    // Save preference
    const isCollapsed = sidebar.classList.contains("collapsed");
    localStorage.setItem("sidebarCollapsed", isCollapsed ? "true" : "false");

    // Refit panes immediately and after transition to avoid right-side gaps.
    fitPanesToAvailableWidth();
    setTimeout(fitPanesToAvailableWidth, 320);
}

function restoreSidebarState() {
    const isCollapsed = localStorage.getItem("sidebarCollapsed") === "true";
    if (isCollapsed) {
        document.querySelector(".sidebar").classList.add("collapsed");
    }
}

// Resize handler
function setupResize() {
    const resizer = document.getElementById("editorResizer");
    const editorContainer = document.querySelector(".editor-container");
    const previewContainer = document.querySelector(".preview-container");
    const mainContent = document.querySelector(".main-content");

    let isResizing = false;
    let startX = 0;
    let startEditorWidth = 0;
    let startPreviewWidth = 0;

    resizer.addEventListener("mousedown", (e) => {
        isResizing = true;
        startX = e.clientX;
        startEditorWidth = editorContainer.offsetWidth;
        startPreviewWidth = previewContainer.offsetWidth;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", (e) => {
        if (!isResizing) return;

        const diff = e.clientX - startX;
        const newEditorWidth = Math.max(200, startEditorWidth + diff);
        const newPreviewWidth = Math.max(200, startPreviewWidth - diff);

        editorContainer.style.flex = `0 0 ${newEditorWidth}px`;
        previewContainer.style.width = `${newPreviewWidth}px`;

        // Trigger editor layout update
        if (editor) {
            editor.layout();
        }
    });

    document.addEventListener("mouseup", () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = "auto";
            document.body.style.userSelect = "auto";

            // Save resize preference to localStorage
            const metrics = getPaneLayoutMetrics();
            const availableWidth = metrics ? metrics.availableWidth : mainContent.offsetWidth;
            const editorWidth = editorContainer.offsetWidth;
            localStorage.setItem("editorWidthPercent", (editorWidth / availableWidth) * 100);
        }
    });
}

// Restore resize preference
function restoreResizePreference() {
    const editorContainer = document.querySelector(".editor-container");
    const previewContainer = document.querySelector(".preview-container");
    const mainContent = document.querySelector(".main-content");
    const editorWidthPercent = localStorage.getItem("editorWidthPercent");

    if (editorWidthPercent) {
        const metrics = getPaneLayoutMetrics();
        const availableWidth = metrics ? metrics.availableWidth : mainContent.offsetWidth;
        const editorWidth = (parseFloat(editorWidthPercent) / 100) * availableWidth;
        const previewWidth = availableWidth - editorWidth;

        editorContainer.style.flex = `0 0 ${editorWidth}px`;
        previewContainer.style.width = `${previewWidth}px`;

        fitPanesToAvailableWidth();
    }
}

// Event Listeners
function setupEventListeners() {
    document.getElementById("toggleSidebarBtn").addEventListener("click", toggleSidebar);
    document.getElementById("themeToggle").addEventListener("click", toggleTheme);
    document.getElementById("mermaidThemeSelect").addEventListener("change", (e) => {
        if (e.target.value) {
            changeMermaidTheme(e.target.value);
        }
    });
    document.getElementById("saveBtn").addEventListener("click", saveFile);
    document.getElementById("newFileBtn").addEventListener("click", createNewFile);
    document.getElementById("newFolderBtn").addEventListener("click", createNewFolder);
    document.getElementById("renameFileBtn").addEventListener("click", renameCurrentFile);
    document.getElementById("deleteBtn").addEventListener("click", deleteItem);
    document.getElementById("historyBtn").addEventListener("click", showHistory);
    document.getElementById("closeHistoryBtn").addEventListener("click", closeHistoryModal);

    document.getElementById("exportSvgBtn").addEventListener("click", exportAsSVG);
    document.getElementById("exportPngBtn").addEventListener("click", () => {
        document.getElementById("exportModal").classList.remove("hidden");
    });
    document.getElementById("confirmExportSvgBtn").addEventListener("click", exportSelectedSVGs);
    document.getElementById("confirmExportBtn").addEventListener("click", exportAsPNG);
    document.getElementById("closeExportBtn").addEventListener("click", closeExportModal);
    document.getElementById("closeExportSvgBtn").addEventListener("click", closeExportSvgModal);

    document.getElementById("selectAllSvgDiagrams").addEventListener("change", (e) => {
        const checked = e.target.checked;
        document.querySelectorAll(".svg-export-checkbox").forEach(input => {
            input.checked = checked;
        });
    });

    document.getElementById("zoomInBtn").addEventListener("click", zoomDiagramIn);
    document.getElementById("zoomOutBtn").addEventListener("click", zoomDiagramOut);
    document.getElementById("zoomResetZoomBtn").addEventListener("click", resetDiagramZoom);
    document.getElementById("closeZoomBtn").addEventListener("click", closeDiagramZoom);

    setupSearchFilter();
    setupFileDropUpload();
    setupDiagramClickZoom();
    setupResize();
    restoreResizePreference();

    // Close modals on background click
    document.getElementById("historyModal").addEventListener("click", (e) => {
        if (e.target.id === "historyModal") closeHistoryModal();
    });
    document.getElementById("exportModal").addEventListener("click", (e) => {
        if (e.target.id === "exportModal") closeExportModal();
    });
    document.getElementById("exportSvgModal").addEventListener("click", (e) => {
        if (e.target.id === "exportSvgModal") closeExportSvgModal();
    });
    document.getElementById("zoomModal").addEventListener("click", (e) => {
        if (e.target.id === "zoomModal") closeDiagramZoom();
    });

    // Add unsaved changes warning
    window.addEventListener("beforeunload", (e) => {
        if (currentFile && editor && editor.getValue() !== lastSavedContent) {
            e.preventDefault();
            e.returnValue = "You have unsaved changes. Are you sure you want to leave?";
            return "You have unsaved changes. Are you sure you want to leave?";
        }
    });
}

// Initialize marked options when it's available
async function initializeMarked() {
    try {
        const markedReady = await ensureMarkedLoaded();
        const markedApi = getMarkedApi();
        if (markedReady && markedApi) {
            markedApi.setOptions({
                breaks: true,
                gfm: true
            });
            console.log("✓ marked.js initialized");
        }
    } catch (error) {
        console.warn("⚠ Failed to initialize marked:", error);
    }
}

// Call initialization after DOM is ready
initializeMarked();
