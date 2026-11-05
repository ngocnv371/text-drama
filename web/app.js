const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mmss = (s) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const PROVIDER_LABEL = { deepseek: "DeepSeek", gemini: "Gemini", claude: "Claude" };

let episodes = [];
let providers = {};
let config = null;
let open = null;      // episode shown in the viewer
let polling = null;
let workspaces = [];
let ws = null;        // current workspace id

// Every request names the workspace it's about.
async function api(path, options = {}) {
  const url = ws ? `${path}${path.includes("?") ? "&" : "?"}ws=${encodeURIComponent(ws)}` : path;
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...options });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// ---- settings

function providerOptions(select, { includeConfig }) {
  const opts = [];
  if (includeConfig) opts.push(["config", `Series default (${config.llm.provider})`]);
  opts.push(["auto", "Auto (first key found)"]);
  for (const [name, label] of Object.entries(PROVIDER_LABEL)) {
    opts.push([name, providers[name] ? label : `${label} (no key)`, !providers[name]]);
  }
  select.innerHTML = opts.map(([v, l, off]) => `<option value="${v}"${off ? " disabled" : ""}>${esc(l)}</option>`).join("");
}

// ---- workspaces

const savedWorkspace = () => { try { return localStorage.getItem("workspace"); } catch { return null; } };

async function loadWorkspaces() {
  workspaces = await api("/api/workspaces");
  const wanted = decodeURIComponent(location.hash.slice(1)) || savedWorkspace();
  if (!ws) ws = workspaces.some((w) => w.id === wanted) ? wanted : (workspaces.find((w) => w.isDefault) ?? workspaces[0])?.id;
  $("workspace").innerHTML = workspaces.map((w) => `<option value="${esc(w.id)}">${esc(w.name)} (${w.episodes})</option>`).join("") +
    `<option value="__new">+ New workspace…</option>`;
  $("workspace").value = ws;
}

async function switchWorkspace(id) {
  ws = id;
  try { localStorage.setItem("workspace", id); } catch { /* private window */ }
  history.replaceState(null, "", `#${encodeURIComponent(id)}`);
  if ($("viewer").open) $("viewer").close();
  await loadConfig();
  await loadEpisodes();
}

$("workspace").addEventListener("change", async () => {
  if ($("workspace").value === "__new") {
    $("workspace").value = ws;
    $("newWsError").textContent = "";
    $("newWsDialog").showModal();
    return;
  }
  await switchWorkspace($("workspace").value);
});

// Suggest a folder id from the name: "Sinh Tồn Nơi Công Sở" -> "sinh-ton-noi-cong-so".
$("newWsName").addEventListener("input", () => {
  $("newWsId").value = $("newWsName").value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
});

$("newWsCreate").addEventListener("click", async (e) => {
  e.preventDefault();
  try {
    const { id } = await api("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ id: $("newWsId").value.trim(), name: $("newWsName").value, topic: $("newWsTopic").value, from: ws }),
    });
    $("newWsDialog").close();
    ws = id;
    await loadWorkspaces();
    await switchWorkspace(id);
  } catch (err) {
    $("newWsError").textContent = err.message;
  }
});

// ---- settings form

async function loadConfig() {
  ({ config, providers } = await api("/api/config"));
  $("topicChip").textContent = config.topic;
  $("seriesName").value = config.name ?? "";
  $("language").value = config.language ?? "";
  $("topic").value = config.topic;
  $("app").value = config.app ?? "imessage";
  $("tone").value = config.tone;
  $("seconds").value = config.targetSeconds;
  $("secondsLabel").textContent = `${config.targetSeconds}s`;
  providerOptions($("provider"), { includeConfig: true });
  providerOptions($("defaultProvider"), { includeConfig: false });
  $("defaultProvider").value = config.llm.provider;
}

$("seconds").addEventListener("input", () => { $("secondsLabel").textContent = `${$("seconds").value}s`; });

$("saveBtn").addEventListener("click", async () => {
  try {
    await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ name: $("seriesName").value, topic: $("topic").value, language: $("language").value, app: $("app").value, tone: $("tone").value, targetSeconds: +$("seconds").value, provider: $("defaultProvider").value }),
    });
    await loadConfig();
    await loadWorkspaces();
    $("saved").textContent = "Saved. New episodes will use these settings.";
    setTimeout(() => ($("saved").textContent = ""), 3000);
  } catch (err) {
    $("saved").textContent = err.message;
  }
});

// ---- episodes

