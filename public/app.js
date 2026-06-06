const state = {
  token: localStorage.getItem("easylog.token") || "",
  user: null,
  projects: [],
  activeProjectId: localStorage.getItem("easylog.projectId") || "",
  logs: [],
  offset: 0,
  limit: 100,
  total: 0,
  autoRefreshTimer: null,
  filterRefreshTimer: null,
  logsLoading: false,
  statsLoading: false,
  lastStatsAt: 0
};

const el = {
  loginView: document.querySelector("#loginView"),
  appView: document.querySelector("#appView"),
  loginForm: document.querySelector("#loginForm"),
  loginError: document.querySelector("#loginError"),
  activeUser: document.querySelector("#activeUser"),
  projectList: document.querySelector("#projectList"),
  projectTitle: document.querySelector("#projectTitle"),
  projectMeta: document.querySelector("#projectMeta"),
  newProjectBtn: document.querySelector("#newProjectBtn"),
  usersBtn: document.querySelector("#usersBtn"),
  tokenBtn: document.querySelector("#tokenBtn"),
  logoutBtn: document.querySelector("#logoutBtn"),
  fromInput: document.querySelector("#fromInput"),
  toInput: document.querySelector("#toInput"),
  levelInput: document.querySelector("#levelInput"),
  qInput: document.querySelector("#qInput"),
  playerInput: document.querySelector("#playerInput"),
  sessionInput: document.querySelector("#sessionInput"),
  versionInput: document.querySelector("#versionInput"),
  platformInput: document.querySelector("#platformInput"),
  exportCsvBtn: document.querySelector("#exportCsvBtn"),
  exportJsonBtn: document.querySelector("#exportJsonBtn"),
  logRows: document.querySelector("#logRows"),
  emptyState: document.querySelector("#emptyState"),
  prevPageBtn: document.querySelector("#prevPageBtn"),
  nextPageBtn: document.querySelector("#nextPageBtn"),
  pageInfo: document.querySelector("#pageInfo"),
  statTotal: document.querySelector("#statTotal"),
  statErrors: document.querySelector("#statErrors"),
  statSessions: document.querySelector("#statSessions"),
  detailDrawer: document.querySelector("#detailDrawer"),
  detailMeta: document.querySelector("#detailMeta"),
  detailBody: document.querySelector("#detailBody"),
  closeDrawerBtn: document.querySelector("#closeDrawerBtn"),
  modalBackdrop: document.querySelector("#modalBackdrop"),
  modalTitle: document.querySelector("#modalTitle"),
  modalBody: document.querySelector("#modalBody"),
  closeModalBtn: document.querySelector("#closeModalBtn"),
  toast: document.querySelector("#toast")
};

init();

function init() {
  setDefaultDates();
  bindEvents();
  if (state.token) {
    boot();
  } else {
    showLogin();
  }
}

function bindEvents() {
  el.loginForm.addEventListener("submit", login);
  el.logoutBtn.addEventListener("click", logout);
  bindLiveFilters();
  el.prevPageBtn.addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - state.limit);
    loadLogs({ force: true });
  });
  el.nextPageBtn.addEventListener("click", () => {
    if (state.offset + state.limit < state.total) {
      state.offset += state.limit;
      loadLogs({ force: true });
    }
  });
  el.exportCsvBtn.addEventListener("click", () => exportLogs("csv"));
  el.exportJsonBtn.addEventListener("click", () => exportLogs("json"));
  el.newProjectBtn.addEventListener("click", openProjectModal);
  el.usersBtn.addEventListener("click", openUsersModal);
  el.tokenBtn.addEventListener("click", openTokenModal);
  el.closeDrawerBtn.addEventListener("click", closeDrawer);
  el.closeModalBtn.addEventListener("click", closeModal);
  el.modalBackdrop.addEventListener("click", (event) => {
    if (event.target === el.modalBackdrop) closeModal();
  });
}

function bindLiveFilters() {
  const fields = [
    el.fromInput,
    el.toInput,
    el.levelInput,
    el.qInput,
    el.playerInput,
    el.sessionInput,
    el.versionInput,
    el.platformInput
  ];

  for (const field of fields) {
    field.addEventListener("input", scheduleFilterRefresh);
    field.addEventListener("change", scheduleFilterRefresh);
  }
}

