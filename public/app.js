// State
let currentData = { uploads: [], examples: [] };
let isCloudEnabled = false;

// Storage Destination selector setup
const storageGroup = document.getElementById('storage-destination-group');
const localLabel = document.getElementById('local-storage-label');
const cloudLabel = document.getElementById('cloud-storage-label');
const storageRadios = document.querySelectorAll('input[name="storage-dest"]');

storageRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        localLabel.classList.toggle('active', radio.value === 'local');
        cloudLabel.classList.toggle('active', radio.value === 'cloud');
    });
});

async function checkConfig() {
    try {
        const res = await fetch('/api/config');
        const config = await res.json();
        isCloudEnabled = config.isCloudEnabled;
        if (isCloudEnabled && storageGroup) {
            storageGroup.style.display = 'flex';
        }
    } catch (e) {
        console.error('Failed to fetch config', e);
    }
}
checkConfig();

// Navigation
const navLinks = document.querySelectorAll('.nav-links li');
const contentSections = document.querySelectorAll('main > section');

navLinks.forEach(link => {
    link.addEventListener('click', () => switchSection(link.dataset.section));
});

function switchSection(target) {
    navLinks.forEach(l => l.classList.remove('active'));
    const activeLink = document.querySelector(`[data-section="${target}"]`);
    if (activeLink) activeLink.classList.add('active');
    contentSections.forEach(s => s.classList.add('hidden'));
    const sec = document.getElementById(`${target}-section`);
    if (sec) sec.classList.remove('hidden');
}

// Modal
const uploadModal = document.getElementById('upload-modal');
const deleteModal = document.getElementById('delete-modal');
const newUploadBtn = document.getElementById('new-upload-btn');
const closeBtnEl = document.getElementById('modal-close-btn');
const deleteCloseBtn = document.getElementById('delete-close-btn');

if (newUploadBtn) newUploadBtn.onclick = () => openModal();
if (closeBtnEl) closeBtnEl.onclick = () => closeModal();
if (deleteCloseBtn) deleteCloseBtn.onclick = () => closeDeleteModal();
window.onclick = (e) => {
    if (e.target === uploadModal) closeModal();
    if (e.target === deleteModal) closeDeleteModal();
};

function openModal() {
    uploadModal.classList.remove('hidden');
    // Reset inputs
    const nameInput = document.getElementById('project-name-input');
    if (nameInput) nameInput.value = '';
    // Reset progress state
    document.getElementById('upload-progress').classList.add('hidden');
    const dz = document.getElementById('las-drop-zone');
    if (dz) dz.classList.remove('hidden');
    const selFile = document.getElementById('selected-file-name');
    if (selFile) { selFile.classList.add('hidden'); selFile.textContent = ''; }
    const bar = document.getElementById('main-progress-bar');
    if (bar) bar.style.width = '0%';
}

function closeModal() {
    uploadModal.classList.add('hidden');
}

// Drag-and-drop on drop zone
const lasDropZone = document.getElementById('las-drop-zone');
const lasInput = document.getElementById('las-input');
const lasBrowseBtn = document.getElementById('las-browse-btn');

if (lasBrowseBtn) lasBrowseBtn.onclick = (e) => { e.stopPropagation(); lasInput.click(); };
if (lasDropZone) {
    lasDropZone.addEventListener('click', () => lasInput.click());
    lasDropZone.addEventListener('dragover', (e) => { e.preventDefault(); lasDropZone.classList.add('drag-over'); });
    lasDropZone.addEventListener('dragleave', () => lasDropZone.classList.remove('drag-over'));
    lasDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        lasDropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) startUpload(e.dataTransfer.files);
    });
}
if (lasInput) lasInput.onchange = (e) => { if (e.target.files.length) startUpload(e.target.files); };

