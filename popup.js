// Fallback globe icon as SVG data URI for tabs without a favicon
const FALLBACK_FAVICON =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>'
  );

const LOCAL_CACHE_KEY = 'workspaces_cache_backup_v2';
const UI_STATE_CACHE_KEY = 'workspaces_ui_state_v2';

// Runtime state
let currentWindowTabs = [];
let searchQuery = '';
const workspaceUIState = new Map(); // name -> { expanded, activeSection ('todos'|'tabs'), renaming, confirmingDelete, editingTabIndex, editingTodoId, addTabMode (null|'open'|'custom') }

// Load persisted UI state (remembers which workspace was open & active tab)
function loadPersistedUIState() {
  try {
    const raw = localStorage.getItem(UI_STATE_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [name, state] of Object.entries(parsed)) {
        workspaceUIState.set(name, {
          expanded: Boolean(state.expanded),
          activeSection: state.activeSection === 'tabs' ? 'tabs' : 'todos',
          renaming: false,
          confirmingDelete: false,
          editingTabIndex: null,
          editingTodoId: null,
          addTabMode: null
        });
      }
    }
  } catch (_) {
    // Ignore corrupt UI state cache
  }
}

function savePersistedUIState() {
  try {
    const serializable = {};
    for (const [name, state] of workspaceUIState.entries()) {
      serializable[name] = {
        expanded: Boolean(state.expanded),
        activeSection: state.activeSection || 'todos'
      };
    }
    localStorage.setItem(UI_STATE_CACHE_KEY, JSON.stringify(serializable));
  } catch (_) {
    // Ignore quota errors
  }
}

function getUIState(name) {
  if (!workspaceUIState.has(name)) {
    workspaceUIState.set(name, {
      expanded: false,
      activeSection: 'todos',
      renaming: false,
      confirmingDelete: false,
      editingTabIndex: null,
      editingTodoId: null,
      addTabMode: null
    });
  }
  return workspaceUIState.get(name);
}

// Toast Notification helper
let toastTimeout = null;
function showToast(message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  container.innerHTML = '';
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    container.innerHTML = '';
  }, 2200);
}

// Helper to derive a readable title from a URL string (used when migrating legacy URL-only caches)
function deriveTitleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    const decodedPath = decodeURIComponent(path).replace(/\/$/, '');
    return decodedPath ? `${host}${decodedPath}` : host || url;
  } catch (_) {
    return url;
  }
}

// Helper to get a favicon URL for any URL
function getFaviconForUrl(url, existingFavicon) {
  if (existingFavicon && typeof existingFavicon === 'string' && existingFavicon.trim()) {
    return existingFavicon;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname)}&sz=32`;
    }
  } catch (_) {
    // Fallback
  }
  return FALLBACK_FAVICON;
}

// Normalize a single tab entry (supports legacy string URLs and new tab objects)
function normalizeTabEntry(rawTab) {
  if (typeof rawTab === 'string') {
    const url = rawTab.trim();
    const matchingOpenTab = currentWindowTabs.find(t => t.url === url);
    return {
      url,
      title: matchingOpenTab?.title || deriveTitleFromUrl(url),
      favIconUrl: matchingOpenTab?.favIconUrl || getFaviconForUrl(url, ''),
      fromLegacyCache: !matchingOpenTab?.title
    };
  }
  if (rawTab && typeof rawTab === 'object' && typeof rawTab.url === 'string') {
    const url = rawTab.url.trim();
    const matchingOpenTab = currentWindowTabs.find(t => t.url === url);
    const hasCustomTitle = rawTab.title && !rawTab.fromLegacyCache;
    return {
      url,
      title: hasCustomTitle
        ? rawTab.title
        : matchingOpenTab?.title || rawTab.title || deriveTitleFromUrl(url),
      favIconUrl:
        rawTab.favIconUrl ||
        matchingOpenTab?.favIconUrl ||
        getFaviconForUrl(url, ''),
      fromLegacyCache: Boolean(rawTab.fromLegacyCache && !matchingOpenTab?.title)
    };
  }
  return null;
}

// Normalize a single To-Do item
function normalizeTodoEntry(rawTodo, index) {
  if (!rawTodo || typeof rawTodo !== 'object') return null;
  const text = typeof rawTodo.text === 'string' ? rawTodo.text.trim() : '';
  if (!text) return null;
  return {
    id: rawTodo.id || `todo_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
    text,
    completed: Boolean(rawTodo.completed),
    createdAt: rawTodo.createdAt || Date.now()
  };
}

// Normalize & migrate entire workspaces dictionary while preserving legacy cached workspaces
function normalizeWorkspacesMap(rawWorkspaces) {
  const normalized = {};
  let migrated = false;

  if (!rawWorkspaces || typeof rawWorkspaces !== 'object') {
    return { workspaces: normalized, migrated: false };
  }

  for (const [name, value] of Object.entries(rawWorkspaces)) {
    if (Array.isArray(value)) {
      // Legacy v1.0 format: workspaces[name] = ["https://...", ...]
      migrated = true;
      const tabs = value.map(normalizeTabEntry).filter(Boolean);
      normalized[name] = {
        tabs,
        todos: [],
        updatedAt: Date.now()
      };
    } else if (value && typeof value === 'object') {
      const rawTabs = Array.isArray(value.tabs) ? value.tabs : [];
      const rawTodos = Array.isArray(value.todos) ? value.todos : [];

      const tabs = rawTabs.map(normalizeTabEntry).filter(Boolean);
      const todos = rawTodos.map((t, i) => normalizeTodoEntry(t, i)).filter(Boolean);

      if (
        !Array.isArray(value.tabs) ||
        !Array.isArray(value.todos) ||
        rawTabs.some(t => typeof t === 'string')
      ) {
        migrated = true;
      }

      normalized[name] = {
        tabs,
        todos,
        updatedAt: value.updatedAt || Date.now()
      };
    }
  }

  return { workspaces: normalized, migrated };
}