function renderGrid() {
  $("count").textContent = episodes.length ? `${episodes.length}` : "";
  if (!episodes.length) {
    $("grid").innerHTML = `<div class="empty">No episodes yet. Press <b>Generate episode</b> to make the first one.</div>`;
    return;
  }
  $("grid").innerHTML = episodes.map((ep) => {
    const provider = ep.meta?.provider;
    return `<article class="ep" data-id="${esc(ep.id)}">
      <div class="thumb">
        ${ep.video ? `<video src="${esc(ep.video)}#t=1.2" preload="metadata" muted playsinline></video><div class="play">▶</div>` : `<div class="pending">not rendered</div>`}
        ${ep.video ? "" : `<div class="hook">${esc(ep.hook)}</div>`}
      </div>
      <div class="ep-body">
        <div class="ep-title">${esc(ep.title)}</div>
        <div class="ep-meta">
          <span class="tag">${esc(ep.id)}</span>
          ${provider ? `<span class="tag ${esc(provider)}">${esc(PROVIDER_LABEL[provider] ?? provider)}</span>` : ""}
          <span class="tag">${ep.app === "workchat" ? "work chat" : "texts"}</span>
          ${ep.seconds ? `<span class="tag">${mmss(ep.seconds)}</span>` : `<span class="tag">${ep.messages.length} msgs</span>`}
        </div>
      </div>
    </article>`;
  }).join("");
}

async function loadEpisodes() {
  episodes = await api("/api/episodes");
  renderGrid();
  if (open) {
    const fresh = episodes.find((e) => e.id === open.id);
    if (fresh) showEpisode(fresh, { keepOpen: true });
  }
}

$("grid").addEventListener("click", (e) => {
  const card = e.target.closest(".ep");
  if (card) showEpisode(episodes.find((ep) => ep.id === card.dataset.id));
});

// ---- viewer

function showEpisode(ep, { keepOpen } = {}) {
  open = ep;
  $("viewerId").textContent = [ep.id, ep.meta && `${PROVIDER_LABEL[ep.meta.provider] ?? ep.meta.provider} · ${ep.meta.model}`].filter(Boolean).join(" · ");
  $("viewerTitle").textContent = ep.title;
  $("viewerLogline").textContent = ep.logline ?? "";
  const video = $("viewerVideo");
  if (ep.video) {
    if (!video.src.endsWith(ep.video)) video.src = ep.video;
    video.hidden = false;
    $("viewerNoVideo").hidden = true;
    $("downloadBtn").href = ep.video.split("?")[0];
    $("downloadBtn").setAttribute("download", `${ep.id}.mp4`);
    $("downloadBtn").hidden = false;
  } else {
    video.removeAttribute("src");
    video.hidden = true;
    $("viewerNoVideo").hidden = false;
    $("downloadBtn").hidden = true;
  }
  const names = Object.fromEntries(ep.cast.map((c) => [c.id, c.name]));
  const roles = Object.fromEntries(ep.cast.map((c) => [c.id, c.role]));
  const showNames = ep.cast.length > 2;
  $("transcript").innerHTML = ep.messages.map((m) => {
    const beat = m.beat !== "normal" ? `<span class="beat">${esc(m.beat)}</span>` : "";
    if (m.type === "system") return `<div class="sys">${esc(m.text)}${beat}</div>`;
    const side = m.from === "me" ? "me" : "them";
    const role = roles[m.from] ? ` · ${esc(roles[m.from])}` : "";
    const who = showNames && side === "them" ? `<span class="who">${esc(names[m.from] ?? m.from)}${role}</span>` : "";
    const rx = m.reactions?.length ? `<span class="rxs">${m.reactions.map((r) => `<span>${esc(r.emoji)} ${r.count}</span>`).join("")}</span>` : "";
    return `<div class="msg ${side} ${esc(m.beat)}">${who}${esc(m.text)}${beat}${rx}</div>`;
  }).join("") + `<div class="cliff">${esc(ep.cliffhanger)}</div>`;
  $("rerenderBtn").disabled = !!polling;
  if (!keepOpen) {
    $("viewer").showModal();
    if (ep.video) video.play().catch(() => {});
  }
}

$("closeViewer").addEventListener("click", () => $("viewer").close());
$("viewer").addEventListener("click", (e) => { if (e.target === $("viewer")) $("viewer").close(); });
$("viewer").addEventListener("close", () => { $("viewerVideo").pause(); open = null; });

$("rerenderBtn").addEventListener("click", async () => {
  if (!open) return;
  try {
    await api(`/api/episodes/${encodeURIComponent(open.id)}/render`, { method: "POST" });
    $("viewer").close();
    watchJob();
  } catch (err) { alert(err.message); }
});

// ---- generate (one episode or a batch) + job progress

function batchSize() {
  const lines = $("premise").value.split(/\r?\n/).filter((l) => l.trim()).length;
  return Math.min(50, Math.max(lines, +$("count").value || 1));
}
function updateGenerateLabel() {
  const n = batchSize();
  $("generateBtn").textContent = n === 1 ? "Generate episode" : `Generate ${n} episodes`;
}
$("count").addEventListener("input", updateGenerateLabel);
$("premise").addEventListener("input", updateGenerateLabel);

$("generateBtn").addEventListener("click", async () => {
  try {
    await api("/api/generate", { method: "POST", body: JSON.stringify({ premises: $("premise").value, count: batchSize(), provider: $("provider").value }) });
    $("premise").value = "";
    $("count").value = 1;
    updateGenerateLabel();
    watchJob();
  } catch (err) {
    alert(err.message);
  }
});

$("stopBtn").addEventListener("click", async () => {
  try { await api("/api/job/stop", { method: "POST" }); } catch (err) { alert(err.message); }
});