async function startUpload(files) {
    const firstFile = files[0];
    const ext = firstFile.name.split('.').pop().toLowerCase();
    if (!['las', 'laz'].includes(ext)) {
        alert('Please select .las or .laz files to create a new project.');
        return;
    }

    // Show file name info
    const selFile = document.getElementById('selected-file-name');
    if (selFile) {
        selFile.textContent = files.length > 1
            ? `📄 ${firstFile.name} (+${files.length - 1} more)`
            : `📄 ${firstFile.name}`;
        selFile.classList.remove('hidden');
    }

    const progressSection = document.getElementById('upload-progress');
    const bar = document.getElementById('main-progress-bar');
    const statusText = document.getElementById('progress-status');
    const pctText = document.getElementById('progress-pct');

    progressSection.classList.remove('hidden');
    bar.style.width = '0%';
    statusText.style.color = 'var(--accent)';

    const storageMode = document.querySelector('input[name="storage-dest"]:checked')?.value || 'local';

    if (storageMode === 'cloud') {
        uploadToAzureDirect(files, bar, statusText, pctText);
    } else {
        uploadToLocal(files, bar, statusText, pctText);
    }
}

async function uploadToLocal(files, bar, statusText, pctText) {
    statusText.textContent = 'Uploading point cloud to server...';
    pctText.textContent = '5%';
    bar.style.width = '5%';

    const formData = new FormData();
    for (let file of files) {
        formData.append('file', file);
    }

    // Add custom project name if provided
    const projectName = document.getElementById('project-name-input').value.trim();
    if (projectName) {
        formData.append('projectName', projectName);
    }

    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        if (!res.ok) throw new Error(await res.text());
        const result = await res.json();

        statusText.textContent = 'Converting on server — please wait...';
        bar.style.width = '20%';
        pctText.textContent = '20%';

        pollConversion(result.jobId, null, bar, statusText, pctText);
    } catch (err) {
        statusText.textContent = 'Error: ' + err.message;
        statusText.style.color = 'var(--danger)';
    }
}

async function uploadToAzureDirect(files, bar, statusText, pctText) {
    const file = files[0];

    try {
        statusText.textContent = 'Requesting cloud access...';
        const sasRes = await fetch(`/api/upload-sas?fileName=${encodeURIComponent(file.name)}`);
        if (!sasRes.ok) throw new Error(await sasRes.text());
        const { uploadUrl, blobName } = await sasRes.json();

        statusText.textContent = 'Transferring directly to Azure Blob Storage...';

        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl, true);
        xhr.setRequestHeader('x-ms-blob-type', 'BlockBlob');

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                bar.style.width = pct + '%';
                pctText.textContent = pct + '%';
            }
        };

        xhr.onload = async () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                statusText.textContent = 'Cloud transfer complete. Processing...';

                const projectName = document.getElementById('project-name-input').value.trim();
                const triggerRes = await fetch('/api/trigger-conversion-cloud', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ blobName, projectName })
                });
                if (!triggerRes.ok) throw new Error(await triggerRes.text());
                const { jobId } = await triggerRes.json();

                pollConversion(jobId, null, bar, statusText, pctText);
            } else {
                statusText.textContent = 'Cloud upload failed: ' + xhr.statusText;
                statusText.style.color = 'var(--danger)';
            }
        };

        xhr.onerror = () => {
            statusText.textContent = 'Network error during cloud transfer';
            statusText.style.color = 'var(--danger)';
        };
        xhr.send(file);

    } catch (err) {
        statusText.textContent = 'Error: ' + err.message;
        statusText.style.color = 'var(--danger)';
    }
}

function pollConversion(jobId, projectId, bar, statusText, pctText) {
    let pct = 20;
    const poll = setInterval(async () => {
        try {
            const res = await fetch(`/api/status/${jobId}`);
            const job = await res.json();

            if (job.status === 'completed') {
                clearInterval(poll);
                bar.style.width = '100%';
                pctText.textContent = '100%';
                statusText.textContent = '✓ Project created successfully!';
                setTimeout(() => {
                    closeModal();
                    fetchData(); // refresh dashboard
                }, 1500);
            } else if (job.status === 'failed') {
                clearInterval(poll);
                statusText.textContent = 'Conversion failed: ' + job.error;
                statusText.style.color = 'var(--danger)';
            } else {
                pct = Math.min(pct + 4, 90);
                bar.style.width = pct + '%';
                pctText.textContent = pct + '%';
                statusText.textContent = 'Processing point cloud data...';
            }
        } catch (e) { console.error(e); }
    }, 2500);
}