function scheduleFilterRefresh() {
  clearTimeout(state.filterRefreshTimer);
  state.filterRefreshTimer = setTimeout(() => {
    state.offset = 0;
    loadLogs({ force: true, refreshStats: true }).catch((error) => toast(error.message));
  }, 250);
}

function startAutoRefresh() {
  if (state.autoRefreshTimer) return;
  state.autoRefreshTimer = setInterval(() => {
    if (!state.token || !state.activeProjectId || el.appView.classList.contains("hidden")) return;
    loadLogs({ refreshStats: Date.now() - state.lastStatsAt > 5000 }).catch(() => {});
  }, 2000);
}

function stopAutoRefresh() {
  clearInterval(state.autoRefreshTimer);
  clearTimeout(state.filterRefreshTimer);
  state.autoRefreshTimer = null;
  state.filterRefreshTimer = null;
}

async function boot() {
  try {
    const me = await api("/api/me");
    state.user = me.user;
    await loadProjects();
    showApp();
  } catch {
    logout();
  }
}

async function login(event) {
  event.preventDefault();
  el.loginError.textContent = "";
  const form = new FormData(el.loginForm);
  try {
    const result = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password")
      })
    });
    state.token = result.token;
    state.user = result.user;
    localStorage.setItem("easylog.token", state.token);
    await loadProjects();
    showApp();
  } catch (error) {
    el.loginError.textContent = error.message;
  }
}

function logout() {
  stopAutoRefresh();
  state.token = "";
  state.user = null;
  localStorage.removeItem("easylog.token");
  showLogin();
}

async function loadProjects() {
  const result = await api("/api/projects");
  state.projects = result.projects;
  if (!state.projects.some((project) => project.id === state.activeProjectId)) {
    state.activeProjectId = state.projects[0]?.id || "";
  }
  if (state.activeProjectId) localStorage.setItem("easylog.projectId", state.activeProjectId);
  renderProjects();
  renderProjectHeader();
  if (state.activeProjectId) {
    await Promise.all([loadStats(), loadLogs({ force: true })]);
  } else {
    renderLogs();
  }
}

async function loadStats() {
  if (!state.activeProjectId) return;
  if (state.statsLoading) return;
  state.statsLoading = true;
  try {
    const stats = await api(`/api/projects/${state.activeProjectId}/stats`);
    el.statTotal.textContent = formatNumber(stats.total24h);
    el.statErrors.textContent = formatNumber(stats.errors24h);
    el.statSessions.textContent = formatNumber(stats.sessions24h);
    state.lastStatsAt = Date.now();
  } finally {
    state.statsLoading = false;
  }
}

async function loadLogs(options = {}) {
  const { force = false, refreshStats = false } = options;
  if (state.logsLoading && !force) return;
  if (!state.activeProjectId) {
    state.logs = [];
    state.total = 0;
    renderLogs();
    return;
  }
  state.logsLoading = true;
  try {
    const result = await api(`/api/projects/${state.activeProjectId}/logs?${queryString({ offset: state.offset, limit: state.limit })}`);
    state.logs = result.items;
    state.total = result.total;
    renderLogs();
  } finally {
    state.logsLoading = false;
  }
  if (refreshStats) await loadStats();
}

function renderProjects() {
  el.projectList.innerHTML = "";
  for (const project of state.projects) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `project-item ${project.id === state.activeProjectId ? "active" : ""}`;
    button.innerHTML = `<div><strong>${escapeHtml(project.name)}</strong><span>保留 ${project.retentionDays} 天</span></div>`;
    button.addEventListener("click", async () => {
      state.activeProjectId = project.id;
      state.offset = 0;
      localStorage.setItem("easylog.projectId", project.id);
      renderProjects();
      renderProjectHeader();
      await Promise.all([loadStats(), loadLogs({ force: true })]);
    });
    el.projectList.appendChild(button);
  }
}

function renderProjectHeader() {
  const project = activeProject();
  el.projectTitle.textContent = project ? project.name : "Logs";
  el.projectMeta.textContent = project ? `${project.tokens.length} 个接入 Token · 保留 ${project.retentionDays} 天` : "创建项目后即可开始接收日志。";
  const admin = state.user?.role === "admin";
  el.newProjectBtn.disabled = !admin;
  el.usersBtn.disabled = !admin;
  el.tokenBtn.disabled = !admin || !project;
}