$("queue").addEventListener("click", (e) => {
  const li = e.target.closest("li.done");
  const ep = li && episodes.find((x) => x.id === li.dataset.id);
  if (ep) showEpisode(ep);
});

const STATE_LABEL = { queued: "queued", running: "working", done: "ready", failed: "failed", skipped: "skipped" };

function renderJob(job) {
  if (!job) { $("job").hidden = true; return; }
  $("job").hidden = false;
  const items = job.items;
  const current = items[job.index];
  const finished = items.filter((it) => it.state === "done").length;
  const failed = items.filter((it) => it.state === "failed").length;
  const batch = items.length > 1;
  // A job keeps running when you switch workspace; say where it is.
  const where = job.ws !== ws ? ` (in ${workspaces.find((w) => w.id === job.ws)?.name ?? job.ws})` : "";

  // header + queue
  if (job.running) $("jobTitle").textContent = (batch ? `Episode ${job.index + 1} of ${items.length}` : job.kind === "render" ? `Re-rendering ${current?.id ?? ""}` : "New episode") + where;
  else $("jobTitle").textContent = batch ? `Batch finished: ${finished} of ${items.length} made${where}` : where.trim();
  $("stopBtn").hidden = !(job.running && batch && !job.stopRequested && items.some((it) => it.state === "queued"));
  $("queue").hidden = !batch;
  $("queue").innerHTML = items.map((it) => {
    const what = it.title ? `${it.id} · ${it.title}` : it.id ? `${it.id}${it.premise ? ` · ${it.premise}` : ""}` : (it.premise || "writer's choice");
    return `<li class="${it.state}" data-id="${esc(it.id ?? "")}" title="${esc(it.error ?? "")}"><span class="dot"></span><span class="what">${esc(what)}</span><span class="st">${STATE_LABEL[it.state]}</span></li>`;
  }).join("");

  // current item's stages and progress
  const stage = job.running ? job.stage : current?.state === "failed" ? "failed" : "done";
  const order = ["writing", "rendering", "done"];
  const at = stage === "failed" ? -1 : order.indexOf(stage);
  document.querySelectorAll(".stages span").forEach((s) => {
    const i = order.indexOf(s.dataset.stage);
    s.className = at < 0 ? "" : i < at || stage === "done" ? "complete" : i === at ? "active" : "";
  });
  const bar = $("bar").parentElement;
  bar.classList.toggle("indeterminate", job.running && job.progress == null);
  $("bar").style.width = job.running ? (job.progress == null ? "" : `${Math.round(job.progress * 100)}%`) : "100%";
  $("bar").style.background = stage === "failed" ? "var(--danger)" : stage === "done" ? "var(--ok)" : "";

  const status = $("jobStatus");
  const label = job.kind === "render" ? `Re-rendering ${current?.id ?? ""}` : current?.id ? `Episode ${current.id}` : "New episode";
  if (!job.running) {
    status.className = `job-status ${failed ? "failed" : "done"}`;
    if (batch) {
      const stopped = items.filter((it) => it.state === "skipped").length;
      status.textContent = [failed ? `${failed} failed (hover a red row to see why).` : "All episodes are ready.", stopped ? `${stopped} skipped after Stop.` : ""].filter(Boolean).join(" ");
    } else {
      status.textContent = current?.state === "failed" ? `${label} failed:\n${current.error ?? ""}` : `${label} is ready.`;
    }
  } else {
    status.className = "job-status";
    if (job.stage === "rendering") {
      status.textContent = `${label}: rendering video${job.progress != null ? ` ${Math.round(job.progress * 100)}%` : ""}…`;
    } else {
      const last = [...job.lines].reverse().find((l) => /attempt|failed \d+ check/.test(l));
      status.textContent = `${label}: writing the script${last ? `\n${last.replace(/^\[[^\]]+\]\s*/, "")}` : "…"}`;
    }
    if (job.stopRequested) status.textContent += "\nStopping after this episode.";
  }

  const log = $("log");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.textContent = job.lines.join("\n");
  if (atBottom) log.scrollTop = log.scrollHeight;

  $("generateBtn").disabled = job.running;
  $("rerenderBtn").disabled = job.running;
}

async function watchJob() {
  if (polling) return;
  let doneSeen = -1;
  const tick = async () => {
    const job = await api("/api/job").catch(() => null);
    renderJob(job);
    // show each episode in the grid as soon as it is ready, not only at the end of a batch
    const done = job ? job.items.filter((it) => it.state === "done").length : 0;
    if (done !== doneSeen) { doneSeen = done; await loadEpisodes(); await loadWorkspaces(); }
    if (!job?.running) {
      clearInterval(polling);
      polling = null;
      $("generateBtn").disabled = false;
      $("rerenderBtn").disabled = false;
      await loadEpisodes();
    }
  };
  polling = setInterval(tick, 1000);
  await tick();
}

(async function init() {
  await loadWorkspaces();
  history.replaceState(null, "", `#${encodeURIComponent(ws)}`);
  await loadConfig();
  await loadEpisodes();
  const job = await api("/api/job");
  if (job) { renderJob(job); if (job.running) watchJob(); }
})();
