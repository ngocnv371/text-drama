const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const PROVIDER_LABEL = { claude: "Claude", gemini: "Gemini", deepseek: "DeepSeek" };

let episodes = [];
let providers = {};
let config = null;
let open = null;      // episode shown in the viewer
let polling = null;

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
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

async function loadConfig() {
  ({ config, providers } = await api("/api/config"));
  $("topicChip").textContent = config.topic;
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
      body: JSON.stringify({ topic: $("topic").value, app: $("app").value, tone: $("tone").value, targetSeconds: +$("seconds").value, provider: $("defaultProvider").value }),
    });
    await loadConfig();
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
          <span class="tag">${ep.messages.length} msgs</span>
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

// ---- generate + job progress

$("generateBtn").addEventListener("click", async () => {
  try {
    await api("/api/generate", { method: "POST", body: JSON.stringify({ premise: $("premise").value, provider: $("provider").value }) });
    $("premise").value = "";
    watchJob();
  } catch (err) {
    alert(err.message);
  }
});

function renderJob(job) {
  if (!job) { $("job").hidden = true; return; }
  $("job").hidden = false;
  const order = ["writing", "rendering", "done"];
  const at = job.stage === "failed" ? -1 : order.indexOf(job.stage);
  document.querySelectorAll(".stages span").forEach((s) => {
    const i = order.indexOf(s.dataset.stage);
    s.className = at < 0 ? "" : i < at || job.stage === "done" ? "complete" : i === at ? "active" : "";
  });
  const bar = $("bar").parentElement;
  bar.classList.toggle("indeterminate", job.running && job.progress == null);
  $("bar").style.width = job.progress == null ? "" : `${Math.round(job.progress * 100)}%`;
  $("bar").style.background = job.stage === "failed" ? "var(--danger)" : job.stage === "done" ? "var(--ok)" : "";

  const status = $("jobStatus");
  status.className = `job-status ${job.stage}`;
  const label = job.kind === "render" ? `Re-rendering ${job.id}` : job.id ? `Episode ${job.id}` : "New episode";
  if (job.stage === "failed") {
    const reason = job.lines.filter((l) => !l.startsWith("[")).slice(-4).join("\n") || job.lines.slice(-2).join("\n");
    status.textContent = `${label} failed:\n${reason}`;
  } else if (job.stage === "done") {
    status.textContent = `${label} is ready.`;
  } else if (job.stage === "rendering") {
    status.textContent = `${label}: rendering video${job.progress != null ? ` ${Math.round(job.progress * 100)}%` : ""}…`;
  } else {
    const last = [...job.lines].reverse().find((l) => /attempt|failed \d+ check/.test(l));
    status.textContent = `${label}: writing the script${last ? `\n${last.replace(/^\[[^\]]+\]\s*/, "")}` : "…"}`;
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
  const tick = async () => {
    const job = await api("/api/job").catch(() => null);
    renderJob(job);
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
  await loadConfig();
  await loadEpisodes();
  const job = await api("/api/job");
  if (job) { renderJob(job); if (job.running) watchJob(); }
})();
