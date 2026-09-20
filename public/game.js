/* JEV 审判庭 — 游戏逻辑（访客体验版）
 * 通过 /api/judge 把 {state, questions} 交给服务端，服务端持有 Key 并转发给 Jev。
 * 访客未填自己的 Key 时，服务端按 IP+模式 限制 GUEST_LIMIT 次；填 Key 后无限。
 */
(function () {
  "use strict";

  // ---------- 状态 ----------
  const state = {
    you: { correct: 0, total: 0 },
    jev: { correct: 0, total: 0 },
    factQueue: shuffle(FACTS.slice()),
    mysteryQueue: shuffle(MYSTERIES.slice()),
    running: {},
    userKey: localStorage.getItem("jev_userkey") || "",
    guestUsed: {
      detect: Number(localStorage.getItem("jev_guest_detect") || 0),
      fool: Number(localStorage.getItem("jev_guest_fool") || 0),
      verdict: Number(localStorage.getItem("jev_guest_verdict") || 0),
    },
    activeMode: "detect",
    demoEnabled: false, // 服务端是否启用了访客演示限制
    guestLimit: 3,
  };

  // ---------- 工具 ----------
  function shuffle(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function popQueue(q) {
    if (q.length === 0) return null;
    return q.shift();
  }

  // ---------- 调用 Jev ----------
  async function judge(statePayload, questions, mode) {
    const doCall = async () => {
      const tStart = performance.now();
      const res = await fetch("/api/judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: statePayload,
          questions,
          meta: { mode: mode || "unknown" },
          userKey: state.userKey || undefined, // 自填 Key 随请求带上；访客不传
        }),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        // 空响应 / 非 JSON：给出可读错误而非原生 "Unexpected end of JSON input"
        throw new Error(
          text
            ? "Jev 返回了无法解析的数据"
            : "Jev 没有返回任何数据（可能网络波动或服务未启动）"
        );
      }
      if (!res.ok) {
        const err = new Error(data.error || "Jev 调用失败");
        err.code = data.code; // 例如 GUEST_LIMIT
        throw err;
      }
      data._totalMs = Math.round(performance.now() - tStart); // 浏览器往返总耗时
      return data;
    };
    try {
      return await doCall();
    } catch (e) {
      // 瞬时失败（空响应 / 网络抖动）自动重试一次，提升体验
      if (/没有返回任何数据|Failed to fetch|network/i.test(e.message)) {
        await new Promise((r) => setTimeout(r, 400));
        return await doCall();
      }
      throw e;
    }
  }

  // 同步访客计数（仅 demoEnabled 且无 userKey 时）
  function syncGuest(data, mode) {
    if (state.userKey || !state.demoEnabled) return;
    if (data && data.guest) {
      state.guestUsed[mode] = data.guest.used;
    } else {
      state.guestUsed[mode] = (state.guestUsed[mode] || 0) + 1;
    }
    localStorage.setItem("jev_guest_" + mode, state.guestUsed[mode]);
    refreshKeyStatus();
  }

  // 访客体验被服务端锁定时：同步前端计数 + 锁定该模式按钮
  function lockMode(mode, reveal, msg) {
    state.guestUsed[mode] = state.guestLimit;
    localStorage.setItem("jev_guest_" + mode, state.guestLimit);
    refreshKeyStatus();
    reveal.hidden = false;
    reveal.innerHTML = `<div class="lock-note">🔒 ${escapeHtml(msg)}</div>`;
    if (mode === "detect")
      $("#detectCard").querySelectorAll("[data-guess]").forEach((b) => (b.disabled = true));
    else if (mode === "fool") $("#foolSubmit").disabled = true;
    else if (mode === "verdict")
      $("#verdictOptions").querySelectorAll(".opt").forEach((b) => (b.disabled = true));
  }

  // 用时徽章 + 文案
  function showTiming(data) {
    const jevMs = (data.timing && data.timing.jev_ms) || data._totalMs;
    const totalMs = data._totalMs || jevMs;
    const badge = $("#timingBadge");
    badge.textContent = `⚡ ${jevMs} ms`;
    badge.classList.add("flash");
    setTimeout(() => badge.classList.remove("flash"), 260);
    return `Jev 推理 <b>${jevMs}</b> ms · 浏览器往返 <b>${totalMs}</b> ms`;
  }

  // ---------- 仪表盘渲染（通用：noul / score / choice）----------
  function renderDash(answers, meta) {
    const body = $("#dashBody");
    body.innerHTML = "";
    const head = el("div", "dist-sub", meta || "");
    body.appendChild(head);

    for (const [id, ans] of Object.entries(answers)) {
      if (ans.type === "noul") {
        const pct = Math.round(ans.noul * 100);
        const isTrue = ans.noul >= 0.5;
        const wrap = el("div", "dist");
        const lab = el("div", "dist-label");
        lab.innerHTML = `<span>“${escapeHtml(shorten(id))}” → 判定为「${isTrue ? "真" : "假"}」</span><span class="v">${pct}%</span>`;
        wrap.appendChild(lab);
        const bar = el("div", "bar " + (isTrue ? "true" : "false"));
        const fill = el("span");
        bar.appendChild(fill);
        wrap.appendChild(bar);
        const sub = el("div", "dist-sub", `Jev 给出「是/否」概率：${ans.noul.toFixed(2)}（越接近 1 越确信为真）`);
        wrap.appendChild(sub);
        body.appendChild(wrap);
        requestAnimationFrame(() => (fill.style.width = pct + "%"));
      } else if (ans.type === "score") {
        const wrap = el("div", "dist");
        wrap.appendChild(el("div", "dist-label", `<span>“${escapeHtml(shorten(id))}”评分分布</span><span class="v">加权 ${ans.score.toFixed(2)}</span>`));
        const entries = Object.entries(ans.probabilities)
          .sort((a, b) => Number(a[0]) - Number(b[0]));
        entries.forEach(([lvl, prob]) => {
          const pct = Math.round(prob * 100);
          const r = el("div", "dist");
          r.appendChild(el("div", "dist-label", `<span>${escapeHtml(ans.legend[lvl])}</span><span class="v">${pct}%</span>`));
          const bar = el("div", "bar");
          const fill = el("span");
          bar.appendChild(fill);
          r.appendChild(bar);
          wrap.appendChild(r);
          requestAnimationFrame(() => (fill.style.width = pct + "%"));
        });
        wrap.appendChild(el("div", "dist-sub", `置信度 confidence = ${ans.confidence.toFixed(2)}`));
        body.appendChild(wrap);
      } else if (ans.type === "choice") {
        const wrap = el("div", "dist");
        wrap.appendChild(el("div", "dist-label", `<span>“${escapeHtml(shorten(id))}”选项概率</span><span class="v">选中：${escapeHtml(ans.choice)}</span>`));
        const entries = Object.entries(ans.probabilities)
          .sort((a, b) => b[1] - a[1]);
        entries.forEach(([opt, prob]) => {
          const pct = Math.round(prob * 100);
          const r = el("div", "dist");
          r.appendChild(el("div", "dist-label", `<span>选项 ${escapeHtml(opt)}</span><span class="v">${pct}%</span>`));
          const bar = el("div", "bar" + (opt === ans.choice ? " true" : ""));
          const fill = el("span");
          bar.appendChild(fill);
          r.appendChild(bar);
          wrap.appendChild(r);
          requestAnimationFrame(() => (fill.style.width = pct + "%"));
        });
        wrap.appendChild(el("div", "dist-sub", `置信度 confidence = ${ans.confidence.toFixed(2)}`));
        body.appendChild(wrap);
      }
    }
  }
  function shorten(id) {
    return { is_true: "是否属实", creativity: "巧妙度", cause: "最可能原因" }[id] || id;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- 计分板 ----------
  function updateScore() {
    $("#youScore").textContent = state.you.correct;
    $("#jevScore").textContent = state.jev.correct;
    $("#youRate").textContent = "命中 " + rate(state.you);
    $("#jevRate").textContent = "命中 " + rate(state.jev);
  }
  function rate(s) {
    return s.total ? Math.round((s.correct / s.total) * 100) + "%" : "命中 0%";
  }

  // ---------- 访客模式前置检查 ----------
  function guestBlocked(mode) {
    return (
      !state.userKey &&
      state.demoEnabled &&
      (state.guestUsed[mode] || 0) >= state.guestLimit
    );
  }

  // ====================================================
  //  关卡 ① 火眼金睛（Noul）
  // ====================================================
  function loadDetect() {
    const fact = popQueue(state.factQueue) || ((state.factQueue = shuffle(FACTS.slice())), popQueue(state.factQueue));
    $("#detectCat").textContent = fact.cat;
    $("#detectText").textContent = fact.text;
    const reveal = $("#detectReveal");
    reveal.hidden = true;
    reveal.innerHTML = "";
    const next = $("#detectNext");
    next.hidden = true;
    $("#detectCard").querySelectorAll("[data-guess]").forEach((b) => {
      b.disabled = false;
      b.onclick = () => playDetect(fact, b.dataset.guess === "true");
    });
  }

  async function playDetect(fact, guess) {
    const mode = "detect";
    if (state.running.detect) return;
    const reveal = $("#detectReveal");
    if (guestBlocked(mode)) {
      reveal.hidden = false;
      reveal.innerHTML = `<div class="lock-note">🔒 本模式体验已用完（每模式限 ${state.guestLimit} 次）。填入你的 TypeSafe API Key 即可无限畅玩。</div>`;
      return;
    }
    state.running.detect = true;
    $("#detectCard").querySelectorAll("[data-guess]").forEach((b) => (b.disabled = true));
    reveal.hidden = false;
    reveal.innerHTML = `<h4>Jev 正在审判…</h4><div class="dash-hint">调用 jev-latest · Noul 判断中</div>`;

    let data;
    try {
      data = await judge(
        fact.text,
        {
          is_true: {
            type: "noul",
            instructions: "这条陈述在事实上是否准确？",
            criteria: { true: "陈述符合已知事实", false: "陈述与事实不符或为虚构" },
          },
        },
        mode
      );
    } catch (e) {
      if (e.code === "GUEST_LIMIT") {
        lockMode(mode, reveal, e.message);
        state.running.detect = false;
        return;
      }
      reveal.innerHTML = `<h4 class="verdict-badge lose">出错了</h4><div class="note">${escapeHtml(e.message)}</div>`;
      state.running.detect = false;
      return;
    }
    state.running.detect = false;
    syncGuest(data, mode);

    const noul = data.answers.is_true.noul;
    const jevSaysTrue = noul >= 0.6; // 二值化阈值
    const youRight = guess === fact.truth;
    const jevRight = jevSaysTrue === fact.truth;

    state.you.total++; if (youRight) state.you.correct++;
    state.jev.total++; if (jevRight) state.jev.correct++;
    updateScore();

    renderDash(data.answers, `关卡① 输入陈述：「${shortenText(fact.text, 18)}」`);
    const timingTxt = showTiming(data);

    const truthWord = fact.truth ? "真（事实）" : "假（流言/伪造）";
    reveal.innerHTML = `
      <h4>揭晓：这条其实是 <span class="verdict-badge ${fact.truth ? "win" : "lose"}">${truthWord}</span></h4>
      <div class="dist">
        <div class="dist-label"><span>你的判断</span><span class="v">${guess ? "真" : "假"} → ${youRight ? "✓ 命中" : "✗ 失误"}</span></div>
      </div>
      <div class="dist">
        <div class="dist-label"><span>Jev 判定</span><span class="v">${jevSaysTrue ? "真" : "假"} → ${jevRight ? "✓ 命中" : "✗ 失误"}（相信度 ${Math.round(noul * 100)}%）</span></div>
      </div>
      <div class="timing-line">⏱ ${timingTxt}</div>
      <div class="note">📖 ${escapeHtml(fact.note)}</div>`;
    $("#detectNext").hidden = false;
  }

  // ====================================================
  //  关卡 ② 巧舌如簧（Noul + Score）
  // ====================================================
  async function playFool() {
    const mode = "fool";
    if (state.running.fool) {
      const reveal = $("#foolReveal");
      reveal.hidden = false;
      reveal.innerHTML = `<div class="note">⏳ Jev 正在审判上一条，请稍候…</div>`;
      return;
    }
    const input = $("#foolInput").value.trim();
    if (input.length < 6) {
      const reveal = $("#foolReveal");
      reveal.hidden = false;
      reveal.innerHTML = `<div class="note">✍️ 至少写 6 个字，编一句「假的但听起来很可信」的话，再交给 Jev～</div>`;
      $("#foolInput").focus();
      return;
    }
    const reveal = $("#foolReveal");
    if (guestBlocked(mode)) {
      reveal.hidden = false;
      reveal.innerHTML = `<div class="lock-note">🔒 本模式体验已用完（每模式限 ${state.guestLimit} 次）。填入你的 TypeSafe API Key 即可无限畅玩。</div>`;
      return;
    }
    state.running.fool = true;
    const btn = $("#foolSubmit");
    btn.disabled = true;
    reveal.hidden = false;
    reveal.innerHTML = `<h4>Jev 正在审判…</h4><div class="dash-hint">Noul（相信度）+ Score（巧妙度）双判定中</div>`;

    let data;
    try {
      data = await judge(
        input,
        {
          is_true: {
            type: "noul",
            instructions: "作为一句'看似可信但其实可能是编造的冷知识'，这句话在事实上成立（为真）的概率有多高？",
            criteria: { true: "陈述符合已知事实/科学常识", false: "陈述与事实不符或为虚构" },
          },
          creativity: {
            type: "score",
            instructions: "这句话作为一条'试图骗过常识判断的假冷知识'，其表述的巧妙、可信、有迷惑性的程度如何？",
            criteria: ["平淡直白，一眼假", "有一定巧思，略有迷惑性", "非常巧妙，足以以假乱真"],
          },
        },
        mode
      );
    } catch (e) {
      if (e.code === "GUEST_LIMIT") {
        lockMode(mode, reveal, e.message);
        state.running.fool = false; btn.disabled = true;
        return;
      }
      reveal.innerHTML = `<h4 class="verdict-badge lose">出错了</h4><div class="note">${escapeHtml(e.message)}</div>`;
      state.running.fool = false; btn.disabled = false;
      return;
    }
    state.running.fool = false; btn.disabled = false;
    syncGuest(data, mode);

    const noul = data.answers.is_true.noul;
    const score = data.answers.creativity;
    renderDash(data.answers, `关卡② 你的出题：「${shortenText(input, 16)}」`);
    const timingTxt = showTiming(data);

    // 骗术分
    const believ = Math.round(noul * 100);
    let tier, cls, msg;
    if (noul >= 0.7) { tier = "S 级 · 成功骗过 Jev！"; cls = "s"; msg = "Jev 有七成以上把握相信这是真的——你的编造足以以假乱真。"; }
    else if (noul >= 0.45) { tier = "A 级 · Jev 半信半疑"; cls = "a"; msg = "Jev 拿不准，你的话有一定迷惑性，但没完全上当。"; }
    else if (noul >= 0.25) { tier = "B 级 · Jev 有点怀疑"; cls = "b"; msg = "Jev 明显倾向于认为这是假的，表述还可以更圆。"; }
    else { tier = "C 级 · 被 Jev 一眼识破"; cls = "c"; msg = "Jev 几乎确信这是编造。下次加点细节和合理机制会更好骗。"; }

    const clever = score.legend[Math.round(score.score)] || "";
    reveal.innerHTML = `
      <h4>骗术审判结果</h4>
      <div class="fool-tier ${cls}">${tier}</div>
      <div class="dist">
        <div class="dist-label"><span>Jev 的「相信度」(Noul)</span><span class="v">${believingWord(noul)} · ${believingPct(noul)}%</span></div>
      </div>
      <div class="dist">
        <div class="dist-label"><span>Jev 的「巧妙度」(Score)</span><span class="v">${escapeHtml(clever)} · 加权 ${score.score.toFixed(2)}</span></div>
      </div>
      <div class="timing-line">⏱ ${timingTxt}</div>
      <div class="note">💡 ${escapeHtml(msg)}<br>（记住：你明知这是假的；Jev 仅凭常识概率给出判断，不看你"心里想什么"。）</div>`;
  }
  function believingWord(n) { return n >= 0.6 ? "倾向于信" : "倾向于不信"; }
  function believingPct(n) { return Math.round(n * 100); }

  // ====================================================
  //  关卡 ③ 断案如神（Choice）
  // ====================================================
  function loadVerdict() {
    const m = popQueue(state.mysteryQueue) || ((state.mysteryQueue = shuffle(MYSTERIES.slice())), popQueue(state.mysteryQueue));
    window._curMystery = m;
    $("#verdictScene").textContent = m.scene;
    const box = $("#verdictOptions");
    box.innerHTML = "";
    Object.entries(m.options).forEach(([k, v]) => {
      const b = el("button", "opt", `<b>${k}</b> · ${escapeHtml(v)}`);
      b.onclick = () => playVerdict(m, k);
      box.appendChild(b);
    });
    const reveal = $("#verdictReveal");
    reveal.hidden = true; reveal.innerHTML = "";
    $("#verdictNext").hidden = true;
    box.querySelectorAll(".opt").forEach((b) => (b.disabled = false));
  }

  async function playVerdict(m, pick) {
    const mode = "verdict";
    if (state.running.verdict) return;
    const reveal = $("#verdictReveal");
    if (guestBlocked(mode)) {
      reveal.hidden = false;
      reveal.innerHTML = `<div class="lock-note">🔒 本模式体验已用完（每模式限 ${state.guestLimit} 次）。填入你的 TypeSafe API Key 即可无限畅玩。</div>`;
      return;
    }
    state.running.verdict = true;
    $("#verdictOptions").querySelectorAll(".opt").forEach((b) => (b.disabled = true));
    reveal.hidden = false;
    reveal.innerHTML = `<h4>Jev 正在断案…</h4><div class="dash-hint">Choice 在 ${(() => { const ks = Object.keys(m.options); return ks.join(" / "); })()} 中选因中</div>`;

    let data;
    try {
      data = await judge(
        m.scene,
        {
          cause: {
            type: "choice",
            instructions: "根据常识，上述情境最可能的原因是什么？只依据给定信息做常识推断。",
            criteria: m.options,
          },
        },
        mode
      );
    } catch (e) {
      if (e.code === "GUEST_LIMIT") {
        lockMode(mode, reveal, e.message);
        state.running.verdict = false;
        return;
      }
      reveal.innerHTML = `<h4 class="verdict-badge lose">出错了</h4><div class="note">${escapeHtml(e.message)}</div>`;
      state.running.verdict = false;
      return;
    }
    state.running.verdict = false;
    syncGuest(data, mode);

    const jevPick = data.answers.cause.choice;
    const youRight = pick === m.answer;
    const jevRight = jevPick === m.answer;
    state.you.total++; if (youRight) state.you.correct++;
    state.jev.total++; if (jevRight) state.jev.correct++;
    updateScore();

    renderDash(data.answers, `关卡③ 谜题：「${shortenText(m.scene, 14)}」`);
    const timingTxt = showTiming(data);

    reveal.innerHTML = `
      <h4>真相：正确原因是 <span class="verdict-badge win">${m.answer}</span> · ${escapeHtml(m.options[m.answer])}</h4>
      <div class="dist"><div class="dist-label"><span>你的选择</span><span class="v">${pick} → ${youRight ? "✓ 命中" : "✗ 失误"}</span></div></div>
      <div class="dist"><div class="dist-label"><span>Jev 的选择</span><span class="v">${jevPick} → ${jevRight ? "✓ 命中" : "✗ 失误"}</span></div></div>
      <div class="timing-line">⏱ ${timingTxt}</div>
      <div class="note">📖 ${escapeHtml(m.note)}</div>`;
    $("#verdictNext").hidden = false;
  }

  function shortenText(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }

  // ---------- 解锁横幅 / 状态 ----------
  function refreshKeyStatus() {
    const status = $("#keyStatus");
    if (state.userKey) {
      status.className = "key-status unlocked";
      status.innerHTML = "🔓 已用你的 Key · 无限畅玩";
      return;
    }
    if (state.demoEnabled) {
      const used = state.guestUsed[state.activeMode] || 0;
      const left = Math.max(0, state.guestLimit - used);
      status.className = "key-status guest";
      status.innerHTML = `👤 访客模式 · 当前模式剩 <b>${left}</b> / ${state.guestLimit} 次`;
    } else {
      status.className = "key-status local";
      status.innerHTML = "🖥️ 本地模式 · 无限畅玩";
    }
  }
  function saveKey() {
    const v = $("#keyInput").value.trim();
    if (!v) return;
    state.userKey = v;
    localStorage.setItem("jev_userkey", v);
    $("#keyInput").value = "";
    $("#keyClear").hidden = false;
    refreshKeyStatus();
    unlockAllButtons();
  }
  function clearKey() {
    state.userKey = "";
    localStorage.removeItem("jev_userkey");
    $("#keyClear").hidden = true;
    refreshKeyStatus();
  }
  function unlockAllButtons() {
    $("#detectCard").querySelectorAll("[data-guess]").forEach((b) => (b.disabled = false));
    $("#foolSubmit").disabled = false;
    $("#verdictOptions").querySelectorAll(".opt").forEach((b) => (b.disabled = false));
  }

  // ---------- 事件绑定 ----------
  function init() {
    // 拉取服务端状态：是否启用访客限制
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => {
        state.demoEnabled = !!d.demoEnabled;
        state.guestLimit = d.guestLimit || 3;
        refreshKeyStatus();
      })
      .catch(() => refreshKeyStatus());

    // tabs
    $("#tabs").addEventListener("click", (e) => {
      const t = e.target.closest(".tab");
      if (!t) return;
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $("#panel-" + t.dataset.tab).classList.add("active");
      state.activeMode = t.dataset.tab;
      refreshKeyStatus();
    });

    $("#detectNext").onclick = loadDetect;
    $("#foolSubmit").onclick = playFool;
    $("#verdictNext").onclick = loadVerdict;

    $("#keySave").onclick = saveKey;
    $("#keyClear").onclick = clearKey;
    $("#keyInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveKey();
    });

    updateScore();
    loadDetect();
    loadVerdict();
    refreshKeyStatus();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
