/**
 * LaunchPad Frontend Application
 * Handles UI logic and IPC communication
 */

// Access the LaunchPad API exposed by preload script
const api = window.launchpad;

// Application state
let inputs = [];
let settings = {};
let isGenerating = false;

/**
 * Initialize application
 */
async function initializeApp() {
    console.log('Initializing LaunchPad...');

    try {
        // Load settings
        settings = await api.getSettings();
        console.log('Settings loaded:', settings);

        // Set up progress listener
        api.onProgress((progress) => {
            handleProgressUpdate(progress);
        });

        // Initialize UI
        updateProviderSettings();
        updateInputList();
        updateGenerateButton();

        console.log('LaunchPad initialized successfully');
    } catch (error) {
        console.error('Failed to initialize:', error);
        showError('Failed to initialize application');
    }
}

/**
 * Theme Management
 */
function toggleTheme() {
    const body = document.body;
    const currentTheme = body.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    body.setAttribute('data-theme', newTheme);

    const themeToggle = document.querySelector('.theme-toggle');
    themeToggle.textContent = newTheme === 'dark' ? '☀️' : '🌙';

    localStorage.setItem('theme', newTheme);
}

// Load saved theme
function loadTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.body.setAttribute('data-theme', savedTheme);
    const themeToggle = document.querySelector('.theme-toggle');
    if (themeToggle) {
        themeToggle.textContent = savedTheme === 'dark' ? '☀️' : '🌙';
    }
}

/**
 * Input Management
 */
async function addTextSubject() {
    document.getElementById('textSubjectModal').style.display = 'flex';
    document.getElementById('textSubjectInput').value = '';
    document.getElementById('textSubjectInput').focus();
}

function closeTextSubjectModal() {
    document.getElementById('textSubjectModal').style.display = 'none';
}

function addTextSubjectConfirm() {
    const textarea = document.getElementById('textSubjectInput');
    const content = textarea.value.trim();

    if (!content) {
        alert('Please enter at least one subject');
        return;
    }

    // Split by newlines and filter out empty lines
    const subjects = content.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

    if (subjects.length === 0) {
        alert('Please enter at least one subject');
        return;
    }

    // Add each subject as a separate input
    subjects.forEach(subject => {
        inputs.push({
            type: 'subject',
            path: subject,
            displayName: subject.length > 50 ? subject.substring(0, 47) + '...' : subject,
            icon: '📝'
        });
    });

    updateInputList();
    updateGenerateButton();
    closeTextSubjectModal();
}

async function browseFiles() {
    try {
        const result = await api.selectFiles();
        if (result.success && result.files.length > 0) {
            // Check each path to determine if it's a file or directory
            const pathChecks = await Promise.all(
                result.files.map(async (filePath) => {
                    const isDir = await api.isDirectory(filePath);
                    return { path: filePath, isDirectory: isDir };
                })
            );

            pathChecks.forEach(({ path: filePath, isDirectory }) => {
                if (isDirectory) {
                    // Handle directory
                    const dirName = filePath.split('/').pop();
                    inputs.push({
                        type: 'directory',
                        path: filePath,
                        displayName: dirName,
                        icon: '📂'
                    });
                } else {
                    // Handle file
                    const fileName = filePath.split('/').pop();
                    const ext = fileName.split('.').pop().toLowerCase();

                    let icon = '📄';
                    let type = 'file';

                    if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(ext)) {
                        icon = '🎥';
                        type = 'video';
                    } else if (ext === 'txt') {
                        icon = '📝';
                        type = 'transcript';
                    }

                    inputs.push({
                        type: type,
                        path: filePath,
                        displayName: fileName,
                        icon: icon
                    });
                }
            });

            updateInputList();
            updateGenerateButton();
        }
    } catch (error) {
        console.error('Error selecting files/directories:', error);
        showError('Failed to select files or directories');
    }
}

function removeInput(index) {
    inputs.splice(index, 1);
    updateInputList();
    updateGenerateButton();
}

