// Populate the popup with checkboxes for all currently open tabs
async function loadCurrentTabs() {
  const tabList = document.getElementById('tabList');
  tabList.innerHTML = '';
  
  // Get all tabs across ALL open windows (or set currentWindow: true for current window only)
  const tabs = await chrome.tabs.query({ currentWindow: true });

  tabs.forEach(tab => {
    const div = document.createElement('div');
    div.className = 'tab-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = tab.url;
    checkbox.checked = true; // Checked by default
    checkbox.className = 'tab-checkbox';

    const label = document.createElement('label');
    label.textContent = tab.title;

    div.appendChild(checkbox);
    div.appendChild(label);
    tabList.appendChild(div);
  });
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  const nameInput = document.getElementById('workspaceName');
  const name = nameInput.value.trim();
  if (!name) return;

  // Get only the URLs of checked tabs
  const checkedBoxes = document.querySelectorAll('.tab-checkbox:checked');
  const selectedUrls = Array.from(checkedBoxes).map(cb => cb.value);

  if (selectedUrls.length === 0) return;

  const data = await chrome.storage.local.get('workspaces');
  const workspaces = data.workspaces || {};
  workspaces[name] = selectedUrls;

  await chrome.storage.local.set({ workspaces });
  nameInput.value = '';
  renderWorkspaces();
});

async function renderWorkspaces() {
  const list = document.getElementById('workspaceList');
  list.innerHTML = '';
  const data = await chrome.storage.local.get('workspaces');
  const workspaces = data.workspaces || {};

  for (const [name, urls] of Object.entries(workspaces)) {
    const btn = document.createElement('button');
    btn.className = 'workspace-btn';
    btn.textContent = `Open "${name}" (${urls.length} tabs)`;
    btn.addEventListener('click', () => {
      chrome.windows.create({ url: urls });
    });
    list.appendChild(btn);
  }
}

loadCurrentTabs();
renderWorkspaces();