// Load workspaces from chrome.storage.local (with localStorage backup cache fallback & automatic migration)
async function getWorkspaces() {
  const data = await chrome.storage.local.get('workspaces');
  let rawWorkspaces = data.workspaces;

  // If chrome.storage.local has never been populated or was cleared unexpectedly, check localStorage backup cache
  if (rawWorkspaces === undefined) {
    try {
      const backupJson = localStorage.getItem(LOCAL_CACHE_KEY);
      if (backupJson) {
        rawWorkspaces = JSON.parse(backupJson);
      }
    } catch (_) {
      rawWorkspaces = {};
    }
  }

  const { workspaces, migrated } = normalizeWorkspacesMap(rawWorkspaces || {});

  // Always keep both chrome.storage.local and localStorage backup cache synced
  if (migrated || data.workspaces === undefined) {
    await saveWorkspaces(workspaces);
  } else {
    try {
      localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(workspaces));
    } catch (_) {
      // Ignore localStorage quota issues
    }
  }

  return workspaces;
}

// Save workspaces to both chrome.storage.local and localStorage backup cache
async function saveWorkspaces(workspaces) {
  await chrome.storage.local.set({ workspaces });
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(workspaces));
  } catch (_) {
    // Ignore localStorage quota errors
  }
}

// Load all tabs in the current browser window
async function loadCurrentTabs() {
  const tabList = document.getElementById('tabList');
  tabList.innerHTML = '';

  currentWindowTabs = await chrome.tabs.query({ currentWindow: true });

  currentWindowTabs.forEach((tab, index) => {
    const row = document.createElement('label');
    row.className = 'tab-check-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.className = 'tab-checkbox';
    checkbox.dataset.index = String(index);
    checkbox.addEventListener('change', updateSelectedTabsCount);

    const favicon = document.createElement('img');
    favicon.className = 'tab-favicon';
    favicon.src = getFaviconForUrl(tab.url, tab.favIconUrl);
    favicon.addEventListener('error', () => {
      favicon.src = FALLBACK_FAVICON;
    });

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tab-check-label';
    titleSpan.textContent = tab.title || tab.url;
    titleSpan.title = `${tab.title || ''}\n${tab.url || ''}`;

    row.appendChild(checkbox);
    row.appendChild(favicon);
    row.appendChild(titleSpan);

    if (tab.active) {
      const activeBadge = document.createElement('span');
      activeBadge.className = 'tab-badge';
      activeBadge.textContent = 'Active';
      row.appendChild(activeBadge);
    }

    tabList.appendChild(row);
  });

  updateSelectedTabsCount();
}

function updateSelectedTabsCount() {
  const checked = document.querySelectorAll('.tab-checkbox:checked').length;
  const total = document.querySelectorAll('.tab-checkbox').length;
  const countEl = document.getElementById('selectedTabsCount');
  if (countEl) {
    countEl.textContent = `${checked} of ${total} tab${total === 1 ? '' : 's'} selected`;
  }
}

// Normalize user-entered URL
function normalizeUrlInput(rawUrl) {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) || trimmed.startsWith('chrome://') || trimmed.startsWith('about:')) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