function updateInputList() {
    const inputList = document.getElementById('inputList');
    const inputCount = document.getElementById('inputCount');

    if (inputs.length === 0) {
        inputList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📭</div>
                <p>No inputs added yet</p>
                <p class="empty-hint">Add text subjects, video files, or transcript files to generate metadata</p>
            </div>
        `;
    } else {
        inputList.innerHTML = inputs.map((input, index) => `
            <div class="input-item animate-in">
                <div class="input-item-icon">${input.icon}</div>
                <div class="input-item-content">
                    <div class="input-item-title" title="${input.path}">${input.displayName}</div>
                    <div class="input-item-subtitle">${input.type}</div>
                </div>
                <button class="input-item-remove" onclick="removeInput(${index})" title="Remove">×</button>
            </div>
        `).join('');
    }

    inputCount.textContent = `${inputs.length} item${inputs.length !== 1 ? 's' : ''}`;
}

function updateGenerateButton() {
    const generateBtn = document.getElementById('generateBtn');
    generateBtn.disabled = inputs.length === 0 || isGenerating;
}

/**
 * Metadata Generation
 */
async function generateMetadata() {
    if (isGenerating || inputs.length === 0) return;

    isGenerating = true;
    updateGenerateButton();

    const platform = document.getElementById('platformSelect').value;
    const mode = document.getElementById('modeSelect').value;

    // Show progress section
    const progressSection = document.getElementById('progressSection');
    const outputDisplay = document.getElementById('outputDisplay');
    progressSection.style.display = 'block';
    outputDisplay.innerHTML = '';

    updateProgress('Initializing...', 10);

    try {
        // Prepare input paths
        const inputPaths = inputs.map(input => input.path);

        // Call IPC to generate metadata
        const result = await api.generateMetadata({
            inputs: inputPaths,
            platform: platform,
            mode: mode
        });

        if (result.success) {
            updateProgress('Complete!', 100);
            displayMetadata(result.metadata, platform);
            showStatusBadge('success', 'Generated Successfully');

            // Hide progress after 1 second
            setTimeout(() => {
                progressSection.style.display = 'none';
            }, 1000);
        } else {
            throw new Error(result.error || 'Unknown error occurred');
        }

    } catch (error) {
        console.error('Error generating metadata:', error);
        showError('Failed to generate metadata: ' + error.message);
        progressSection.style.display = 'none';
        showStatusBadge('error', 'Generation Failed');
    } finally {
        isGenerating = false;
        updateGenerateButton();
    }
}

function handleProgressUpdate(progress) {
    console.log('Progress update:', progress);

    if (progress.phase === 'starting') {
        updateProgress(progress.message, 20);
    } else if (progress.phase === 'processing') {
        updateProgress(progress.message, 50);
    } else if (progress.phase === 'complete') {
        updateProgress(progress.message, 100);
    } else if (progress.phase === 'error') {
        showError(progress.message);
    }
}

function updateProgress(message, percentage) {
    const progressMessage = document.getElementById('progressMessage');
    const progressBar = document.getElementById('progressBar');

    progressMessage.textContent = message;
    progressBar.style.width = percentage + '%';
}

function displayMetadata(metadata, platform) {
    const outputDisplay = document.getElementById('outputDisplay');

    if (!metadata || metadata.length === 0) {
        outputDisplay.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">⚠️</div>
                <p>No metadata generated</p>
            </div>
        `;
        return;
    }

    // Handle array of metadata (compilation mode produces array with single item)
    const metadataArray = Array.isArray(metadata) ? metadata : [metadata];

    let html = '';

    metadataArray.forEach((meta, index) => {
        // Titles Section
        if (meta.titles && meta.titles.length > 0) {
            html += `
                <div class="metadata-section animate-in">
                    <h4 class="metadata-section-title">📝 Titles</h4>
                    <div class="metadata-items">
                        ${meta.titles.map((title, i) => `
                            <div class="metadata-item" onclick="copyToClipboard('${escapeHtml(title)}', 'Title ${i + 1}')">
                                <div class="metadata-item-badge badge badge-info">${i + 1}</div>
                                <div class="metadata-item-content">${escapeHtml(title)}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        // Thumbnail Text Section
        if (meta.thumbnail_text && meta.thumbnail_text.length > 0) {
            html += `
                <div class="metadata-section animate-in">
                    <h4 class="metadata-section-title">🖼️ Thumbnail Text</h4>
                    <div class="metadata-items">
                        ${meta.thumbnail_text.map((text, i) => `
                            <div class="metadata-item" onclick="copyToClipboard('${escapeHtml(text)}', 'Thumbnail ${i + 1}')">
                                <div class="metadata-item-badge badge badge-warning">${i + 1}</div>
                                <div class="metadata-item-content" style="font-weight: bold; font-size: 1.1rem;">${escapeHtml(text)}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        // Description Section
        if (meta.description) {
            html += `
                <div class="metadata-section animate-in">
                    <h4 class="metadata-section-title">📄 Description</h4>
                    <div class="metadata-item" onclick="copyToClipboard('${escapeHtml(meta.description)}', 'Description')">
                        <div class="metadata-item-content" style="white-space: pre-wrap;">${escapeHtml(meta.description)}</div>
                    </div>
                </div>
            `;
        }

        // Hashtags Section
        if (meta.hashtags) {
            html += `
                <div class="metadata-section animate-in">
                    <h4 class="metadata-section-title">#️⃣ Hashtags</h4>
                    <div class="metadata-item" onclick="copyToClipboard('${escapeHtml(meta.hashtags)}', 'Hashtags')">
                        <div class="metadata-item-content">${escapeHtml(meta.hashtags)}</div>
                    </div>
                </div>
            `;
        }

        // Tags Section
        if (meta.tags) {
            html += `
                <div class="metadata-section animate-in">
                    <h4 class="metadata-section-title">🏷️ Tags</h4>
                    <div class="metadata-item" onclick="copyToClipboard('${escapeHtml(meta.tags)}', 'Tags')">
                        <div class="metadata-item-content">${escapeHtml(meta.tags)}</div>
                    </div>
                </div>
            `;
        }
    });

    outputDisplay.innerHTML = html;
}

/**
 * Settings Management
 */
function openSettings() {
    // Load current settings into form
    document.getElementById('aiProviderSelect').value = settings.aiProvider || 'ollama';
    document.getElementById('ollamaModel').value = settings.ollamaModel || 'cogito:70b';
    document.getElementById('ollamaHost').value = settings.ollamaHost || 'http://localhost:11434';
    document.getElementById('openaiApiKey').value = settings.openaiApiKey || '';
    document.getElementById('claudeApiKey').value = settings.claudeApiKey || '';
    document.getElementById('outputDirectory').value = settings.outputDirectory || '';

    updateProviderSettings();

    document.getElementById('settingsModal').style.display = 'flex';
}

function closeSettings() {
    document.getElementById('settingsModal').style.display = 'none';
}

function updateProviderSettings() {
    const provider = document.getElementById('aiProviderSelect').value;

    // Hide all provider settings
    document.getElementById('ollamaSettings').style.display = 'none';
    document.getElementById('openaiSettings').style.display = 'none';
    document.getElementById('claudeSettings').style.display = 'none';

    // Show selected provider settings
    if (provider === 'ollama') {
        document.getElementById('ollamaSettings').style.display = 'block';
    } else if (provider === 'openai') {
        document.getElementById('openaiSettings').style.display = 'block';
    } else if (provider === 'claude') {
        document.getElementById('claudeSettings').style.display = 'block';
    }
}

async function selectOutputDirectory() {
    try {
        const result = await api.selectOutputDirectory();
        if (result.success && result.directory) {
            document.getElementById('outputDirectory').value = result.directory;
        }
    } catch (error) {
        console.error('Error selecting output directory:', error);
        showError('Failed to select output directory');
    }
}

async function saveSettings() {
    try {
        const newSettings = {
            aiProvider: document.getElementById('aiProviderSelect').value,
            ollamaModel: document.getElementById('ollamaModel').value,
            ollamaHost: document.getElementById('ollamaHost').value,
            openaiApiKey: document.getElementById('openaiApiKey').value,
            claudeApiKey: document.getElementById('claudeApiKey').value,
            outputDirectory: document.getElementById('outputDirectory').value
        };

        await api.updateSettings(newSettings);
        settings = { ...settings, ...newSettings };

        closeSettings();
        showSuccess('Settings saved successfully');
    } catch (error) {
        console.error('Error saving settings:', error);
        showError('Failed to save settings');
    }
}

/**
 * Utility Functions
 */
function copyToClipboard(text, label) {
    const decodedText = decodeHtmlEntities(text);

    // Use navigator.clipboard if available
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(decodedText).then(() => {
            showSuccess(`${label} copied to clipboard`);
        }).catch(err => {
            console.error('Failed to copy:', err);
            showError('Failed to copy to clipboard');
        });
    } else {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = decodedText;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            showSuccess(`${label} copied to clipboard`);
        } catch (err) {
            console.error('Failed to copy:', err);
            showError('Failed to copy to clipboard');
        }
        document.body.removeChild(textarea);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function decodeHtmlEntities(text) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value;
}

function showSuccess(message) {
    showStatusBadge('success', message);
    setTimeout(() => {
        clearStatusBadge();
    }, 3000);
}

function showError(message) {
    showStatusBadge('error', message);
}

function showStatusBadge(type, message) {
    const statusBadge = document.getElementById('statusBadge');
    statusBadge.className = type === 'success' ? 'badge badge-success' :
                           type === 'error' ? 'badge badge-danger' :
                           'badge badge-info';
    statusBadge.textContent = message;
}

function clearStatusBadge() {
    const statusBadge = document.getElementById('statusBadge');
    statusBadge.className = '';
    statusBadge.textContent = '';
}

/**
 * Event Listeners
 */
document.addEventListener('DOMContentLoaded', () => {
    loadTheme();
    initializeApp();

    // Close modals on overlay click
    document.getElementById('settingsModal').addEventListener('click', (e) => {
        if (e.target.id === 'settingsModal') {
            closeSettings();
        }
    });

    document.getElementById('textSubjectModal').addEventListener('click', (e) => {
        if (e.target.id === 'textSubjectModal') {
            closeTextSubjectModal();
        }
    });

    // Enter key in text subject modal
    document.getElementById('textSubjectInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
            addTextSubjectConfirm();
        }
    });
});