function renderLogs() {
  el.logRows.innerHTML = "";
  el.emptyState.classList.toggle("hidden", state.logs.length > 0);
  for (const log of state.logs) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="mono">${escapeHtml(formatTime(log.timestamp))}</td>
      <td><span class="level-pill level-${escapeHtml(log.level)}">${escapeHtml(log.level)}</span></td>
      <td class="message-cell">${escapeHtml(log.message || "(empty)")}</td>
      <td>${escapeHtml(log.playerId || "")}</td>
      <td>${escapeHtml(log.sessionId || "")}</td>
      <td>${escapeHtml(log.buildVersion || "")}</td>
      <td>${escapeHtml(log.platform || "")}</td>
      <td>${escapeHtml(log.scene || "")}</td>
    `;
    row.addEventListener("click", () => openDetail(log));
    el.logRows.appendChild(row);
  }
  el.pageInfo.textContent = `${formatNumber(state.total)} 条结果 · 显示 ${state.offset + 1}-${Math.min(state.offset + state.logs.length, state.total) || 0}`;
  el.prevPageBtn.disabled = state.offset === 0;
  el.nextPageBtn.disabled = state.offset + state.limit >= state.total;
}

function openDetail(log) {
  el.detailMeta.textContent = `${formatTime(log.timestamp)} · ${log.level}`;
  el.detailBody.innerHTML = `
    <dl class="detail-grid">
      ${detailRow("ID", log.id)}
      ${detailRow("Event ID", log.eventId)}
      ${detailRow("Project", log.projectId)}
      ${detailRow("Received", formatTime(log.receivedAt))}
      ${detailRow("Player", log.playerId)}
      ${detailRow("Session", log.sessionId)}
      ${detailRow("Version", log.buildVersion)}
      ${detailRow("Platform", log.platform)}
      ${detailRow("Scene", log.scene)}
      ${detailRow("Category", log.category)}
      ${detailRow("Device", log.deviceId)}
    </dl>
    <div class="detail-section-title">
      <h3>Message</h3>
      ${detailCopyButton("message", "消息")}
    </div>
    <textarea id="detailMessageValue" class="detail-pre detail-textarea" readonly rows="5">${escapeHtml(log.message || "")}</textarea>
    <div class="detail-section-title">
      <h3>StackTrace</h3>
      ${detailCopyButton("stackTrace", "堆栈")}
    </div>
    <textarea id="detailStackTraceValue" class="detail-pre detail-textarea" readonly rows="8">${escapeHtml(log.stackTrace || "")}</textarea>
    <h3>Custom</h3>
    <pre class="detail-pre">${escapeHtml(JSON.stringify(log.custom || {}, null, 2))}</pre>
  `;
  bindDetailCopyButton("message", log.message || "", "#detailMessageValue");
  bindDetailCopyButton("stackTrace", log.stackTrace || "", "#detailStackTraceValue");
  el.detailDrawer.classList.remove("hidden");
}

function closeDrawer() {
  el.detailDrawer.classList.add("hidden");
}

function detailRow(label, value) {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "")}</dd>`;
}

function detailCopyButton(field, label) {
  return `
    <button class="icon-button detail-copy-btn" data-copy-field="${escapeHtml(field)}" title="复制${escapeHtml(label)}" aria-label="复制${escapeHtml(label)}" type="button">
      <span class="copy-icon" aria-hidden="true"></span>
    </button>
  `;
}

function bindDetailCopyButton(field, value, sourceSelector) {
  const button = el.detailBody.querySelector(`[data-copy-field="${field}"]`);
  if (!button) return;
  button.addEventListener("click", async () => {
    if (!value) {
      toast("没有可复制的内容。");
      return;
    }
    const copied = await copyText(value, el.detailBody.querySelector(sourceSelector));
    toast(copied ? "已复制。" : "已选中文本，请按 Ctrl+C 复制。");
  });
}

function openProjectModal() {
  openModal("新建项目", `
    <form id="projectForm" class="form-grid">
      <label>Name<input name="name" required placeholder="Space Arena"></label>
      <label>Retention days<input name="retentionDays" type="number" min="1" max="365" value="30"></label>
      <button class="primary" type="submit">创建</button>
    </form>
  `);
  document.querySelector("#projectForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        retentionDays: Number(form.get("retentionDays"))
      })
    });
    state.activeProjectId = result.project.id;
    closeModal();
    await loadProjects();
    toast("项目已创建。");
  });
}