// ---- Data Fetching -----------------------------------------------------------
async function fetchData() {
    try {
        const res = await fetch('/api/list');
        const data = await res.json();
        currentData = data;
        renderDashboard();
        setupDeleteButtons();
    } catch (err) {
        console.error('Failed to fetch data', err);
    }
}

// ---- Deletion logic ---------------------------------------------------------
let projectToDelete = null;

function setupDeleteButtons() {
    document.querySelectorAll('.delete-project-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = btn.dataset.id;
            const name = btn.dataset.name;
            openDeleteModal(id, name);
        });
    });
}

function openDeleteModal(id, readableName) {
    projectToDelete = { id, readableName };
    document.getElementById('delete-target-name').textContent = readableName;
    document.getElementById('delete-confirm-input').value = '';
    document.getElementById('confirm-delete-btn').disabled = true;
    deleteModal.classList.remove('hidden');

    // Setup verification
    const input = document.getElementById('delete-confirm-input');
    input.oninput = () => {
        const btn = document.getElementById('confirm-delete-btn');
        btn.disabled = input.value.trim().toLowerCase() !== readableName.toLowerCase();
    };
}

function closeDeleteModal() {
    deleteModal.classList.add('hidden');
    projectToDelete = null;
}

document.getElementById('confirm-delete-btn').onclick = async () => {
    if (!projectToDelete) return;

    const btn = document.getElementById('confirm-delete-btn');
    btn.disabled = true;
    btn.textContent = 'Deleting...';

    try {
        const res = await fetch(`/api/delete/${projectToDelete.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(await res.text());

        btn.textContent = 'Deleted!';
        setTimeout(() => {
            closeDeleteModal();
            fetchData();
            btn.textContent = 'Permanently Delete Project';
        }, 1000);
    } catch (err) {
        alert('Failed to delete: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Permanently Delete Project';
    }
};

function renderDashboard() {
    const totalEl = document.getElementById('total-projects-count');
    const examplesEl = document.getElementById('examples-count');
    const cloudCountEl = document.getElementById('cloud-projects-count');
    const cloudBadgeEl = document.getElementById('cloud-badge');
    const sidebarCount = document.getElementById('sidebar-project-count');

    const cloudProjects = currentData.uploads.filter(u => u.storageMode === 'cloud');

    if (totalEl) totalEl.textContent = currentData.uploads.length;
    if (examplesEl) examplesEl.textContent = currentData.examples.length;
    if (sidebarCount) sidebarCount.textContent = `Projects: ${currentData.uploads.length}`;

    // Cloud stat card
    if (cloudCountEl) {
        const count = currentData.cloudProjectsCount;
        cloudCountEl.textContent = (count !== undefined) ? count : '—';
        if (cloudBadgeEl) cloudBadgeEl.style.display = (count > 0) ? 'block' : 'none';
    }

    // Recent projects (dashboard — all types, up to 6)
    const recentGrid = document.getElementById('recent-uploads-grid');
    const noProjectsMsg = document.getElementById('no-projects-msg');
    if (recentGrid) {
        const items = currentData.uploads.slice(0, 6).map(u => renderProjectCard(u)).join('');
        if (currentData.uploads.length === 0) {
            recentGrid.innerHTML = '';
            if (noProjectsMsg) noProjectsMsg.classList.remove('hidden');
        } else {
            if (noProjectsMsg) noProjectsMsg.classList.add('hidden');
            recentGrid.innerHTML = items;
        }
    }

    // ── Cloud Projects section ────────────────────────────────────────────
    const cloudGrid = document.getElementById('cloud-uploads-grid');
    const cloudLoadingMsg = document.getElementById('cloud-loading-msg');
    const cloudHint = document.getElementById('cloud-section-hint');
    if (cloudGrid) {
        if (cloudLoadingMsg) cloudLoadingMsg.style.display = 'none';
        if (cloudProjects.length === 0) {
            cloudGrid.innerHTML = `<div class="empty-state">
                <p>No cloud projects found in Azure Blob Storage.</p>
                <p style="font-size:0.7rem;margin-top:8px;color:var(--text-dim)">Upload a point cloud and choose "Azure Cloud" as the storage destination.</p>
            </div>`;
            if (cloudHint) cloudHint.textContent = 'No projects in Azure Blob Storage';
        } else {
            cloudGrid.innerHTML = cloudProjects.map(u => renderProjectCard(u)).join('');
            if (cloudHint) cloudHint.textContent =
                `${cloudProjects.length} project${cloudProjects.length === 1 ? '' : 's'} discovered in Azure Blob Storage`;
        }
    }

    // All projects
    const allGrid = document.getElementById('all-uploads-grid');
    if (allGrid) {
        allGrid.innerHTML = currentData.uploads.map(u => renderProjectCard(u)).join('');
    }

    // Examples
    const examplesGrid = document.getElementById('examples-grid');
    if (examplesGrid) {
        examplesGrid.innerHTML = currentData.examples.map(e => renderExampleCard(e)).join('');
    }
}

function renderProjectCard(item) {
    const readableName = item.name.replace(/_[a-f0-9]{8}$/, '').replace(/_/g, ' ');
    const viewerUrl = `viewer.html?load=${encodeURIComponent(item.url)}&projectId=${encodeURIComponent(item.name)}`;
    const isCloud = item.storageMode === 'cloud';

    const icon = item.type === 'pointcloud'
        ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2a10 10 0 0 0-9.95 9h2.01A8 8 0 0 1 12 4V2zm0 20a10 10 0 0 0 9.95-9h-2.01A8 8 0 0 1 12 20v2z"/></svg>`
        : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`;

    const typeLabel = isCloud ? '&#9729; Azure Cloud' : (item.type === 'pointcloud' ? 'Point Cloud' : 'GIS Layer');
    const typeClass = isCloud ? 'type-cloud' : (item.type === 'pointcloud' ? 'type-pc' : 'type-shp');
    const wrapperClass = isCloud ? 'item-card-wrapper cloud-card-wrapper' : 'item-card-wrapper';
    const cardClass = isCloud ? 'item-card item-card-cloud' : 'item-card';
    const thumbExtra = isCloud ? ' cloud-thumb' : '';
    const cloudBadge = isCloud ? '<div class="cloud-orbit-badge">&#9729;</div>' : '';
    const subtitle = isCloud
        ? 'Azure Blob Storage &mdash; click to open 3D viewer'
        : 'Local server &mdash; click to open 3D viewer';

    return `
        <div class="${wrapperClass}" style="position:relative">
            <a href="${viewerUrl}" class="${cardClass}">
                <div class="item-thumb type-thumb-${item.type}${thumbExtra}">
                    ${cloudBadge}
                    ${icon}
                </div>
                <div class="item-info">
                    <h4 title="${item.name}">${readableName}</h4>
                    <p>${subtitle}</p>
                    <span class="item-type ${typeClass}">${typeLabel}</span>
                </div>
            </a>
            <button class="delete-project-btn" data-id="${item.name}" data-name="${readableName}" title="Delete project">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        </div>`;
}

function renderExampleCard(item) {
    // Ensure examples natively map to Potree's gulp dev watcher
    const host = window.location.hostname;
    const exampleDevUrl = `http://${host}:1234${item.url}`;

    return `
        <a href="${exampleDevUrl}" class="item-card" target="_blank">
            <div class="item-thumb type-thumb-example">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
            </div>
            <div class="item-info">
                <h4>${item.name.replace('.html', '')}</h4>
                <p>Standard example dataset</p>
                <span class="item-type type-ex">Example</span>
            </div>
        </a>`;
}

// Init
fetchData();
setInterval(fetchData, 60000);