// Create SVG helper
function createSvgIcon(pathsHtml, size = 14) {
  const wrapper = document.createElement('span');
  wrapper.style.display = 'inline-flex';
  wrapper.style.alignItems = 'center';
  wrapper.style.justifyContent = 'center';
  wrapper.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${pathsHtml}</svg>`;
  return wrapper.firstElementChild;
}

// Render all saved workspaces
async function renderWorkspaces() {
  const list = document.getElementById('workspaceList');
  const countBadge = document.getElementById('workspaceCountBadge');
  const workspaces = await getWorkspaces();

  const entries = Object.entries(workspaces);
  if (countBadge) {
    countBadge.textContent = String(entries.length);
  }

  list.innerHTML = '';

  const filteredEntries = entries.filter(([name, ws]) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    if (name.toLowerCase().includes(q)) return true;
    if (ws.tabs.some(t => (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q))) {
      return true;
    }
    if (ws.todos.some(td => (td.text || '').toLowerCase().includes(q))) {
      return true;
    }
    return false;
  });

  if (filteredEntries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    if (entries.length === 0) {
      empty.innerHTML = `
        <img src="Cheerful Boy Typing on Keyboard.png" alt="Workspace Manager" class="empty-state-logo">
        <div class="empty-state-title">No Saved Workspaces Yet</div>
        <div class="empty-state-desc">Select open tabs above, enter a name, and click Save to create your first workspace with its own To-Do list.</div>
      `;
    } else {
      empty.innerHTML = `
        <div class="empty-state-title">No Matching Workspaces</div>
        <div class="empty-state-desc">Try a different search keyword.</div>
      `;
    }
    list.appendChild(empty);
    return;
  }

  filteredEntries.forEach(([name, ws]) => {
    const state = getUIState(name);
    const card = document.createElement('div');
    card.className = `workspace-card${state.expanded ? ' expanded' : ''}`;

    const totalTodos = ws.todos.length;
    const completedTodos = ws.todos.filter(t => t.completed).length;
    const progressPercent = totalTodos > 0 ? Math.round((completedTodos / totalTodos) * 100) : 0;

    // Top section of workspace card
    const cardTop = document.createElement('div');
    cardTop.className = 'workspace-card-top';

    const mainRow = document.createElement('div');
    mainRow.className = 'workspace-row-main';

    // Workspace Name or Inline Rename Input
    const titleGroup = document.createElement('div');
    titleGroup.className = 'workspace-title-group';

    if (state.renaming) {
      const renameRow = document.createElement('div');
      renameRow.className = 'rename-input-row';

      const renameInput = document.createElement('input');
      renameInput.type = 'text';
      renameInput.value = name;
      renameInput.placeholder = 'Workspace name';

      const saveRenameBtn = document.createElement('button');
      saveRenameBtn.className = 'icon-btn success';
      saveRenameBtn.title = 'Save Name';
      saveRenameBtn.appendChild(createSvgIcon('<polyline points="20 6 9 17 4 12"></polyline>', 13));

      const cancelRenameBtn = document.createElement('button');
      cancelRenameBtn.className = 'icon-btn';
      cancelRenameBtn.title = 'Cancel';
      cancelRenameBtn.appendChild(createSvgIcon('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>', 13));

      const commitRename = async () => {
        const newName = renameInput.value.trim();
        if (!newName || newName === name) {
          state.renaming = false;
          renderWorkspaces();
          return;
        }
        const latestWorkspaces = await getWorkspaces();
        if (latestWorkspaces[newName]) {
          showToast(`Workspace "${newName}" already exists`);
          return;
        }
        // Preserve key order when renaming
        const updatedWorkspaces = {};
        for (const [k, v] of Object.entries(latestWorkspaces)) {
          if (k === name) {
            updatedWorkspaces[newName] = { ...v, updatedAt: Date.now() };
          } else {
            updatedWorkspaces[k] = v;
          }
        }
        workspaceUIState.set(newName, { ...state, renaming: false });
        workspaceUIState.delete(name);
        savePersistedUIState();
        await saveWorkspaces(updatedWorkspaces);
        showToast(`Renamed to "${newName}"`);
        renderWorkspaces();
      };

      saveRenameBtn.addEventListener('click', commitRename);
      cancelRenameBtn.addEventListener('click', () => {
        state.renaming = false;
        renderWorkspaces();
      });
      renameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') commitRename();
        if (e.key === 'Escape') {
          state.renaming = false;
          renderWorkspaces();
        }
      });

      renameRow.appendChild(renameInput);
      renameRow.appendChild(saveRenameBtn);
      renameRow.appendChild(cancelRenameBtn);
      titleGroup.appendChild(renameRow);

      setTimeout(() => {
        renameInput.focus();
        renameInput.select();
      }, 0);
    } else {
      const nameEl = document.createElement('span');
      nameEl.className = 'workspace-name';
      nameEl.textContent = name;
      nameEl.title = 'Click to expand / manage workspace';
      nameEl.addEventListener('click', () => {
        state.expanded = !state.expanded;
        savePersistedUIState();
        renderWorkspaces();
      });

      const renameBtn = document.createElement('button');
      renameBtn.className = 'mini-icon-btn';
      renameBtn.title = 'Rename workspace';
      renameBtn.appendChild(
        createSvgIcon(
          '<path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>',
          12
        )
      );
      renameBtn.addEventListener('click', e => {
        e.stopPropagation();
        state.renaming = true;
        renderWorkspaces();
      });

      titleGroup.appendChild(nameEl);
      titleGroup.appendChild(renameBtn);
    }

    // Action Buttons: Open Window, Open in Current Window, Expand/Edit, Delete
    const actionsGroup = document.createElement('div');
    actionsGroup.className = 'workspace-actions';

    const openWindowBtn = document.createElement('button');
    openWindowBtn.className = 'btn btn-success btn-sm';
    openWindowBtn.title = `Open all ${ws.tabs.length} tab(s) in a new window`;
    openWindowBtn.appendChild(
      createSvgIcon(
        '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line>',
        12
      )
    );
    const openBtnText = document.createElement('span');
    openBtnText.textContent = 'Open';
    openWindowBtn.appendChild(openBtnText);
    openWindowBtn.addEventListener('click', () => {
      const urls = ws.tabs.map(t => t.url).filter(Boolean);
      if (urls.length === 0) {
        showToast('No tabs in this workspace yet');
        return;
      }
      chrome.windows.create({ url: urls });
    });

    const openCurrentBtn = document.createElement('button');
    openCurrentBtn.className = 'icon-btn';
    openCurrentBtn.title = 'Open tabs in current window';
    openCurrentBtn.appendChild(
      createSvgIcon(
        '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line>',
        13
      )
    );
    openCurrentBtn.addEventListener('click', () => {
      const urls = ws.tabs.map(t => t.url).filter(Boolean);
      if (urls.length === 0) {
        showToast('No tabs in this workspace yet');
        return;
      }
      urls.forEach(url => chrome.tabs.create({ url, active: false }));
      showToast(`Opened ${urls.length} tab(s) in current window`);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'icon-btn danger';
    deleteBtn.title = 'Delete workspace';
    deleteBtn.appendChild(
      createSvgIcon(
        '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
        13
      )
    );
    deleteBtn.addEventListener('click', () => {
      state.confirmingDelete = !state.confirmingDelete;
      renderWorkspaces();
    });

    actionsGroup.appendChild(openWindowBtn);
    actionsGroup.appendChild(openCurrentBtn);
    actionsGroup.appendChild(deleteBtn);

    mainRow.appendChild(titleGroup);
    mainRow.appendChild(actionsGroup);
    cardTop.appendChild(mainRow);

    // Quick toggle pills row (To-Do List & Saved Tabs)
    const metaRow = document.createElement('div');
    metaRow.className = 'workspace-meta-row';

    const pillsGroup = document.createElement('div');
    pillsGroup.className = 'workspace-pills';

    // To-Do pill
    const todoPill = document.createElement('button');
    const isTodoActive = state.expanded && state.activeSection === 'todos';
    const allDone = totalTodos > 0 && completedTodos === totalTodos;
    todoPill.className = `meta-pill${isTodoActive ? ' active' : ''}${allDone ? ' todo-complete' : ''}`;
    todoPill.title = 'Click to view & manage To-Do List';
    todoPill.appendChild(
      createSvgIcon(
        '<path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>',
        12
      )
    );
    const todoPillText = document.createElement('span');
    todoPillText.textContent = totalTodos > 0 ? `To-Do (${completedTodos}/${totalTodos})` : 'To-Do List';
    todoPill.appendChild(todoPillText);
    todoPill.addEventListener('click', () => {
      if (state.expanded && state.activeSection === 'todos') {
        state.expanded = false;
      } else {
        state.expanded = true;
        state.activeSection = 'todos';
      }
      savePersistedUIState();
      renderWorkspaces();
    });

    // Tabs pill
    const tabsPill = document.createElement('button');
    const isTabsActive = state.expanded && state.activeSection === 'tabs';
    tabsPill.className = `meta-pill${isTabsActive ? ' active' : ''}`;
    tabsPill.title = 'Click to edit, add, or remove tabs in this workspace';
    tabsPill.appendChild(
      createSvgIcon(
        '<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>',
        12
      )
    );
    const tabsPillText = document.createElement('span');
    tabsPillText.textContent = `Edit Tabs (${ws.tabs.length})`;
    tabsPill.appendChild(tabsPillText);
    tabsPill.addEventListener('click', () => {
      if (state.expanded && state.activeSection === 'tabs') {
        state.expanded = false;
      } else {
        state.expanded = true;
        state.activeSection = 'tabs';
      }
      savePersistedUIState();
      renderWorkspaces();
    });

    pillsGroup.appendChild(todoPill);
    pillsGroup.appendChild(tabsPill);

    const expandToggleBtn = document.createElement('button');
    expandToggleBtn.className = 'btn-ghost btn-sm';
    expandToggleBtn.textContent = state.expanded ? 'Hide' : 'Manage';
    expandToggleBtn.addEventListener('click', () => {
      state.expanded = !state.expanded;
      savePersistedUIState();
      renderWorkspaces();
    });

    metaRow.appendChild(pillsGroup);
    metaRow.appendChild(expandToggleBtn);
    cardTop.appendChild(metaRow);

    card.appendChild(cardTop);

    // To-Do Progress Bar (shown when workspace has todos)
    if (totalTodos > 0) {
      const progressTrack = document.createElement('div');
      progressTrack.className = 'todo-progress-track';
      const progressFill = document.createElement('div');
      progressFill.className = 'todo-progress-fill';
      progressFill.style.width = `${progressPercent}%`;
      progressTrack.appendChild(progressFill);
      card.appendChild(progressTrack);
    }

    // Inline Delete Confirmation Bar
    if (state.confirmingDelete) {
      const confirmBar = document.createElement('div');
      confirmBar.className = 'confirm-bar';

      const confirmText = document.createElement('span');
      confirmText.textContent = `Delete "${name}" and its ${totalTodos} task(s)?`;

      const confirmActions = document.createElement('div');
      confirmActions.className = 'confirm-bar-actions';

      const cancelDelBtn = document.createElement('button');
      cancelDelBtn.className = 'btn btn-secondary btn-sm';
      cancelDelBtn.textContent = 'Cancel';
      cancelDelBtn.addEventListener('click', () => {
        state.confirmingDelete = false;
        renderWorkspaces();
      });

      const confirmDelBtn = document.createElement('button');
      confirmDelBtn.className = 'btn btn-danger btn-sm';
      confirmDelBtn.textContent = 'Delete';
      confirmDelBtn.addEventListener('click', async () => {
        const latestWorkspaces = await getWorkspaces();
        delete latestWorkspaces[name];
        workspaceUIState.delete(name);
        savePersistedUIState();
        await saveWorkspaces(latestWorkspaces);
        showToast(`Deleted workspace "${name}"`);
        renderWorkspaces();
      });

      confirmActions.appendChild(cancelDelBtn);
      confirmActions.appendChild(confirmDelBtn);
      confirmBar.appendChild(confirmText);
      confirmBar.appendChild(confirmActions);
      card.appendChild(confirmBar);
    }

    // Expanded Drawer: To-Do List OR Saved Tabs Editor
    if (state.expanded) {
      const drawer = document.createElement('div');
      drawer.className = 'workspace-drawer';

      // Sub-navigation inside drawer
      const drawerNav = document.createElement('div');
      drawerNav.className = 'drawer-nav';

      const navTodoBtn = document.createElement('button');
      navTodoBtn.className = `drawer-tab-btn${state.activeSection === 'todos' ? ' active' : ''}`;
      navTodoBtn.appendChild(
        createSvgIcon(
          '<path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>',
          13
        )
      );
      const navTodoSpan = document.createElement('span');
      navTodoSpan.textContent = `To-Do List (${completedTodos}/${totalTodos})`;
      navTodoBtn.appendChild(navTodoSpan);
      navTodoBtn.addEventListener('click', () => {
        state.activeSection = 'todos';
        savePersistedUIState();
        renderWorkspaces();
      });

      const navTabsBtn = document.createElement('button');
      navTabsBtn.className = `drawer-tab-btn${state.activeSection === 'tabs' ? ' active' : ''}`;
      navTabsBtn.appendChild(
        createSvgIcon(
          '<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>',
          13
        )
      );
      const navTabsSpan = document.createElement('span');
      navTabsSpan.textContent = `Tabs (${ws.tabs.length})`;
      navTabsBtn.appendChild(navTabsSpan);
      navTabsBtn.addEventListener('click', () => {
        state.activeSection = 'tabs';
        savePersistedUIState();
        renderWorkspaces();
      });

      drawerNav.appendChild(navTodoBtn);
      drawerNav.appendChild(navTabsBtn);
      drawer.appendChild(drawerNav);

      if (state.activeSection === 'todos') {
        renderTodoSection(drawer, name, ws, state);
      } else {
        renderTabsSection(drawer, name, ws, state);
      }

      card.appendChild(drawer);
    }

    list.appendChild(card);
  });
}

// Render the independent To-Do List section for a workspace
function renderTodoSection(drawer, workspaceName, ws, state) {
  // Input row to add a new task
  const addRow = document.createElement('div');
  addRow.className = 'todo-input-row';

  const todoInput = document.createElement('input');
  todoInput.type = 'text';
  todoInput.placeholder = `Add a task to "${workspaceName}"...`;

  const addTodoBtn = document.createElement('button');
  addTodoBtn.className = 'btn btn-primary btn-sm';
  addTodoBtn.textContent = 'Add';

  const handleAddTodo = async () => {
    const text = todoInput.value.trim();
    if (!text) return;
    const latestWorkspaces = await getWorkspaces();
    const target = latestWorkspaces[workspaceName];
    if (!target) return;

    target.todos.push({
      id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      text,
      completed: false,
      createdAt: Date.now()
    });
    target.updatedAt = Date.now();
    await saveWorkspaces(latestWorkspaces);
    todoInput.value = '';
    renderWorkspaces();
  };

  addTodoBtn.addEventListener('click', handleAddTodo);
  todoInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAddTodo();
  });

  addRow.appendChild(todoInput);
  addRow.appendChild(addTodoBtn);
  drawer.appendChild(addRow);

  // List of tasks
  if (ws.todos.length === 0) {
    const emptyTodo = document.createElement('div');
    emptyTodo.className = 'sub-empty';
    emptyTodo.textContent = 'No tasks in this workspace yet. Add one above!';
    drawer.appendChild(emptyTodo);
    return;
  }

  const todoListEl = document.createElement('div');
  todoListEl.className = 'todo-list';

  ws.todos.forEach(todo => {
    const item = document.createElement('div');
    item.className = `todo-item${todo.completed ? ' completed' : ''}`;

    if (state.editingTodoId === todo.id) {
      const editRow = document.createElement('div');
      editRow.className = 'todo-edit-row';

      const editInput = document.createElement('input');
      editInput.type = 'text';
      editInput.value = todo.text;

      const saveEditBtn = document.createElement('button');
      saveEditBtn.className = 'icon-btn success';
      saveEditBtn.title = 'Save task';
      saveEditBtn.appendChild(createSvgIcon('<polyline points="20 6 9 17 4 12"></polyline>', 12));

      const cancelEditBtn = document.createElement('button');
      cancelEditBtn.className = 'icon-btn';
      cancelEditBtn.title = 'Cancel';
      cancelEditBtn.appendChild(
        createSvgIcon('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>', 12)
      );

      const commitTodoEdit = async () => {
        const updatedText = editInput.value.trim();
        if (!updatedText) return;
        const latestWorkspaces = await getWorkspaces();
        const target = latestWorkspaces[workspaceName];
        if (!target) return;
        const todoObj = target.todos.find(t => t.id === todo.id);
        if (todoObj) {
          todoObj.text = updatedText;
          target.updatedAt = Date.now();
          await saveWorkspaces(latestWorkspaces);
        }
        state.editingTodoId = null;
        renderWorkspaces();
      };

      saveEditBtn.addEventListener('click', commitTodoEdit);
      cancelEditBtn.addEventListener('click', () => {
        state.editingTodoId = null;
        renderWorkspaces();
      });
      editInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') commitTodoEdit();
        if (e.key === 'Escape') {
          state.editingTodoId = null;
          renderWorkspaces();
        }
      });

      editRow.appendChild(editInput);
      editRow.appendChild(saveEditBtn);
      editRow.appendChild(cancelEditBtn);
      item.appendChild(editRow);

      setTimeout(() => {
        editInput.focus();
        editInput.select();
      }, 0);
    } else {
      const left = document.createElement('div');
      left.className = 'todo-left';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'todo-checkbox';
      checkbox.checked = Boolean(todo.completed);

      const toggleTodo = async () => {
        const latestWorkspaces = await getWorkspaces();
        const target = latestWorkspaces[workspaceName];
        if (!target) return;
        const todoObj = target.todos.find(t => t.id === todo.id);
        if (todoObj) {
          todoObj.completed = !todoObj.completed;
          target.updatedAt = Date.now();
          await saveWorkspaces(latestWorkspaces);
          renderWorkspaces();
        }
      };

      checkbox.addEventListener('change', toggleTodo);

      const textSpan = document.createElement('span');
      textSpan.className = 'todo-text';
      textSpan.textContent = todo.text;
      textSpan.title = 'Click to toggle, double-click to edit';
      textSpan.addEventListener('click', toggleTodo);
      textSpan.addEventListener('dblclick', e => {
        e.stopPropagation();
        state.editingTodoId = todo.id;
        renderWorkspaces();
      });

      left.appendChild(checkbox);
      left.appendChild(textSpan);

      const rightActions = document.createElement('div');
      rightActions.className = 'saved-tab-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'mini-icon-btn';
      editBtn.title = 'Edit task';
      editBtn.appendChild(
        createSvgIcon(
          '<path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>',
          12
        )
      );
      editBtn.addEventListener('click', () => {
        state.editingTodoId = todo.id;
        renderWorkspaces();
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'mini-icon-btn danger';
      removeBtn.title = 'Delete task';
      removeBtn.appendChild(
        createSvgIcon('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>', 13)
      );
      removeBtn.addEventListener('click', async () => {
        const latestWorkspaces = await getWorkspaces();
        const target = latestWorkspaces[workspaceName];
        if (!target) return;
        target.todos = target.todos.filter(t => t.id !== todo.id);
        target.updatedAt = Date.now();
        await saveWorkspaces(latestWorkspaces);
        renderWorkspaces();
      });

      rightActions.appendChild(editBtn);
      rightActions.appendChild(removeBtn);

      item.appendChild(left);
      item.appendChild(rightActions);
    }

    todoListEl.appendChild(item);
  });

  drawer.appendChild(todoListEl);

  // Footer with completed count & Clear Completed button
  const completedCount = ws.todos.filter(t => t.completed).length;
  const footer = document.createElement('div');
  footer.className = 'todo-footer';

  const statusText = document.createElement('span');
  statusText.textContent = `${completedCount} of ${ws.todos.length} completed`;
  footer.appendChild(statusText);

  if (completedCount > 0) {
    const clearCompletedBtn = document.createElement('button');
    clearCompletedBtn.className = 'link-btn';
    clearCompletedBtn.textContent = 'Clear completed';
    clearCompletedBtn.addEventListener('click', async () => {
      const latestWorkspaces = await getWorkspaces();
      const target = latestWorkspaces[workspaceName];
      if (!target) return;
      target.todos = target.todos.filter(t => !t.completed);
      target.updatedAt = Date.now();
      await saveWorkspaces(latestWorkspaces);
      showToast('Cleared completed tasks');
      renderWorkspaces();
    });
    footer.appendChild(clearCompletedBtn);
  }

  drawer.appendChild(footer);
}

// Render the Saved Tabs Editor section for a workspace (view, open, edit, remove, and add tabs)
function renderTabsSection(drawer, workspaceName, ws, state) {
  if (ws.tabs.length === 0) {
    const emptyTabs = document.createElement('div');
    emptyTabs.className = 'sub-empty';
    emptyTabs.textContent = 'No tabs saved in this workspace. Add open tabs or a custom URL below.';
    drawer.appendChild(emptyTabs);
  } else {
    const tabsListEl = document.createElement('div');
    tabsListEl.className = 'saved-tabs-list';

    ws.tabs.forEach((tab, idx) => {
      if (state.editingTabIndex === idx) {
        const editBox = document.createElement('div');
        editBox.className = 'tab-edit-box';

        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.value = tab.title || '';
        titleInput.placeholder = 'Tab title';

        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.value = tab.url || '';
        urlInput.placeholder = 'https://example.com';

        const editActions = document.createElement('div');
        editActions.className = 'tab-edit-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary btn-sm';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
          state.editingTabIndex = null;
          renderWorkspaces();
        });

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary btn-sm';
        saveBtn.textContent = 'Save Tab';
        const saveTabChanges = async () => {
          const newUrl = normalizeUrlInput(urlInput.value);
          if (!newUrl) return;
          const newTitle = titleInput.value.trim() || deriveTitleFromUrl(newUrl);

          const latestWorkspaces = await getWorkspaces();
          const target = latestWorkspaces[workspaceName];
          if (!target || !target.tabs[idx]) return;

          target.tabs[idx] = {
            url: newUrl,
            title: newTitle,
            favIconUrl: getFaviconForUrl(newUrl, target.tabs[idx].url === newUrl ? target.tabs[idx].favIconUrl : ''),
            fromLegacyCache: false
          };
          target.updatedAt = Date.now();
          await saveWorkspaces(latestWorkspaces);
          state.editingTabIndex = null;
          showToast('Tab updated');
          renderWorkspaces();
        };

        saveBtn.addEventListener('click', saveTabChanges);
        urlInput.addEventListener('keydown', e => {
          if (e.key === 'Enter') saveTabChanges();
        });
        titleInput.addEventListener('keydown', e => {
          if (e.key === 'Enter') saveTabChanges();
        });

        editActions.appendChild(cancelBtn);
        editActions.appendChild(saveBtn);
        editBox.appendChild(titleInput);
        editBox.appendChild(urlInput);
        editBox.appendChild(editActions);
        tabsListEl.appendChild(editBox);
        return;
      }

      const row = document.createElement('div');
      row.className = 'saved-tab-row';

      const info = document.createElement('div');
      info.className = 'saved-tab-info';
      info.title = `Click to open: ${tab.url}`;
      info.addEventListener('click', () => {
        chrome.tabs.create({ url: tab.url, active: true });
      });

      const favicon = document.createElement('img');
      favicon.className = 'tab-favicon';
      favicon.src = getFaviconForUrl(tab.url, tab.favIconUrl);
      favicon.addEventListener('error', () => {
        favicon.src = FALLBACK_FAVICON;
      });

      const textGroup = document.createElement('div');
      textGroup.className = 'saved-tab-text';

      const titleEl = document.createElement('div');
      titleEl.className = 'saved-tab-title';
      titleEl.textContent = tab.title || deriveTitleFromUrl(tab.url);

      const urlEl = document.createElement('div');
      urlEl.className = 'saved-tab-url';
      urlEl.textContent = tab.url;

      textGroup.appendChild(titleEl);
      textGroup.appendChild(urlEl);

      info.appendChild(favicon);
      info.appendChild(textGroup);

      const actions = document.createElement('div');
      actions.className = 'saved-tab-actions';

      const editTabBtn = document.createElement('button');
      editTabBtn.className = 'mini-icon-btn';
      editTabBtn.title = 'Edit tab title or URL';
      editTabBtn.appendChild(
        createSvgIcon(
          '<path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>',
          12
        )
      );
      editTabBtn.addEventListener('click', () => {
        state.editingTabIndex = idx;
        renderWorkspaces();
      });

      const removeTabBtn = document.createElement('button');
      removeTabBtn.className = 'mini-icon-btn danger';
      removeTabBtn.title = 'Remove tab from workspace';
      removeTabBtn.appendChild(
        createSvgIcon('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>', 13)
      );
      removeTabBtn.addEventListener('click', async () => {
        const latestWorkspaces = await getWorkspaces();
        const target = latestWorkspaces[workspaceName];
        if (!target) return;
        target.tabs.splice(idx, 1);
        target.updatedAt = Date.now();
        await saveWorkspaces(latestWorkspaces);
        showToast('Removed tab from workspace');
        renderWorkspaces();
      });

      actions.appendChild(editTabBtn);
      actions.appendChild(removeTabBtn);

      row.appendChild(info);
      row.appendChild(actions);
      tabsListEl.appendChild(row);
    });

    drawer.appendChild(tabsListEl);
  }

  // Controls to add new tabs to this saved workspace
  const addTabsBar = document.createElement('div');
  addTabsBar.className = 'add-tabs-bar';

  const btnRow = document.createElement('div');
  btnRow.className = 'add-tabs-buttons';

  // Quick button 1: Add Active Tab
  const addActiveTabBtn = document.createElement('button');
  addActiveTabBtn.className = 'btn btn-secondary btn-sm';
  addActiveTabBtn.style.flex = '1';
  addActiveTabBtn.textContent = '+ Active Tab';
  addActiveTabBtn.title = 'Add the currently active browser tab to this workspace';
  addActiveTabBtn.addEventListener('click', async () => {
    const activeTab = currentWindowTabs.find(t => t.active) || currentWindowTabs[0];
    if (!activeTab || !activeTab.url) {
      showToast('No active tab found');
      return;
    }
    const latestWorkspaces = await getWorkspaces();
    const target = latestWorkspaces[workspaceName];
    if (!target) return;

    target.tabs.push({
      url: activeTab.url,
      title: activeTab.title || deriveTitleFromUrl(activeTab.url),
      favIconUrl: getFaviconForUrl(activeTab.url, activeTab.favIconUrl),
      fromLegacyCache: false
    });
    target.updatedAt = Date.now();
    await saveWorkspaces(latestWorkspaces);
    showToast('Added active tab');
    renderWorkspaces();
  });

  // Quick button 2: Pick from Open Browser Tabs
  const pickOpenTabsBtn = document.createElement('button');
  pickOpenTabsBtn.className = `btn ${state.addTabMode === 'open' ? 'btn-primary' : 'btn-secondary'} btn-sm`;
  pickOpenTabsBtn.style.flex = '1';
  pickOpenTabsBtn.textContent = '+ Open Tabs';
  pickOpenTabsBtn.addEventListener('click', () => {
    state.addTabMode = state.addTabMode === 'open' ? null : 'open';
    renderWorkspaces();
  });

  // Quick button 3: Add Custom URL
  const customUrlBtn = document.createElement('button');
  customUrlBtn.className = `btn ${state.addTabMode === 'custom' ? 'btn-primary' : 'btn-secondary'} btn-sm`;
  customUrlBtn.style.flex = '1';
  customUrlBtn.textContent = '+ Custom URL';
  customUrlBtn.addEventListener('click', () => {
    state.addTabMode = state.addTabMode === 'custom' ? null : 'custom';
    renderWorkspaces();
  });

  btnRow.appendChild(addActiveTabBtn);
  btnRow.appendChild(pickOpenTabsBtn);
  btnRow.appendChild(customUrlBtn);
  addTabsBar.appendChild(btnRow);

  // Mode: Pick from currently open window tabs
  if (state.addTabMode === 'open') {
    const pickerBox = document.createElement('div');
    pickerBox.className = 'open-tabs-picker';

    const existingUrls = new Set(ws.tabs.map(t => t.url));
    const pickerList = document.createElement('div');
    pickerList.className = 'open-tabs-list';
    pickerList.style.maxHeight = '120px';

    currentWindowTabs.forEach((tab, idx) => {
      const label = document.createElement('label');
      label.className = 'tab-check-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'picker-tab-cb';
      cb.dataset.index = String(idx);
      const alreadyInWorkspace = existingUrls.has(tab.url);
      cb.checked = !alreadyInWorkspace;

      const fav = document.createElement('img');
      fav.className = 'tab-favicon';
      fav.src = getFaviconForUrl(tab.url, tab.favIconUrl);
      fav.addEventListener('error', () => {
        fav.src = FALLBACK_FAVICON;
      });

      const titleSpan = document.createElement('span');
      titleSpan.className = 'tab-check-label';
      titleSpan.textContent = tab.title || tab.url;

      label.appendChild(cb);
      label.appendChild(fav);
      label.appendChild(titleSpan);

      if (alreadyInWorkspace) {
        const badge = document.createElement('span');
        badge.className = 'tab-badge';
        badge.textContent = 'Saved';
        label.appendChild(badge);
      }

      pickerList.appendChild(label);
    });

    const pickerActions = document.createElement('div');
    pickerActions.className = 'tab-edit-actions';

    const cancelPickerBtn = document.createElement('button');
    cancelPickerBtn.className = 'btn btn-secondary btn-sm';
    cancelPickerBtn.textContent = 'Close';
    cancelPickerBtn.addEventListener('click', () => {
      state.addTabMode = null;
      renderWorkspaces();
    });

    const addSelectedBtn = document.createElement('button');
    addSelectedBtn.className = 'btn btn-primary btn-sm';
    addSelectedBtn.textContent = 'Add Checked Tabs';
    addSelectedBtn.addEventListener('click', async () => {
      const checkedBoxes = pickerList.querySelectorAll('.picker-tab-cb:checked');
      if (checkedBoxes.length === 0) {
        showToast('Select at least one tab to add');
        return;
      }
      const latestWorkspaces = await getWorkspaces();
      const target = latestWorkspaces[workspaceName];
      if (!target) return;

      let addedCount = 0;
      checkedBoxes.forEach(cb => {
        const tab = currentWindowTabs[Number(cb.dataset.index)];
        if (tab && tab.url) {
          target.tabs.push({
            url: tab.url,
            title: tab.title || deriveTitleFromUrl(tab.url),
            favIconUrl: getFaviconForUrl(tab.url, tab.favIconUrl),
            fromLegacyCache: false
          });
          addedCount++;
        }
      });

      target.updatedAt = Date.now();
      await saveWorkspaces(latestWorkspaces);
      state.addTabMode = null;
      showToast(`Added ${addedCount} tab(s) to "${workspaceName}"`);
      renderWorkspaces();
    });

    pickerActions.appendChild(cancelPickerBtn);
    pickerActions.appendChild(addSelectedBtn);

    pickerBox.appendChild(pickerList);
    pickerBox.appendChild(pickerActions);
    addTabsBar.appendChild(pickerBox);
  }

  // Mode: Add custom URL manually
  if (state.addTabMode === 'custom') {
    const customForm = document.createElement('div');
    customForm.className = 'add-custom-url-form';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = 'URL (e.g., https://github.com)';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.placeholder = 'Optional title (e.g., GitHub Repo)';

    const formActions = document.createElement('div');
    formActions.className = 'tab-edit-actions';

    const cancelCustomBtn = document.createElement('button');
    cancelCustomBtn.className = 'btn btn-secondary btn-sm';
    cancelCustomBtn.textContent = 'Cancel';
    cancelCustomBtn.addEventListener('click', () => {
      state.addTabMode = null;
      renderWorkspaces();
    });

    const saveCustomBtn = document.createElement('button');
    saveCustomBtn.className = 'btn btn-primary btn-sm';
    saveCustomBtn.textContent = 'Add URL';

    const handleAddCustomUrl = async () => {
      const normalizedUrl = normalizeUrlInput(urlInput.value);
      if (!normalizedUrl) {
        showToast('Please enter a valid URL');
        return;
      }
      const title = titleInput.value.trim() || deriveTitleFromUrl(normalizedUrl);
      const latestWorkspaces = await getWorkspaces();
      const target = latestWorkspaces[workspaceName];
      if (!target) return;

      target.tabs.push({
        url: normalizedUrl,
        title,
        favIconUrl: getFaviconForUrl(normalizedUrl, ''),
        fromLegacyCache: false
      });
      target.updatedAt = Date.now();
      await saveWorkspaces(latestWorkspaces);
      state.addTabMode = null;
      showToast('Added custom URL');
      renderWorkspaces();
    };

    saveCustomBtn.addEventListener('click', handleAddCustomUrl);
    urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleAddCustomUrl();
    });
    titleInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleAddCustomUrl();
    });

    formActions.appendChild(cancelCustomBtn);
    formActions.appendChild(saveCustomBtn);
    customForm.appendChild(urlInput);
    customForm.appendChild(titleInput);
    customForm.appendChild(formActions);
    addTabsBar.appendChild(customForm);

    setTimeout(() => urlInput.focus(), 0);
  }

  drawer.appendChild(addTabsBar);
}

// Wire up top-level event listeners
function initEventListeners() {
  // Collapse/expand Create Workspace card
  const createCard = document.getElementById('createCard');
  const createCardHeader = document.getElementById('createCardHeader');
  createCardHeader.addEventListener('click', () => {
    createCard.classList.toggle('collapsed');
  });

  // Select All / Clear open tabs
  document.getElementById('selectAllTabsBtn').addEventListener('click', () => {
    document.querySelectorAll('.tab-checkbox').forEach(cb => {
      cb.checked = true;
    });
    updateSelectedTabsCount();
  });

  document.getElementById('deselectAllTabsBtn').addEventListener('click', () => {
    document.querySelectorAll('.tab-checkbox').forEach(cb => {
      cb.checked = false;
    });
    updateSelectedTabsCount();
  });

  // Save new workspace
  const saveWorkspaceHandler = async () => {
    const nameInput = document.getElementById('workspaceName');
    const name = nameInput.value.trim();
    if (!name) {
      showToast('Please enter a workspace name');
      nameInput.focus();
      return;
    }

    const checkedBoxes = document.querySelectorAll('.tab-checkbox:checked');
    const selectedTabs = Array.from(checkedBoxes)
      .map(cb => currentWindowTabs[Number(cb.dataset.index)])
      .filter(Boolean)
      .map(tab => ({
        url: tab.url,
        title: tab.title || deriveTitleFromUrl(tab.url),
        favIconUrl: getFaviconForUrl(tab.url, tab.favIconUrl),
        fromLegacyCache: false
      }));

    if (selectedTabs.length === 0) {
      showToast('Select at least one open tab');
      return;
    }

    const workspaces = await getWorkspaces();
    const existingTodos = workspaces[name]?.todos || [];

    workspaces[name] = {
      tabs: selectedTabs,
      todos: existingTodos,
      updatedAt: Date.now()
    };

    const state = getUIState(name);
    state.expanded = true;
    savePersistedUIState();

    await saveWorkspaces(workspaces);
    nameInput.value = '';
    showToast(`Saved workspace "${name}"`);
    renderWorkspaces();
  };

  document.getElementById('saveBtn').addEventListener('click', saveWorkspaceHandler);
  document.getElementById('workspaceName').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveWorkspaceHandler();
  });

  // Search workspaces
  document.getElementById('searchWorkspacesInput').addEventListener('input', e => {
    searchQuery = e.target.value.trim();
    renderWorkspaces();
  });

  // Export Workspaces Cache as JSON
  document.getElementById('exportCacheBtn').addEventListener('click', async () => {
    const workspaces = await getWorkspaces();
    const blob = new Blob([JSON.stringify(workspaces, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workspaces-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported workspaces backup');
  });

  // Import Workspaces Cache from JSON
  const importFileInput = document.getElementById('importFileInput');
  document.getElementById('importCacheBtn').addEventListener('click', () => {
    importFileInput.click();
  });

  importFileInput.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const { workspaces: importedWorkspaces } = normalizeWorkspacesMap(parsed);
      const existingWorkspaces = await getWorkspaces();
      const merged = { ...existingWorkspaces, ...importedWorkspaces };
      await saveWorkspaces(merged);
      showToast(`Imported ${Object.keys(importedWorkspaces).length} workspace(s)`);
      renderWorkspaces();
    } catch (_) {
      showToast('Invalid backup JSON file');
    } finally {
      importFileInput.value = '';
    }
  });
}

// Initialize popup
async function init() {
  loadPersistedUIState();
  initEventListeners();
  await loadCurrentTabs();
  await renderWorkspaces();
}

init();