async function openUsersModal() {
  const result = await api("/api/users");
  openModal("用户", `
    <form id="userForm" class="form-grid">
      <label>Email<input name="email" type="email" required></label>
      <label>Name<input name="name"></label>
      <label>Role
        <select name="role">
          <option value="developer">Developer</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <label>Password<input name="password" type="password" minlength="8" required></label>
      <button class="primary" type="submit">创建用户</button>
    </form>
    <div class="list">
      ${result.users.map((user) => `<div class="list-row"><strong>${escapeHtml(user.name)}</strong><span>${escapeHtml(user.email)} · ${escapeHtml(user.role)}</span></div>`).join("")}
    </div>
  `);
  document.querySelector("#userForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/users", {
      method: "POST",
      body: JSON.stringify({
        email: form.get("email"),
        name: form.get("name"),
        role: form.get("role"),
        password: form.get("password")
      })
    });
    closeModal();
    await openUsersModal();
    toast("用户已创建。");
  });
}

function renderTokenRows(project) {
  if (!project.tokens.length) {
    return '<div class="list-row"><span>还没有 Token。</span></div>';
  }

  return project.tokens.map((token) => `
    <div class="list-row token-row">
      <div>
        <strong>${escapeHtml(displayTokenName(token.name))}</strong>
        <span>${escapeHtml(token.prefix)}... &middot; ${formatTime(token.createdAt)}</span>
      </div>
      <div class="token-row-actions">
        <button class="token-copy-existing-btn" data-token-id="${escapeHtml(token.id)}" ${token.canCopy ? "" : "disabled"} title="${token.canCopy ? "复制 Token" : "旧 Token 无法复制，请生成新的 Token。"}" type="button">复制</button>
        <button class="danger token-delete-btn" data-token-id="${escapeHtml(token.id)}" type="button">删除</button>
      </div>
    </div>
  `).join("");
}

function openTokenModal() {
  const project = activeProject();
  if (!project) return;
  openModal("接入 Token", `
    <form id="tokenForm" class="form-grid">
      <label>名称<input name="name" value="Unity 客户端"></label>
      <button class="primary" type="submit">生成 Token</button>
    </form>
    <p id="tokenError" class="error-line"></p>
    <div id="newTokenBox"></div>
    <div id="tokenList" class="list">
      ${renderTokenRows(project)}
    </div>
  `);
  document.querySelector("#tokenForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type='submit']");
    const error = document.querySelector("#tokenError");
    error.textContent = "";
    button.disabled = true;
    const form = new FormData(event.currentTarget);
    try {
      const result = await api(`/api/projects/${project.id}/tokens`, {
        method: "POST",
        body: JSON.stringify({ name: form.get("name") })
      });
      showCopyableToken(result.token, result.tokenInfo.id);
      await loadProjects();
      refreshTokenList();
      toast("Token 已生成。");
    } catch (caught) {
      error.textContent = caught.message;
    } finally {
      button.disabled = false;
    }
  });
  bindTokenCopyHandlers();
  bindTokenDeleteHandlers();
}

function displayTokenName(name) {
  return name === "Unity client" ? "Unity 客户端" : name;
}

function refreshTokenList() {
  const tokenList = document.querySelector("#tokenList");
  const project = activeProject();
  if (!tokenList || !project) return;
  tokenList.innerHTML = renderTokenRows(project);
  bindTokenCopyHandlers();
  bindTokenDeleteHandlers();
  renderProjectHeader();
}

function bindTokenCopyHandlers() {
  for (const button of document.querySelectorAll(".token-copy-existing-btn")) {
    button.addEventListener("click", async () => {
      const project = activeProject();
      const tokenId = button.dataset.tokenId;
      if (!project || !tokenId) return;

      const error = document.querySelector("#tokenError");
      if (error) error.textContent = "";
      button.disabled = true;
      try {
        const result = await api(`/api/projects/${project.id}/tokens/${tokenId}/reveal`);
        showCopyableToken(result.token, result.tokenInfo.id);
        const copied = await copyText(result.token, document.querySelector("#newTokenValue"));
        toast(copied ? "Token 已复制。" : "Token 已选中，请按 Ctrl+C 复制。");
      } catch (caught) {
        if (error) error.textContent = caught.message;
      } finally {
        button.disabled = false;
      }
    });
  }
}

