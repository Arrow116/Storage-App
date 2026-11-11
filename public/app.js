const $ = (id) => document.getElementById(id);

const state = { prefix: "", listing: null };

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const init = { method: options.method ?? "GET", headers: {} };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/login") showLogin();
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function showError(node, message) {
  node.textContent = message ?? "";
  node.hidden = !message;
}

// ---------- session ----------

function showLogin() {
  $("app-view").hidden = true;
  $("login-view").hidden = false;
}

function showApp(username) {
  $("login-view").hidden = true;
  $("app-view").hidden = false;
  $("whoami").textContent = username;
  state.prefix = prefixFromHash();
  refresh();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  showError($("login-error"));
  try {
    const session = await api("/api/login", {
      method: "POST",
      body: { username: form.username.value, password: form.password.value },
    });
    form.reset();
    showApp(session.username);
  } catch (err) {
    showError($("login-error"), err.message);
  }
});

$("logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// ---------- navigation ----------

function prefixFromHash() {
  try {
    const path = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
    return path && !path.endsWith("/") ? `${path}/` : path;
  } catch {
    return "";
  }
}

function navigate(prefix) {
  location.hash = `#/${prefix.split("/").map(encodeURIComponent).join("/")}`;
}

window.addEventListener("hashchange", () => {
  if ($("app-view").hidden) return;
  state.prefix = prefixFromHash();
  refresh();
});

function renderBreadcrumbs() {
  const nav = $("breadcrumbs");
  nav.replaceChildren();
  const parts = state.prefix.split("/").filter(Boolean);
  const crumbs = [{ name: "All files", prefix: "" }];
  parts.forEach((name, i) => crumbs.push({ name, prefix: `${parts.slice(0, i + 1).join("/")}/` }));
  crumbs.forEach((crumb, i) => {
    if (i > 0) nav.append(el("span", { class: "sep" }, "/"));
    const last = i === crumbs.length - 1;
    const button = el("button", { type: "button", onclick: () => !last && navigate(crumb.prefix) }, crumb.name);
    if (last) button.setAttribute("aria-current", "page");
    nav.append(button);
  });
}

// ---------- listing ----------

async function refresh() {
  renderBreadcrumbs();
  const prefix = state.prefix;
  const status = $("status");
  if (!state.listing || state.listing.prefix !== prefix) {
    $("rows").replaceChildren();
    status.textContent = "Loading…";
  }
  try {
    const listing = await api(`/api/files?prefix=${encodeURIComponent(prefix)}`);
    if (prefix !== state.prefix) return; // navigated away while loading
    state.listing = listing;
    renderRows(listing);
  } catch (err) {
    if (err.status === 401) return;
    $("rows").replaceChildren();
    status.textContent = `Could not load this folder: ${err.message}`;
  }
}

function downloadUrl(key, inline) {
  return `/api/download?key=${encodeURIComponent(key)}${inline ? "&inline=1" : ""}`;
}

function renderRows(listing) {
  const rows = $("rows");
  rows.replaceChildren();
  for (const folder of listing.folders) {
    rows.append(
      el(
        "tr",
        {},
        el(
          "td",
          { class: "name" },
          el("button", { type: "button", onclick: () => navigate(folder.key) }, el("span", { class: "icon" }, "📁"), folder.name),
        ),
        el("td", { class: "num muted" }, "—"),
        el("td", { class: "when" }),
        el(
          "td",
          { class: "actions" },
          el("button", { class: "link danger", type: "button", onclick: () => removeItem(folder.key, folder.name, true) }, "Delete"),
        ),
      ),
    );
  }
  for (const file of listing.files) {
    rows.append(
      el(
        "tr",
        {},
        el(
          "td",
          { class: "name" },
          el(
            "button",
            { type: "button", title: "Open", onclick: () => window.open(downloadUrl(file.key, true), "_blank", "noopener") },
            el("span", { class: "icon" }, "📄"),
            file.name,
          ),
        ),
        el("td", { class: "num" }, formatSize(file.size)),
        el("td", { class: "when muted" }, formatDate(file.lastModified)),
        el(
          "td",
          { class: "actions" },
          el("a", { href: downloadUrl(file.key, false), download: file.name }, el("button", { class: "link", type: "button", tabIndex: -1 }, "Download")),
          el("button", { class: "link", type: "button", onclick: () => openShare(file) }, "Share"),
          el("button", { class: "link danger", type: "button", onclick: () => removeItem(file.key, file.name, false) }, "Delete"),
        ),
      ),
    );
  }
  const empty = listing.folders.length + listing.files.length === 0;
  $("status").textContent = empty ? "This folder is empty. Upload files or create a folder." : "";
}

async function removeItem(key, name, isFolder) {
  const message = isFolder ? `Delete the folder "${name}" and everything inside it?` : `Delete "${name}"?`;
  if (!confirm(message)) return;
  try {
    await api(`/api/files?key=${encodeURIComponent(key)}`, { method: "DELETE" });
  } catch (err) {
    if (err.status !== 401) alert(`Could not delete "${name}": ${err.message}`);
  }
  refresh();
}

// ---------- uploads ----------

const queue = [];
let active = 0;
const MAX_PARALLEL = 3;

function enqueue(files) {
  const existing = new Set((state.listing?.files ?? []).map((f) => f.name));
  for (const file of files) {
    if (existing.has(file.name) && !confirm(`"${file.name}" already exists here. Replace it?`)) continue;
    const progress = el("progress", { max: 1, value: 0 });
    const stateLabel = el("span", { class: "state muted" }, "Waiting");
    const dismiss = el("button", { class: "link", type: "button", hidden: true }, "Dismiss");
    const row = el("li", {}, el("span", { class: "fname" }, file.name), stateLabel, dismiss, progress);
    dismiss.addEventListener("click", () => row.remove());
    $("uploads").append(row);
    queue.push({ file, prefix: state.prefix, row, progress, stateLabel, dismiss });
  }
  pump();
}

function pump() {
  while (active < MAX_PARALLEL && queue.length > 0) {
    const job = queue.shift();
    active++;
    uploadOne(job).finally(() => {
      active--;
      pump();
    });
  }
}

function uploadOne(job) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/files?key=${encodeURIComponent(job.prefix + job.file.name)}`);
    xhr.setRequestHeader("Content-Type", job.file.type || "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      job.progress.value = event.loaded / event.total;
      job.stateLabel.textContent =
        event.loaded === event.total ? "Finishing…" : `${formatSize(event.loaded)} of ${formatSize(event.total)}`;
    });
    const fail = (message) => {
      job.row.classList.add("failed");
      job.stateLabel.textContent = message;
      job.dismiss.hidden = false;
      resolve();
    };
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        job.row.remove();
        if (job.prefix === state.prefix) refresh();
        resolve();
        return;
      }
      if (xhr.status === 401) showLogin();
      let message = xhr.status === 413 ? "File exceeds the upload size limit" : `Upload failed (${xhr.status})`;
      try {
        message = JSON.parse(xhr.responseText).error ?? message;
      } catch {}
      fail(message);
    });
    xhr.addEventListener("error", () => fail("Upload failed: connection lost"));
    job.stateLabel.textContent = "Starting…";
    xhr.send(job.file);
  });
}

$("upload").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (event) => {
  enqueue([...event.target.files]);
  event.target.value = "";
});

const dropzone = $("dropzone");
let dragDepth = 0;
dropzone.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth++;
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragover", (event) => event.preventDefault());
dropzone.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropzone.classList.remove("dragover");
  }
});
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove("dragover");
  // Dropped directories show up as zero-size entries with no type; skip them.
  const files = [...event.dataTransfer.items]
    .filter((item) => item.kind === "file" && !item.webkitGetAsEntry?.()?.isDirectory)
    .map((item) => item.getAsFile())
    .filter(Boolean);
  enqueue(files);
});

// ---------- new folder ----------

$("new-folder").addEventListener("click", () => {
  $("folder-name").value = "";
  showError($("folder-error"));
  $("folder-dialog").showModal();
});
$("folder-cancel").addEventListener("click", () => $("folder-dialog").close());
$("folder-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("folder-name").value.trim();
  if (name.includes("/")) return showError($("folder-error"), "Folder names cannot contain a slash.");
  try {
    await api("/api/folders", { method: "POST", body: { key: `${state.prefix}${name}/` } });
    $("folder-dialog").close();
    refresh();
  } catch (err) {
    showError($("folder-error"), err.message);
  }
});

// ---------- share ----------

let shareKey = null;

function openShare(file) {
  shareKey = file.key;
  $("share-name").textContent = file.name;
  $("share-url").hidden = true;
  $("share-note").hidden = true;
  $("share-copy").hidden = true;
  $("share-create").hidden = false;
  $("share-copy").textContent = "Copy link";
  showError($("share-error"));
  $("share-dialog").showModal();
}

$("share-expiry").addEventListener("change", () => {
  $("share-url").hidden = true;
  $("share-note").hidden = true;
  $("share-copy").hidden = true;
  $("share-create").hidden = false;
});

$("share-create").addEventListener("click", async () => {
  showError($("share-error"));
  try {
    const { url } = await api("/api/share", {
      method: "POST",
      body: { key: shareKey, expiresIn: Number($("share-expiry").value) },
    });
    $("share-url").value = url;
    $("share-url").hidden = false;
    $("share-note").hidden = false;
    $("share-create").hidden = true;
    $("share-copy").hidden = false;
    $("share-url").select();
  } catch (err) {
    showError($("share-error"), err.message);
  }
});

$("share-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("share-url").value);
    $("share-copy").textContent = "Copied";
  } catch {
    $("share-url").select(); // clipboard API needs HTTPS; leave the link selected for manual copy
  }
});

// ---------- boot ----------

api("/api/session").then(
  (session) => (session.authenticated ? showApp(session.username) : showLogin()),
  () => showLogin(),
);
