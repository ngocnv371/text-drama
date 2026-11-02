// Seekable chat renderer. seek(t) draws the exact frame for time t (seconds), so the
// renderer can capture any frame in any order. Open index.html?ep=pilot to watch it play.
(function () {
  const $ = (id) => document.getElementById(id);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const easeOut = (k) => 1 - Math.pow(1 - k, 3);
  const backOut = (k) => { const s = 1.9; k -= 1; return k * k * ((s + 1) * k + s) + 1; };

  const GROW = 0.22;        // seconds for a new item to push the thread up
  const POP = 0.3;          // bubble pop-in
  const GAP_SAME = 10;      // px between consecutive messages from the same sender
  const GAP_SWITCH = 30;    // px when the sender changes
  const UNSEND_ANIM = 0.4;

  let T, items = [], typingEl, typingH, receiptEl, receiptH, threadH;

  function addMinutes(clock, minutes) {
    const m = /(\d+):(\d+)\s*(AM|PM)?/i.exec(clock);
    if (!m) return clock;
    let h = +m[1] % 12 + (m[3] && m[3].toUpperCase() === "PM" ? 12 : 0);
    let total = h * 60 + +m[2] + minutes;
    total = ((total % 1440) + 1440) % 1440;
    h = Math.floor(total / 60);
    const mm = String(total % 60).padStart(2, "0");
    if (!m[3]) return `${h}:${mm}`;
    return `${h % 12 || 12}:${mm} ${h >= 12 ? "PM" : "AM"}`;
  }
  const clockAt = (t) => addMinutes(T.startClock, Math.floor(t / 15));

  function el(cls, html) {
    const d = document.createElement("div");
    d.className = cls;
    if (html !== undefined) d.innerHTML = html;
    return d;
  }
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  function build() {
    document.body.classList.toggle("theme-light", T.theme === "light");
    const other = T.cast.find((c) => c.id !== "me");
    $("chatName").textContent = T.chat.name;
    $("chatSubtitle").textContent = T.chat.subtitle || "";
    $("avatar").textContent = (other ? other.name : T.chat.name).slice(0, 1).toUpperCase();
    $("hookText").textContent = T.hook;
    $("outroText").textContent = T.cliffhanger;
    const showNames = T.cast.length > 2;

    const scroller = $("scroller");
    T.messages.forEach((m, i) => {
      const side = m.from === "me" ? "from-me" : "from-them";
      const who = T.cast.find((c) => c.id === m.from);
      const name = showNames && m.from !== "me" && who ? `<div class="notice" style="text-align:left;font-style:normal;padding-left:20px">${esc(who.name)}</div>` : "";
      const node = el(`item ${side}`, `${name}<div class="bubble${m.beat === "bombshell" ? " bomb" : ""}">${esc(m.text)}</div>`);
      scroller.appendChild(node);
      const notice = m.unsendAt != null ? el("item notice", `${esc(m.from === "me" ? "You" : who ? who.name : "")} unsent a message`) : null;
      if (notice) scroller.appendChild(notice);
      items.push({ m, node, bubble: node.querySelector(".bubble"), notice, prevFrom: i > 0 ? T.messages[i - 1].from : null });
    });
    typingEl = el("item from-them typing", `<div class="bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`);
    receiptEl = el("item receipt", "Delivered");
    scroller.appendChild(typingEl);
    scroller.appendChild(receiptEl);

    // Measure once; layout per frame is pure arithmetic.
    for (const it of items) {
      it.h = it.node.offsetHeight;
      it.nh = it.notice ? it.notice.offsetHeight : 0;
    }
    typingH = typingEl.offsetHeight;
    receiptH = receiptEl.offsetHeight;
    threadH = $("thread").offsetHeight;

    // Things a human would spot on screen; the renderer fails the episode on these.
    window.LAYOUT_PROBLEMS = [];
    for (const it of items) {
      if (it.h > threadH * 0.45) window.LAYOUT_PROBLEMS.push(`message ${it.m.i + 1} fills ${Math.round((100 * it.h) / threadH)}% of the screen`);
    }
    $("hook").style.opacity = 1;
    if ($("hookText").offsetHeight > 420) window.LAYOUT_PROBLEMS.push("hook caption is more than 3 lines");
    $("outro").style.opacity = 1;
    if ($("outroText").offsetHeight > 700) window.LAYOUT_PROBLEMS.push("cliffhanger card is more than 6 lines");
  }

  function hide(node) { node.style.display = "none"; }
  function place(node, y, extra) {
    node.style.display = "block";
    node.style.transform = `translateY(${y}px)`;
    if (extra) Object.assign(node.style, extra);
  }

  function seek(t) {
    // ---- which rows are on screen, and how tall each is right now
    const rows = [];
    let lastAppeared = null, activeTyping = null;

    for (const it of items) {
      const m = it.m;
      for (let s = 0; s < m.typing.length; s++) {
        const [a, b] = m.typing[s];
        const last = s === m.typing.length - 1;
        if (t >= a && t < b) activeTyping = { start: a, end: b, exit: 1 };
        else if (!last && t >= b && t < b + GROW) activeTyping = { start: a, end: b, exit: 1 - (t - b) / GROW };
      }
      if (t < m.appear) { hide(it.node); if (it.notice) hide(it.notice); continue; }
      lastAppeared = it;
      const age = t - m.appear;
      // a message that replaces a typing bubble starts at the typing bubble's height
      const fromTyping = m.typing.length && Math.abs(m.typing[m.typing.length - 1][1] - m.appear) < 1e-6;
      const g = easeOut(clamp01(age / GROW));
      const gap = it.prevFrom === null ? 0 : (it.prevFrom === m.from ? GAP_SAME : GAP_SWITCH);

      if (m.unsendAt != null && t >= m.unsendAt) {
        const k = easeOut(clamp01((t - m.unsendAt) / UNSEND_ANIM));
        rows.push({ kind: "unsend", it, h: lerp(it.h, it.nh, k), gap, k });
      } else {
        rows.push({ kind: "msg", it, h: fromTyping ? lerp(typingH, it.h, g) : it.h * g, gap: gap * (fromTyping ? 1 : g), age });
      }
    }

    // receipt under the newest message when it is ours
    let receipt = null;
    if (lastAppeared && lastAppeared.m.from === "me" && !(lastAppeared.m.unsendAt != null && t >= lastAppeared.m.unsendAt)) {
      const age = t - lastAppeared.m.appear - 0.25;
      if (age > 0) {
        const read = lastAppeared.m.readAt != null && t >= lastAppeared.m.readAt;
        receipt = { h: receiptH * easeOut(clamp01(age / GROW)), read, at: lastAppeared.m.readAt };
        rows.push({ kind: "receipt", h: receipt.h, gap: 6 });
      }
    }

    if (activeTyping) {
      const g = easeOut(clamp01((t - activeTyping.start) / GROW)) * clamp01(activeTyping.exit);
      const gap = lastAppeared && lastAppeared.m.from !== "me" ? GAP_SAME : GAP_SWITCH;
      rows.push({ kind: "typing", h: typingH * g, gap: gap * g, g });
    }

    // ---- layout: stack from the top, scroll so the newest row sits above the compose bar
    const PAD_TOP = 30, PAD_BOTTOM = 28;
    let y = PAD_TOP;
    for (const r of rows) { y += r.gap; r.y = y; y += r.h; }
    const scroll = Math.max(0, y + PAD_BOTTOM - threadH);
    $("scroller").style.transform = `translateY(${-scroll}px)`;

    let receiptPlaced = false, typingPlaced = false;
    for (const r of rows) {
      if (r.kind === "msg") {
        const p = clamp01(r.age / POP);
        const s = lerp(0.55, 1, backOut(p));
        place(r.it.node, r.y, { opacity: clamp01(p * 3) });
        r.it.bubble.style.transform = `scale(${s})`;
        r.it.bubble.style.opacity = 1;
        if (r.it.m.beat === "bombshell") {
          const glow = Math.exp(-r.age * 1.6);
          r.it.bubble.style.boxShadow = `0 0 ${60 * glow}px ${14 * glow}px rgba(255,45,85,${0.75 * glow})`;
        }
        if (r.it.notice) hide(r.it.notice);
      } else if (r.kind === "unsend") {
        place(r.it.node, r.y, { opacity: 1 - r.k });
        r.it.bubble.style.transform = `scale(${lerp(1, 0.4, r.k)})`;
        r.it.bubble.style.boxShadow = "none";
        place(r.it.notice, r.y + (r.h - r.it.nh) / 2, { opacity: r.k });
      } else if (r.kind === "receipt") {
        receiptEl.innerHTML = receipt.read ? `<b>Read</b> ${clockAt(receipt.at)}` : "Delivered";
        place(receiptEl, r.y, { opacity: clamp01(r.h / receiptH) });
        receiptPlaced = true;
      } else if (r.kind === "typing") {
        place(typingEl, r.y, { opacity: r.g });
        typingEl.querySelector(".bubble").style.transform = `scale(${lerp(0.6, 1, r.g)})`;
        typingEl.querySelectorAll(".dot").forEach((d, k) => {
          const w = Math.max(0, Math.sin((t * 2.4 - k * 0.18) * Math.PI * 2));
          d.style.opacity = 0.35 + 0.65 * w;
          d.style.transform = `translateY(${-8 * w}px)`;
        });
        typingPlaced = true;
      }
    }
    if (!receiptPlaced) hide(receiptEl);
    if (!typingPlaced) hide(typingEl);

    // ---- compose bar: our messages get typed out before they send
    let composing = null;
    for (const it of items) {
      const c = it.m.compose;
      if (c && t >= c[0] && t < c[1]) composing = { text: it.m.text, k: (t - c[0]) / (c[1] - c[0]) };
    }
    const chars = composing ? [...composing.text] : [];
    const shown = composing ? chars.slice(0, Math.ceil(chars.length * composing.k)).join("") : "";
    let field = shown;
    if (field.length > 28) field = "…" + [...field].slice(-27).join("");
    $("composeText").textContent = field;
    $("placeholder").style.display = composing ? "none" : "inline";
    $("caret").style.visibility = composing && Math.floor(t * 2.5) % 2 === 0 ? "visible" : "hidden";
    $("sendBtn").classList.toggle("on", !!composing);

    $("clock").textContent = clockAt(t).replace(/\s?(AM|PM)$/i, "");

    // ---- camera: creeping push-in while a bombshell is being typed, punch + shake when it lands
    let scale = 1, dx = 0, dy = 0, flash = 0;
    for (const f of T.fx) {
      if (f.type !== "bombshell") continue;
      const m = T.messages.find((mm) => Math.abs(mm.appear - f.t) < 1e-6);
      const typeStart = m && m.typing.length ? m.typing[0][0] : f.t - 1;
      if (t >= typeStart && t < f.t) scale *= 1 + 0.06 * easeOut((t - typeStart) / (f.t - typeStart));
      const a = t - f.t;
      if (a >= 0 && a < 1.6) {
        const decay = Math.exp(-a * 4.5);
        scale *= 1 + 0.06 * Math.exp(-a * 3) + (a < 0.06 ? 0.04 * (a / 0.06) : 0.04 * Math.exp(-(a - 0.06) * 6));
        dx += 26 * decay * Math.sin(a * 95);
        dy += 20 * decay * Math.cos(a * 71);
        flash = Math.max(flash, 0.55 * Math.exp(-a * 6));
      }
    }
    $("camera").style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    $("flash").style.opacity = flash;

    // ---- hook caption and outro card
    const hk = t < T.hookSeconds ? Math.min(clamp01(t / 0.25), clamp01((T.hookSeconds - t) / 0.25)) : 0;
    $("hook").style.opacity = hk;
    $("hook").style.transform = `scale(${lerp(0.8, 1, backOut(clamp01(t / 0.3)))}) rotate(-2deg)`;
    const oa = t - T.outroAt;
    const ok = oa > 0 ? clamp01(oa / 0.4) : 0;
    $("outro").style.opacity = ok;
    $("camera").style.filter = ok > 0 ? `blur(${14 * ok}px)` : "none";
    $("outroText").style.transform = `scale(${lerp(0.7, 1, backOut(clamp01(oa / 0.45)))})`;
    $("outroCta").style.opacity = clamp01((oa - 0.5) / 0.3);
  }

  async function init() {
    T = window.TIMELINE;
    await document.fonts.ready;
    build();
    window.seek = seek;
    window.DURATION = T.duration;
    seek(0);
    window.PLAYER_READY = true;
    if (window.__RENDER) return;

    // preview mode: play in real time, click to restart
    const params = new URLSearchParams(location.search);
    let t0 = performance.now() - (+params.get("t") || 0) * 1000;
    document.addEventListener("click", () => { t0 = performance.now(); });
    const fit = () => {
      const s = Math.min(innerWidth / 1080, innerHeight / 1920);
      document.documentElement.style.zoom = s;
    };
    fit(); addEventListener("resize", fit);
    (function frame() {
      const t = ((performance.now() - t0) / 1000) % T.duration;
      seek(t);
      requestAnimationFrame(frame);
    })();
  }

  if (window.TIMELINE) init();
  else {
    const ep = new URLSearchParams(location.search).get("ep") || "pilot";
    const s = document.createElement("script");
    s.src = `../episodes/${ep}/timeline.js`;
    s.onload = init;
    document.head.appendChild(s);
  }
})();