function bindTokenDeleteHandlers() {
  for (const button of document.querySelectorAll(".token-delete-btn")) {
    button.addEventListener("click", async () => {
      const project = activeProject();
      const tokenId = button.dataset.tokenId;
      if (!project || !tokenId) return;
      if (!confirm("确定删除这个接入 Token 吗？正在使用它的客户端将停止上传日志。")) return;

      button.disabled = true;
      try {
        await api(`/api/projects/${project.id}/tokens/${tokenId}`, { method: "DELETE" });
        await loadProjects();
        const newTokenBox = document.querySelector("#newTokenBox .token-box");
        if (newTokenBox?.dataset.tokenId === tokenId) {
          document.querySelector("#newTokenBox").innerHTML = "";
        }
        refreshTokenList();
        toast("Token 已删除。");
      } catch (caught) {
        const error = document.querySelector("#tokenError");
        if (error) error.textContent = caught.message;
        button.disabled = false;
      }
    });
  }
}

function showCopyableToken(token, tokenId) {
  document.querySelector("#newTokenBox").innerHTML = `
    <div class="token-box" data-token-id="${escapeHtml(tokenId)}">
      <strong>复制新 Token</strong>
      <textarea id="newTokenValue" class="token-value mono" readonly rows="3">${escapeHtml(token)}</textarea>
      <button id="copyTokenBtn" type="button">复制</button>
    </div>
  `;
  document.querySelector("#copyTokenBtn").addEventListener("click", async () => {
    const copied = await copyText(token, document.querySelector("#newTokenValue"));
    toast(copied ? "Token 已复制。" : "Token 已选中，请按 Ctrl+C 复制。");
  });
}

async function copyText(text, sourceElement = null) {
  if (window.navigator?.clipboard?.writeText) {
    try {
      await window.navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the textarea fallback.
    }
  }

  const textarea = sourceElement || document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  if (!sourceElement) {
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
  }
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    if (!sourceElement) textarea.remove();
  }
}

function openModal(title, body) {
  el.modalTitle.textContent = title;
  el.modalBody.innerHTML = body;
  el.modalBackdrop.classList.remove("hidden");
}

function closeModal() {
  el.modalBackdrop.classList.add("hidden");
}

async function exportLogs(format) {
  if (!state.activeProjectId) return;
  const url = `/api/projects/${state.activeProjectId}/export?${queryString({ format, maxRows: 10000 })}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${state.token}`
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    toast(body?.error?.message || "导出失败。");
    return;
  }

  const blob = await response.blob();
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = `easylog-${state.activeProjectId}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(downloadUrl);
}

async function api(url, options = {}) {
  return request(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${state.token}`
    }
  });
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(body?.error?.message || response.statusText);
  }
  return body;
}

function queryString(extra = {}) {
  const params = new URLSearchParams();
  const fields = {
    from: localDateToIso(el.fromInput.value),
    to: localDateToIso(el.toInput.value),
    level: el.levelInput.value,
    q: el.qInput.value,
    playerId: el.playerInput.value,
    sessionId: el.sessionInput.value,
    buildVersion: el.versionInput.value,
    platform: el.platformInput.value,
    ...extra
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== "" && value != null) params.set(key, value);
  }
  return params.toString();
}

function activeProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

function showLogin() {
  el.loginView.classList.remove("hidden");
  el.appView.classList.add("hidden");
}

function showApp() {
  el.activeUser.textContent = `${state.user.email} · ${state.user.role}`;
  el.loginView.classList.add("hidden");
  el.appView.classList.remove("hidden");
  renderProjectHeader();
  startAutoRefresh();
}

function setDefaultDates() {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  el.fromInput.value = toDateTimeLocal(hourAgo);
  el.toInput.value = "";
}

function toDateTimeLocal(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function localDateToIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTimeWithMilliseconds(date);
}

function formatDateTimeWithMilliseconds(date) {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());
  const millisecond = String(date.getMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}.${millisecond}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.add("hidden"), 2400);
}
