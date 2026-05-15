'use strict';

(function () {
  // ── State ────────────────────────────────────────────────────────────
  const state = {
    scanResults: [],
    counts: { IN_SYNC: 0, DIFFERENT: 0, MISSING: 0, ERROR: 0 },
    logSinceId: 0,
    eventSource: null,
    filterText: '',
    saveTimer: null,
    toastTimer: null,
    activeView: 'sync',
    distribute: {
      repos: [],
      selected: new Set(),
      filterText: '',
      loaded: false,
      loading: false,
      pushing: false,
      statusByRepo: new Map(),
    },
  };

  // ── Elements ─────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    canonical: $('canonical'),
    byteCount: $('byte-count'),
    btnSave: $('btn-save'),
    btnScan: $('btn-scan'),
    btnUpdateAll: $('btn-update-all'),
    btnClearLog: $('btn-clear-log'),
    resultsList: $('results-list'),
    logBody: $('log-body'),
    logCount: $('log-count'),
    logAutoscroll: $('log-autoscroll'),
    scanningLabel: $('scanning-label'),
    distributingLabel: $('distribute-label'),
    pillSync: $('pill-sync'),
    pillDiff: $('pill-diff'),
    pillMiss: $('pill-miss'),
    pillErr: $('pill-err'),
    filterGroup: $('filter-group'),
    filterInput: $('filter-input'),
    saveStatus: $('save-status'),
    toast: $('toast'),
    hostBadge: $('host-badge'),
    tabSync: $('tab-sync'),
    tabDistribute: $('tab-distribute'),
    viewSync: $('view-sync'),
    viewDistribute: $('view-distribute'),
    distributeFilename: $('distribute-filename'),
    distributeMessage: $('distribute-message'),
    distributeContent: $('distribute-content'),
    distributeByteCount: $('distribute-byte-count'),
    distributeOverwrite: $('distribute-overwrite'),
    btnDistribute: $('btn-distribute'),
    btnSelectAll: $('btn-select-all'),
    btnSelectNone: $('btn-select-none'),
    btnReloadRepos: $('btn-reload-repos'),
    distributeRepoList: $('distribute-repo-list'),
    distributeFilter: $('distribute-filter'),
    distributeSelectedPill: $('distribute-selected-pill'),
  };

  // ── Utilities ────────────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} bytes`;
    return `${(n / 1024).toFixed(1)} KB`;
  }

  function byteLength(str) {
    return new Blob([str]).size;
  }

  function showToast(msg, kind) {
    const t = els.toast;
    t.textContent = msg;
    t.className = `toast ${kind === 'error' ? 'toast-error' : kind === 'success' ? 'toast-success' : ''}`;
    t.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function setSaveStatus(text, kind) {
    els.saveStatus.textContent = text;
    els.saveStatus.classList.toggle('error', kind === 'error');
    els.saveStatus.classList.toggle('visible', !!text);
    if (text) {
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => els.saveStatus.classList.remove('visible'), 2500);
    }
  }

  function updateByteCount() {
    els.byteCount.textContent = formatBytes(byteLength(els.canonical.value));
  }

  // ── Canonical load/save ──────────────────────────────────────────────
  async function loadCanonical() {
    try {
      const r = await fetch('/api/canonical');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (d.content) {
        els.canonical.value = d.content;
        updateByteCount();
      }
    } catch (err) {
      showToast(`Failed to load canonical: ${err.message}`, 'error');
    }
  }

  async function saveCanonical() {
    const content = els.canonical.value;
    if (!content.trim()) {
      setSaveStatus('Cannot save empty content', 'error');
      showToast('Cannot save empty content', 'error');
      return;
    }
    els.btnSave.disabled = true;
    setSaveStatus('Saving...');
    try {
      const r = await fetch('/api/canonical', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setSaveStatus(`Saved (${formatBytes(d.bytes)})`);
    } catch (err) {
      setSaveStatus(`Error: ${err.message}`, 'error');
      showToast(`Save failed: ${err.message}`, 'error');
    } finally {
      els.btnSave.disabled = false;
    }
  }

  // ── Scan ─────────────────────────────────────────────────────────────
  function startScan() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    state.scanResults = [];
    state.counts = { IN_SYNC: 0, DIFFERENT: 0, MISSING: 0, ERROR: 0 };
    state.filterText = '';
    els.filterInput.value = '';
    els.resultsList.innerHTML = '';
    updatePills();
    els.btnUpdateAll.hidden = true;
    els.filterGroup.hidden = true;
    els.btnScan.disabled = true;
    els.scanningLabel.hidden = false;

    const es = new EventSource('/api/scan');
    state.eventSource = es;

    es.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }

      if (data.type === 'error') {
        finishScan();
        showToast(data.msg, 'error');
        return;
      }
      if (data.type === 'start') return;
      if (data.type === 'count') return;
      if (data.type === 'repo') {
        state.scanResults.push(data);
        state.counts[data.status] = (state.counts[data.status] || 0) + 1;
        renderRepoCard(data);
        updatePills();
      }
      if (data.type === 'done') {
        finishScan();
        const outOfSync = state.scanResults.filter((r) => r.status === 'DIFFERENT' || r.status === 'MISSING');
        if (outOfSync.length > 0) els.btnUpdateAll.hidden = false;
        els.filterGroup.hidden = state.scanResults.length === 0;
        showToast(
          `Scan complete: ${state.counts.IN_SYNC} in sync, ${state.counts.DIFFERENT} different, ${state.counts.MISSING} missing` +
          (state.counts.ERROR ? `, ${state.counts.ERROR} errored` : ''),
          state.counts.ERROR ? 'error' : 'success'
        );
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; if server ended cleanly, finishScan was called.
      // Only show error if we're still mid-scan.
      if (els.btnScan.disabled) {
        finishScan();
        showToast('Connection error during scan', 'error');
      }
      es.close();
    };
  }

  function finishScan() {
    els.btnScan.disabled = false;
    els.scanningLabel.hidden = true;
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
  }

  // ── Render ───────────────────────────────────────────────────────────
  function renderRepoCard(data) {
    if (els.resultsList.querySelector('.empty-state')) {
      els.resultsList.innerHTML = '';
    }

    const { repo, status, patch, defaultBranch, error } = data;
    const card = document.createElement('div');
    card.className = 'repo-card';
    card.dataset.repo = repo;
    card.dataset.status = status;

    const { badgeClass, badgeLabel } = statusToBadge(status);

    const header = document.createElement('div');
    header.className = 'repo-card-header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', 'false');

    const name = document.createElement('span');
    name.className = 'repo-name';
    name.textContent = repo;
    header.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'repo-meta';

    const badge = document.createElement('span');
    badge.className = `status-badge ${badgeClass}`;
    badge.textContent = badgeLabel;
    meta.appendChild(badge);

    if (status === 'DIFFERENT' || status === 'MISSING') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm btn-update-single';
      btn.textContent = 'Update';
      btn.dataset.repo = repo;
      btn.dataset.branch = defaultBranch;
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await pushRepos([{ repo, defaultBranch }]);
      });
      meta.appendChild(btn);
    }

    if (patch || error) {
      const arrow = document.createElement('span');
      arrow.className = 'toggle-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      meta.appendChild(arrow);
    }

    header.appendChild(meta);
    card.appendChild(header);

    if (patch) {
      const diff = document.createElement('div');
      diff.className = 'diff-block';
      const pre = document.createElement('pre');
      pre.className = 'diff-content';
      pre.innerHTML = colorDiff(patch);
      diff.appendChild(pre);
      card.appendChild(diff);
    }
    if (error) {
      const errBox = document.createElement('div');
      errBox.className = 'error-detail';
      errBox.textContent = error;
      card.appendChild(errBox);
    }

    const toggle = () => {
      const opening = !card.classList.contains('open');
      card.classList.toggle('open');
      header.setAttribute('aria-expanded', String(opening));
    };
    header.addEventListener('click', (e) => {
      if (e.target.closest('button.btn')) return;
      toggle();
    });
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });

    els.resultsList.appendChild(card);
    applyFilter();
  }

  function statusToBadge(status) {
    switch (status) {
      case 'IN_SYNC': return { badgeClass: 'badge-sync', badgeLabel: 'In Sync' };
      case 'DIFFERENT': return { badgeClass: 'badge-diff', badgeLabel: 'Different' };
      case 'MISSING': return { badgeClass: 'badge-miss', badgeLabel: 'Missing' };
      case 'ERROR': return { badgeClass: 'badge-error', badgeLabel: 'Error' };
      case 'PUSHING': return { badgeClass: 'badge-pushing', badgeLabel: 'Pushing...' };
      default: return { badgeClass: 'badge-error', badgeLabel: status };
    }
  }

  function colorDiff(patch) {
    return patch.split('\n').map((line) => {
      const escaped = escapeHtml(line);
      if (line.startsWith('+++') || line.startsWith('---')) return `<span class="diff-meta">${escaped}</span>`;
      if (line.startsWith('@@')) return `<span class="diff-hunk">${escaped}</span>`;
      if (line.startsWith('+')) return `<span class="diff-add">${escaped}</span>`;
      if (line.startsWith('-')) return `<span class="diff-remove">${escaped}</span>`;
      return escaped;
    }).join('\n');
  }

  function updatePills() {
    const setPill = (el, count, label) => {
      el.textContent = `${count} ${label}`;
      el.hidden = count === 0;
    };
    setPill(els.pillSync, state.counts.IN_SYNC || 0, 'in sync');
    setPill(els.pillDiff, state.counts.DIFFERENT || 0, 'different');
    setPill(els.pillMiss, state.counts.MISSING || 0, 'missing');
    setPill(els.pillErr, state.counts.ERROR || 0, 'errors');
  }

  function recomputeCounts() {
    state.counts = { IN_SYNC: 0, DIFFERENT: 0, MISSING: 0, ERROR: 0 };
    for (const r of state.scanResults) {
      state.counts[r.status] = (state.counts[r.status] || 0) + 1;
    }
    updatePills();
  }

  // ── Update ───────────────────────────────────────────────────────────
  async function pushRepos(targets) {
    if (targets.length === 0) return;

    const cards = targets.map((t) => document.querySelector(`[data-repo="${cssEscape(t.repo)}"]`)).filter(Boolean);
    cards.forEach((card) => {
      const badge = card.querySelector('.status-badge');
      if (badge) {
        const { badgeClass, badgeLabel } = statusToBadge('PUSHING');
        badge.className = `status-badge ${badgeClass}`;
        badge.innerHTML = `<span class="spinner"></span>${badgeLabel}`;
      }
      const btn = card.querySelector('.btn-update-single');
      if (btn) btn.disabled = true;
    });

    els.btnUpdateAll.disabled = true;

    let data;
    try {
      const r = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos: targets }),
      });
      data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    } catch (err) {
      cards.forEach((card) => restoreCardStatus(card));
      els.btnUpdateAll.disabled = false;
      showToast(`Update failed: ${err.message}`, 'error');
      return;
    }

    for (const r of data.results) {
      const card = document.querySelector(`[data-repo="${cssEscape(r.repo)}"]`);
      const result = state.scanResults.find((x) => x.repo === r.repo);
      if (r.ok) {
        if (result) {
          result.status = 'IN_SYNC';
          result.patch = null;
        }
        if (card) {
          card.dataset.status = 'IN_SYNC';
          const badge = card.querySelector('.status-badge');
          if (badge) {
            const { badgeClass, badgeLabel } = statusToBadge('IN_SYNC');
            badge.className = `status-badge ${badgeClass}`;
            badge.textContent = badgeLabel;
          }
          card.querySelector('.btn-update-single')?.remove();
          card.querySelector('.diff-block')?.remove();
          card.querySelector('.toggle-arrow')?.remove();
          card.classList.remove('open');
        }
      } else if (card) {
        const badge = card.querySelector('.status-badge');
        if (badge) {
          const { badgeClass, badgeLabel } = statusToBadge('ERROR');
          badge.className = `status-badge ${badgeClass}`;
          badge.textContent = badgeLabel;
        }
        let errBox = card.querySelector('.error-detail');
        if (!errBox) {
          errBox = document.createElement('div');
          errBox.className = 'error-detail';
          card.appendChild(errBox);
        }
        errBox.textContent = r.error;
        const btn = card.querySelector('.btn-update-single');
        if (btn) btn.disabled = false;
      }
    }

    recomputeCounts();
    const stillOutOfSync = state.scanResults.some((r) => r.status === 'DIFFERENT' || r.status === 'MISSING');
    els.btnUpdateAll.hidden = !stillOutOfSync;
    els.btnUpdateAll.disabled = false;

    const failed = data.results.filter((r) => !r.ok).length;
    const succeeded = data.results.filter((r) => r.ok && !r.skipped).length;
    const skipped = data.results.filter((r) => r.ok && r.skipped).length;
    const parts = [];
    if (succeeded) parts.push(`${succeeded} pushed`);
    if (skipped) parts.push(`${skipped} skipped`);
    if (failed) parts.push(`${failed} failed`);
    showToast(parts.join(', '), failed ? 'error' : 'success');
  }

  function restoreCardStatus(card) {
    const repo = card.dataset.repo;
    const result = state.scanResults.find((r) => r.repo === repo);
    if (!result) return;
    const badge = card.querySelector('.status-badge');
    if (badge) {
      const { badgeClass, badgeLabel } = statusToBadge(result.status);
      badge.className = `status-badge ${badgeClass}`;
      badge.textContent = badgeLabel;
    }
    const btn = card.querySelector('.btn-update-single');
    if (btn) btn.disabled = false;
  }

  function cssEscape(str) {
    if (window.CSS && CSS.escape) return CSS.escape(str);
    return String(str).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }

  // ── Filter ───────────────────────────────────────────────────────────
  function applyFilter() {
    const q = state.filterText.toLowerCase().trim();
    const cards = els.resultsList.querySelectorAll('.repo-card');
    cards.forEach((card) => {
      const repo = card.dataset.repo.toLowerCase();
      const status = card.dataset.status;
      const matchesText = !q || repo.includes(q) || status.toLowerCase().includes(q);
      card.classList.toggle('hidden', !matchesText);
    });
  }

  // ── Log polling ──────────────────────────────────────────────────────
  async function pollLog() {
    try {
      const r = await fetch(`/api/log?since=${state.logSinceId}`);
      if (!r.ok) return;
      const d = await r.json();
      for (const entry of d.entries) {
        renderLogEntry(entry);
        state.logSinceId = entry.id;
      }
      els.logCount.textContent = `${d.total} ${d.total === 1 ? 'entry' : 'entries'}`;
    } catch {
      // ignore transient errors
    }
  }

  function renderLogEntry(entry) {
    const line = document.createElement('div');
    line.className = `log-line log-${entry.level}`;
    const ts = new Date(entry.ts).toLocaleTimeString();
    line.textContent = `[${ts}] [${entry.level.toUpperCase()}] ${entry.msg}`;
    els.logBody.appendChild(line);
    if (els.logAutoscroll.checked) {
      els.logBody.scrollTop = els.logBody.scrollHeight;
    }
  }

  // ── Tab switching ────────────────────────────────────────────────────
  function setView(view) {
    state.activeView = view;
    const onSync = view === 'sync';
    els.tabSync.classList.toggle('active', onSync);
    els.tabDistribute.classList.toggle('active', !onSync);
    els.tabSync.setAttribute('aria-selected', String(onSync));
    els.tabDistribute.setAttribute('aria-selected', String(!onSync));
    els.viewSync.hidden = !onSync;
    els.viewDistribute.hidden = onSync;
    if (!onSync && !state.distribute.loaded && !state.distribute.loading) {
      loadRepos();
    }
  }

  // ── Distribute: repo list ────────────────────────────────────────────
  async function loadRepos() {
    if (state.distribute.loading || state.distribute.pushing) return;
    state.distribute.loading = true;
    els.btnReloadRepos.disabled = true;
    els.distributeRepoList.innerHTML = '<div class="empty-state"><div class="empty-state-icon" aria-hidden="true">&hellip;</div><div class="empty-state-title">Loading&hellip;</div><div class="empty-state-body">Fetching your GitHub repos.</div></div>';
    try {
      const r = await fetch('/api/repos');
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      state.distribute.repos = d.repos || [];
      state.distribute.loaded = true;
      const liveNames = new Set(state.distribute.repos.map((x) => x.nameWithOwner));
      for (const name of [...state.distribute.selected]) {
        if (!liveNames.has(name)) state.distribute.selected.delete(name);
      }
      for (const name of [...state.distribute.statusByRepo.keys()]) {
        if (!liveNames.has(name)) state.distribute.statusByRepo.delete(name);
      }
      renderRepoList();
      showToast(`Loaded ${state.distribute.repos.length} repos`, 'success');
    } catch (err) {
      els.distributeRepoList.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `<div class="empty-state-icon" aria-hidden="true">!</div><div class="empty-state-title">Failed to load repos</div><div class="empty-state-body">${escapeHtml(err.message)}</div>`;
      els.distributeRepoList.appendChild(empty);
      showToast(`Failed to load repos: ${err.message}`, 'error');
    } finally {
      state.distribute.loading = false;
      els.btnReloadRepos.disabled = false;
    }
  }

  function renderRepoList() {
    const list = els.distributeRepoList;
    list.innerHTML = '';
    const repos = state.distribute.repos;
    if (repos.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<div class="empty-state-icon" aria-hidden="true">&#9633;</div><div class="empty-state-title">No repos</div><div class="empty-state-body">No non-archived repos found for this user.</div>';
      list.appendChild(empty);
      return;
    }
    const q = state.distribute.filterText.toLowerCase().trim();
    let shown = 0;
    for (const repo of repos) {
      const name = repo.nameWithOwner;
      const matches = !q || name.toLowerCase().includes(q);
      if (!matches) continue;
      shown++;
      const row = document.createElement('label');
      row.className = 'repo-row';
      row.dataset.repo = name;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.distribute.selected.has(name);
      cb.addEventListener('change', () => {
        if (cb.checked) state.distribute.selected.add(name);
        else state.distribute.selected.delete(name);
        updateDistributeControls();
      });

      const text = document.createElement('span');
      text.className = 'repo-name';
      text.textContent = name;

      const branch = document.createElement('span');
      branch.className = 'repo-branch';
      branch.textContent = repo.defaultBranch;

      const status = document.createElement('span');
      status.className = 'repo-row-status';
      const s = state.distribute.statusByRepo.get(name);
      if (s) {
        const { badgeClass, badgeLabel } = distributeStatusBadge(s);
        status.className = `status-badge ${badgeClass}`;
        status.textContent = badgeLabel;
      }

      row.appendChild(cb);
      row.appendChild(text);
      row.appendChild(branch);
      row.appendChild(status);
      list.appendChild(row);
    }
    if (shown === 0 && q) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `<div class="empty-state-icon" aria-hidden="true">&#9633;</div><div class="empty-state-title">No matches</div><div class="empty-state-body">No repos match &ldquo;${escapeHtml(q)}&rdquo;.</div>`;
      list.appendChild(empty);
    }
    updateDistributeControls();
  }

  function distributeStatusBadge(s) {
    switch (s.action) {
      case 'created': return { badgeClass: 'badge-sync', badgeLabel: 'Created' };
      case 'updated': return { badgeClass: 'badge-diff', badgeLabel: 'Updated' };
      case 'skipped': return { badgeClass: 'badge-pushing', badgeLabel: 'Skipped' };
      case 'pushing': return { badgeClass: 'badge-pushing', badgeLabel: 'Pushing...' };
      case 'error': return { badgeClass: 'badge-error', badgeLabel: 'Error' };
      default: return { badgeClass: 'badge-pushing', badgeLabel: s.action };
    }
  }

  function updateDistributeControls() {
    const count = state.distribute.selected.size;
    els.distributeSelectedPill.textContent = `${count} selected`;
    const filename = els.distributeFilename.value.trim();
    const content = els.distributeContent.value;
    const pushing = state.distribute.pushing;
    const ready = count > 0 && filename.length > 0 && content.trim().length > 0 && !pushing;
    els.btnDistribute.disabled = !ready;
    els.btnDistribute.textContent = `Push to ${count} ${count === 1 ? 'Repo' : 'Repos'}`;
    els.distributeByteCount.textContent = formatBytes(byteLength(content));
    els.btnReloadRepos.disabled = pushing || state.distribute.loading;
    els.btnSelectAll.disabled = pushing;
    els.btnSelectNone.disabled = pushing;
    els.distributeFilename.disabled = pushing;
    els.distributeMessage.disabled = pushing;
    els.distributeContent.disabled = pushing;
    els.distributeOverwrite.disabled = pushing;
    for (const cb of els.distributeRepoList.querySelectorAll('input[type=checkbox]')) {
      cb.disabled = pushing;
    }
  }

  function distributeFilenameDefaultMessage() {
    const fn = els.distributeFilename.value.trim();
    if (!fn) return '';
    return `chore: add ${fn} [automated]`;
  }

  // ── Distribute: push ─────────────────────────────────────────────────
  async function distributePush() {
    if (state.distribute.pushing) return;
    const filename = els.distributeFilename.value.trim();
    const content = els.distributeContent.value;
    const overwrite = els.distributeOverwrite.checked;
    const commitMessage = els.distributeMessage.value.trim() || distributeFilenameDefaultMessage();
    const targets = state.distribute.repos
      .filter((r) => state.distribute.selected.has(r.nameWithOwner))
      .map((r) => ({ repo: r.nameWithOwner, defaultBranch: r.defaultBranch }));

    if (targets.length === 0 || !filename || !content.trim()) return;
    if (!/^[A-Za-z0-9._\-/]+\.md$/.test(filename)) {
      showToast('Filename must end with .md and contain only letters, digits, ., _, -, /', 'error');
      return;
    }
    if (filename.startsWith('/') || filename.includes('..')) {
      showToast('Filename must be a relative path without ".."', 'error');
      return;
    }

    state.distribute.pushing = true;
    els.distributingLabel.hidden = false;
    for (const t of targets) {
      state.distribute.statusByRepo.set(t.repo, { action: 'pushing' });
    }
    renderRepoList();
    updateDistributeControls();

    let data;
    try {
      const r = await fetch('/api/distribute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content, commitMessage, overwrite, repos: targets }),
      });
      data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    } catch (err) {
      state.distribute.pushing = false;
      els.distributingLabel.hidden = true;
      for (const t of targets) {
        state.distribute.statusByRepo.set(t.repo, { action: 'error', error: err.message });
      }
      renderRepoList();
      updateDistributeControls();
      showToast(`Distribute failed: ${err.message}`, 'error');
      return;
    }

    let created = 0, updated = 0, skipped = 0, failed = 0;
    for (const res of data.results) {
      if (!res.ok) {
        state.distribute.statusByRepo.set(res.repo, { action: 'error', error: res.error });
        failed++;
      } else if (res.action === 'created') {
        state.distribute.statusByRepo.set(res.repo, { action: 'created' });
        created++;
      } else if (res.action === 'updated') {
        state.distribute.statusByRepo.set(res.repo, { action: 'updated' });
        updated++;
      } else {
        state.distribute.statusByRepo.set(res.repo, { action: 'skipped' });
        skipped++;
      }
    }

    state.distribute.pushing = false;
    els.distributingLabel.hidden = true;
    renderRepoList();
    updateDistributeControls();

    const parts = [];
    if (created) parts.push(`${created} created`);
    if (updated) parts.push(`${updated} updated`);
    if (skipped) parts.push(`${skipped} skipped`);
    if (failed) parts.push(`${failed} failed`);
    showToast(`${data.filename}: ${parts.join(', ') || 'no changes'}`, failed ? 'error' : 'success');
  }

  // ── Wire events ──────────────────────────────────────────────────────
  function wire() {
    els.canonical.addEventListener('input', updateByteCount);
    els.btnSave.addEventListener('click', saveCanonical);
    els.btnScan.addEventListener('click', startScan);
    els.btnUpdateAll.addEventListener('click', () => {
      const out = state.scanResults
        .filter((r) => r.status === 'DIFFERENT' || r.status === 'MISSING')
        .map((r) => ({ repo: r.repo, defaultBranch: r.defaultBranch }));
      pushRepos(out);
    });
    els.btnClearLog.addEventListener('click', () => {
      els.logBody.innerHTML = '';
    });
    els.filterInput.addEventListener('input', (e) => {
      state.filterText = e.target.value;
      applyFilter();
    });

    els.tabSync.addEventListener('click', () => setView('sync'));
    els.tabDistribute.addEventListener('click', () => setView('distribute'));

    els.distributeFilename.addEventListener('input', () => {
      els.distributeMessage.placeholder = distributeFilenameDefaultMessage() || 'chore: add AGENTS.md [automated]';
      updateDistributeControls();
    });
    els.distributeContent.addEventListener('input', updateDistributeControls);
    els.distributeFilter.addEventListener('input', (e) => {
      state.distribute.filterText = e.target.value;
      renderRepoList();
    });
    els.btnSelectAll.addEventListener('click', () => {
      const q = state.distribute.filterText.toLowerCase().trim();
      for (const repo of state.distribute.repos) {
        if (!q || repo.nameWithOwner.toLowerCase().includes(q)) {
          state.distribute.selected.add(repo.nameWithOwner);
        }
      }
      renderRepoList();
    });
    els.btnSelectNone.addEventListener('click', () => {
      state.distribute.selected.clear();
      renderRepoList();
    });
    els.btnReloadRepos.addEventListener('click', () => loadRepos());
    els.btnDistribute.addEventListener('click', distributePush);

    document.addEventListener('keydown', (e) => {
      const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's';
      if (isSave && state.activeView === 'sync') {
        e.preventDefault();
        saveCanonical();
      }
    });

    els.hostBadge.textContent = location.host;
  }

  // ── Start ────────────────────────────────────────────────────────────
  wire();
  loadCanonical();
  pollLog();
  setInterval(pollLog, 1000);
})();
