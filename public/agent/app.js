/* ==================== 3D 打印缺陷检测助手 - 前端逻辑 ==================== */
(function () {
  "use strict";

  /* ---------- 工具函数 ---------- */
  function readJson(response) {
    if (response.status === 429) return Promise.resolve({error: "请求较频繁，请稍等一分钟后重试。"});
    return response.json();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setupEmbeddedWheelHandoff() {
    if (window.parent === window) return;

    function canScrollInDirection(el, deltaY) {
      if (!el || deltaY === 0) return false;
      var style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY)) return false;
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      return deltaY > 0
        ? el.scrollTop + el.clientHeight < el.scrollHeight - 1
        : el.scrollTop > 1;
    }

    window.addEventListener("wheel", function (event) {
      if (event.ctrlKey || event.metaKey || event.defaultPrevented || event.deltaY === 0) return;
      var node = event.target;
      while (node && node !== document.body && node !== document.documentElement) {
        if (canScrollInDirection(node, event.deltaY)) return;
        node = node.parentElement;
      }

      event.preventDefault();
      window.parent.postMessage({
        type: "printlab:wheel-handoff",
        deltaY: event.deltaY,
        deltaMode: event.deltaMode
      }, "*");
    }, { passive: false });
  }

  setupEmbeddedWheelHandoff();

  /* 极简 Markdown 渲染（先转义防 XSS，再转结构） */
  function renderInline(s) {
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  function renderMd(text) {
    var lines = String(text).split("\n");
    var html = [];
    var i = 0;
    var inCode = false;
    var codeBuf = [];
    var listType = null;   // "ul" | "ol" | null
    var tableBuf = [];

    function flushList() {
      if (listType) { html.push("</" + listType + ">"); listType = null; }
    }
    function flushTable() {
      if (tableBuf.length) {
        var rows = tableBuf.map(function (r) {
          var cells = r.split("|").map(function (c) { return c.trim(); });
          // 去掉首尾空串（行以 | 开头结尾）
          if (cells[0] === "") cells.shift();
          if (cells[cells.length - 1] === "") cells.pop();
          return cells;
        });
        var isHead = true;
        rows.forEach(function (cells, idx) {
          // 分隔行 |---|---| 跳过
          if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c); })) return;
          var tag = isHead ? "th" : "td";
          html.push("<tr>");
          cells.forEach(function (c) { html.push("<" + tag + ">" + renderInline(c) + "</" + tag + ">"); });
          html.push("</tr>");
          isHead = false;
        });
        tableBuf = [];
      }
    }

    while (i < lines.length) {
      var line = lines[i];
      var trimmed = line.trim();

      // 代码块
      if (trimmed.startsWith("```")) {
        if (inCode) { html.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>"); codeBuf = []; inCode = false; }
        else { flushList(); flushTable(); inCode = true; }
        i++; continue;
      }
      if (inCode) { codeBuf.push(line); i++; continue; }

      // 空行
      if (!trimmed) { flushList(); flushTable(); html.push(""); i++; continue; }

      // 表格
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        flushList();
        if (!tableBuf.length) html.push("<table>");
        tableBuf.push(trimmed);
        // 下一行不是表格则闭合
        if (i + 1 >= lines.length || !(lines[i + 1].trim().startsWith("|") && lines[i + 1].trim().endsWith("|"))) {
          flushTable();
          html.push("</table>");
        }
        i++; continue;
      }

      // 标题
      var hm = trimmed.match(/^(#{1,3})\s+(.*)/);
      if (hm) { flushList(); flushTable(); html.push("<h" + hm[1].length + ">" + renderInline(hm[2]) + "</h" + hm[1].length + ">"); i++; continue; }

      // 无序列表
      var um = trimmed.match(/^[-*]\s+(.*)/);
      if (um) {
        flushTable();
        if (listType !== "ul") { flushList(); html.push("<ul>"); listType = "ul"; }
        html.push("<li>" + renderInline(um[1]) + "</li>");
        i++; continue;
      }
      // 有序列表
      var om = trimmed.match(/^\d+[.、)]\s+(.*)/);
      if (om) {
        flushTable();
        if (listType !== "ol") { flushList(); html.push("<ol>"); listType = "ol"; }
        html.push("<li>" + renderInline(om[1]) + "</li>");
        i++; continue;
      }
      flushList(); flushTable();
      html.push(renderInline(trimmed) || "&nbsp;");
      i++;
    }
    flushList(); flushTable();
    if (inCode && codeBuf.length) html.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>");
    return html.join("\n");
  }

  /* ---------- 聊天 ---------- */
  var messagesEl = document.getElementById("chatMessages");
  var chatInput = document.getElementById("chatInput");
  var sendBtn = document.getElementById("sendBtn");
  var busy = false;
  var conversation = [];
  var records = [];
  var diagnosisId = Date.now().toString(36);
  var recordKey = 'printlab-diagnosis-v1';
  try { var saved = JSON.parse(localStorage.getItem(recordKey) || '[]'); if (Array.isArray(saved)) records = saved.filter(function (r) { return r && typeof r.id === 'string'; }).slice(-100); } catch (_) {}
  function updateRecordCount() {
    document.getElementById('feedbackCount').textContent = '本机最近 ' + records.length + ' 条诊断 · ' + records.filter(function(r) { return r.feedback; }).length + ' 条复测反馈';
  }
  function saveRecords() {
    records = records.slice(-100);
    updateRecordCount();
    try { localStorage.setItem(recordKey, JSON.stringify(records)); }
    catch (_) { document.getElementById('feedbackCount').textContent = '本机存储不可用，请导出本页记录'; }
  }
  function printBackground() {
    var fields = [['ctxMaterial','材料'],['ctxNozzleTemp','喷嘴温度 ℃'],['ctxBedTemp','热床温度 ℃'],['ctxExtruder','送料结构'],['ctxStage','出现阶段'],['ctxPrinter','机器型号']];
    return fields.map(function(f) { var value = document.getElementById(f[0]).value.trim(); return value ? f[1] + '：' + value : ''; }).filter(Boolean).join('；');
  }
  function attachRetest(bubble, record) {
    var evidence = document.createElement('div'); evidence.className = 'reply-evidence';
    var toolNames = {diagnose_defect:'缺陷知识查询',recommend_temperature:'材料温度查询',calc_print_params:'切片参数检查',estimate_print_time:'打印时间估算'};
    evidence.textContent = record.tools_used.length ? '本次参考：' + record.tools_used.map(function(t) { return toolNames[t] || t; }).join('、') + '（通用参考，具体设置以设备与耗材说明为准）' : '本次为对话分析，尚未查询打印工具。';
    bubble.appendChild(evidence);
    var details = document.createElement('details'); details.className = 'retest';
    details.innerHTML = '<summary>试过之后，记录改善情况</summary><textarea aria-label="本次调整与复测现象" maxlength="1000" placeholder="例如：只把喷嘴 215℃ 改为 205℃，同一测试件仍有细丝。"></textarea><div class="retest-actions"><button type="button" data-outcome="resolved" aria-pressed="false">已解决</button><button type="button" data-outcome="partial" aria-pressed="false">有改善</button><button type="button" data-outcome="unresolved" aria-pressed="false">未解决</button><button type="button" data-continue>继续排查</button></div><span class="retest-status" role="status">记录你实际调整的参数与复测现象，便于继续排查。</span>';
    details.addEventListener('click', function(e) {
      var button = e.target.closest('button'); if (!button) return;
      var note = details.querySelector('textarea').value.trim();
      var status = details.querySelector('.retest-status');
      if (!note) { status.textContent = '请先写下调整内容和复测现象。'; details.querySelector('textarea').focus(); return; }
      if (button.hasAttribute('data-continue')) {
        var original = record.message;
        chatInput.value = '针对之前的问题「' + original.slice(0,250) + '」，复测结果：' + note + '。请结合已做的调整，给我下一步单变量排查建议。';
        autoGrow(); chatInput.focus(); return;
      }
      record.feedback = {outcome:button.dataset.outcome,note:note,source:'user_report',at:new Date().toISOString()};
      details.querySelectorAll('[data-outcome]').forEach(function(b) { b.setAttribute('aria-pressed', String(b === button)); });
      saveRecords(); status.textContent = '已记录本次自报复测结果。可继续补充或点击“继续排查”。';
    });
    bubble.appendChild(details);
  }
  document.getElementById('newDiagnosis').addEventListener('click', function() {
    if (busy) return;
    conversation = []; diagnosisId = Date.now().toString(36); chatInput.value = ''; autoGrow(); welcomeMessage(); chatInput.focus();
  });
  document.getElementById('exportDiagnosis').addEventListener('click', function() {
    var payload = {format:'printlab-diagnosis-v1',exported_at:new Date().toISOString(),note:'本机最近 100 条记录；反馈为用户自报，未复测不等于已解决。',records:records};
    var url = URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)], {type:'application/json'}));
    var link = document.createElement('a'); link.href = url; link.download = 'PrintLab-诊断与复测记录.json'; link.click(); setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  });
  updateRecordCount();

  function addMessage(role, content, isHtml) {
    var wrap = document.createElement("div");
    wrap.className = "msg " + role;
    var avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = role === "user" ? "你" : "AI";
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    if (isHtml) bubble.innerHTML = content; else bubble.textContent = content;
    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  function welcomeMessage() {
    messagesEl.innerHTML = '';
  }

  function typeReply(bubble, text) {
    var characters = Array.from(text);
    var position = 0;
    bubble.setAttribute('aria-busy', 'true');
    return new Promise(function (resolve) {
      function tick() {
        // Only follow the reply while the reader is already near the bottom.
        var follow = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
        position = document.hidden ? characters.length : position + 1;
        bubble.innerHTML = renderMd(characters.slice(0, position).join(''));
        if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
        if (position < characters.length) {
          setTimeout(tick, 16);
        } else {
          bubble.removeAttribute('aria-busy');
          resolve();
        }
      }
      tick();
    });
  }

  function sendChat(text) {
    if (busy) return;
    var content = (text != null ? text : chatInput.value).trim();
    if (!content) return;
    var invalid = Array.from(document.querySelectorAll('.context-grid input')).find(function(el) { return !el.checkValidity(); });
    if (invalid) { document.getElementById('printContext').open = true; invalid.reportValidity(); return; }
    var background = printBackground();
    var requestText = content + (background ? '\n【本轮打印背景】' + background : '');
    if (requestText.length > 2000) { addMessage('ai', '请把问题缩短到 2000 字以内（含打印背景）。'); return; }
    var welcome = document.getElementById("welcome");
    if (welcome) welcome.remove();
    chatInput.value = "";
    autoGrow();
    addMessage("user", content + (background ? '\n打印背景：' + background : ''));
    busy = true;
    sendBtn.disabled = true;
    document.getElementById('newDiagnosis').disabled = true;
    document.getElementById('printContext').open = false;
    var started = performance.now();
    var record = {id:Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,7),diagnosis_id:diagnosisId,created_at:new Date().toISOString(),message:content,background:background,history:conversation.slice(-10),feedback:null};
    var typingBubble = addMessage("ai", '<span class="typing"><i></i><i></i><i></i></span>', true);

    fetch("/agent/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: requestText, history: conversation.slice(-10) })
    })
      .then(function (r) { return readJson(r).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        typingBubble.parentElement.remove();
        if (res.ok && res.d.reply) {
          conversation.push({role: "user", content: requestText}, {role: "assistant", content: res.d.reply});
          conversation = conversation.slice(-10);
          record.reply = res.d.reply; record.tools_used = res.d.tools_used || [];
          record.strategy_version = res.d.strategy_version || 'unknown'; record.model = res.d.model || 'unknown';
          record.latency_ms = res.d.latency_ms || Math.round(performance.now() - started); record.usage = res.d.usage || null;
          records.push(record); saveRecords();
          var replyBubble = addMessage("ai", "");
          return typeReply(replyBubble, res.d.reply).then(function () {
            attachRetest(replyBubble, record);
          });
        } else {
          var err = (res.d && res.d.error) || "未知错误";
          record.error = err; records.push(record); saveRecords();
          addMessage("ai", '<span class="md-error">' + escapeHtml(err) + "</span>", true);
        }
      })
      .catch(function (e) {
        record.error = e.message; records.push(record); saveRecords();
        if (typingBubble.parentElement) typingBubble.parentElement.remove();
        addMessage("ai", '<span class="md-error">网络请求失败：' + escapeHtml(e.message) + "</span>", true);
      })
      .finally(function () {
        busy = false;
        sendBtn.disabled = false;
        document.getElementById('newDiagnosis').disabled = false;
        chatInput.focus();
      });
  }

  function autoGrow() {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + "px";
  }
  chatInput.addEventListener("input", autoGrow);
  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
  });
  sendBtn.addEventListener("click", function () { sendChat(); });

  document.getElementById("quickChips").addEventListener("click", function (e) {
    var btn = e.target.closest(".chip");
    if (btn) sendChat(btn.dataset.q);
  });

  /* ---------- 工具调用 ---------- */
  function toolCall(url, payload, resultId, btn) {
    var el = document.getElementById(resultId);
    btn.disabled = true;
    var oldText = btn.textContent;
    btn.textContent = "计算中…";
    el.className = "result";
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return readJson(r).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d.result != null) {
          el.textContent = res.d.result;
          el.className = "result show";
          el.scrollTop = 0;
        } else {
          el.innerHTML = '<span class="err">' + escapeHtml((res.d && res.d.error) || "调用失败") + "</span>";
          el.className = "result show";
          el.scrollTop = 0;
        }
      })
      .catch(function (e) {
        el.innerHTML = '<span class="err">请求失败：' + escapeHtml(e.message) + "</span>";
        el.className = "result show";
          el.scrollTop = 0;
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = oldText;
      });
  }

  document.getElementById("matBtn").addEventListener("click", function () {
    toolCall("/agent/api/tool/temperature", { material: document.getElementById("matInput").value }, "matResult", this);
  });
  document.getElementById("matInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("matBtn").click();
  });

  document.getElementById("pBtn").addEventListener("click", function () {
    toolCall("/agent/api/tool/params", {
      nozzle_diameter: parseFloat(document.getElementById("pNozzle").value) || 0.4,
      layer_height: parseFloat(document.getElementById("pLayer").value) || 0.2,
      wall_count: parseInt(document.getElementById("pWalls").value, 10) || 3,
      infill_density: parseFloat(document.getElementById("pInfill").value) || 20,
      print_speed: parseFloat(document.getElementById("pSpeed").value) || 60
    }, "pResult", this);
  });

  document.getElementById("tBtn").addEventListener("click", function () {
    toolCall("/agent/api/tool/time", {
      model_weight_g: parseFloat(document.getElementById("tWeight").value) || 0,
      layer_height: parseFloat(document.getElementById("tLayer").value) || 0.2,
      nozzle_diameter: parseFloat(document.getElementById("tNozzle").value) || 0.4,
      print_speed: parseFloat(document.getElementById("tSpeed").value) || 60,
      material_density: parseFloat(document.getElementById("tDensity").value) || 1.24
    }, "tResult", this);
  });

  /* ---------- 初始化：状态、材料、温度速览图 ---------- */
  var badge = document.getElementById("statusBadge");
  var datalist = document.getElementById("matList");

  function renderTempChart(rows) {
    var chart = document.getElementById("tempChart");
    var axis = chart.querySelector(".chart-axis");
    var MIN = 170, MAX = 320, SPAN = MAX - MIN;
    rows.forEach(function (r) {
      if (r.nozzle_lo == null || r.nozzle_hi == null) return;
      var row = document.createElement("div");
      row.className = "t-row";
      var name = document.createElement("div");
      name.className = "t-name";
      name.textContent = r.name;
      name.title = r.notes;
      var track = document.createElement("div");
      track.className = "t-track";
      var bar = document.createElement("div");
      bar.className = "t-bar";
      var left = Math.max(0, (r.nozzle_lo - MIN) / SPAN * 100);
      var width = (r.nozzle_hi - r.nozzle_lo) / SPAN * 100;
      bar.style.left = left + "%";
      bar.style.width = Math.max(width, 1.2) + "%";
      bar.title = r.name + "：" + r.nozzle_lo + "-" + r.nozzle_hi + "℃\n" + r.notes;
      track.appendChild(bar);
      var range = document.createElement("div");
      range.className = "t-range";
      range.textContent = r.nozzle_lo + "-" + r.nozzle_hi;
      row.appendChild(name);
      row.appendChild(track);
      row.appendChild(range);
      chart.insertBefore(row, axis);
    });
  }

  function init() {
    fetch("/agent/api/status")
      .then(function (r) { return readJson(r); })
      .then(function (d) {
        var mats = d.materials || [];
        mats.forEach(function (m) {
          var opt = document.createElement("option");
          opt.value = m;
          datalist.appendChild(opt);
        });
        if (d.agent_ready) {
          badge.textContent = "AI 对话已就绪";
          badge.className = "badge badge-ready";
        } else {
          badge.textContent = "工具可用 · AI 待配置";
          badge.className = "badge badge-off";
          badge.title = (d.error || "").slice(0, 200);
        }
      })
      .catch(function () {
        badge.textContent = "服务未连接";
        badge.className = "badge badge-off";
      });

    fetch("/agent/api/materials")
      .then(function (r) { return readJson(r); })
      .then(function (rows) { renderTempChart(rows); })
      .catch(function () { /* 忽略，图表缺失不影响核心功能 */ });

    welcomeMessage();
  }

  init();
})();
(function () {
  'use strict';
  var views = ['home', 'workspace', 'tools', 'materials'];
  var links = document.querySelectorAll('a[href^="#"]');
  function showView() {
    var name = location.hash.slice(1) || new URLSearchParams(location.search).get('view');
    if (name === 'top' || !views.includes(name)) name = 'home';
    document.body.dataset.view = name;
    document.querySelectorAll('[data-screen]').forEach(function (screen) {
      var active = screen.dataset.screen === name;
      screen.hidden = !active;
      screen.classList.toggle('is-active', active);
    });
    document.querySelectorAll('.topbar nav a').forEach(function (link) {
      var target = link.getAttribute('href').slice(1);
      if ((target === 'top' ? 'home' : target) === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.getElementById('viewCounter').textContent = '0' + (views.indexOf(name) + 1) + ' / 04';
    requestAnimationFrame(updatePagers);
  }
  links.forEach(function (link) {
    link.addEventListener('click', function (event) {
      event.preventDefault();
      var hash = link.getAttribute('href');
      if (location.hash !== hash) history.pushState(null, '', hash);
      showView();
    });
  });
  window.addEventListener('popstate', showView);
  window.addEventListener('hashchange', showView);
  var tabs = Array.from(document.querySelectorAll('[data-tool-target]'));
  function selectTool(tab) {
    tabs.forEach(function (item) {
      var active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('[data-tool]').forEach(function (panel) {
      panel.hidden = panel.dataset.tool !== tab.dataset.toolTarget;
    });
    requestAnimationFrame(updatePagers);
  }
  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () { selectTool(tab); });
    tab.addEventListener('keydown', function (event) {
      var next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next != null) { event.preventDefault(); selectTool(tabs[next]); tabs[next].focus(); }
    });
  });
  function updatePagers() {
    document.querySelectorAll('[data-pager]').forEach(function (pager) {
      var content = document.getElementById(pager.dataset.pager);
      var overflow = content.scrollHeight > content.clientHeight + 2;
      pager.style.visibility = overflow ? 'visible' : 'hidden';
      pager.querySelector('[data-step="-1"]').disabled = content.scrollTop <= 1;
      pager.querySelector('[data-step="1"]').disabled = content.scrollTop + content.clientHeight >= content.scrollHeight - 2;
    });
  }
  document.querySelectorAll('[data-pager]').forEach(function (pager) {
    var content = document.getElementById(pager.dataset.pager);
    pager.addEventListener('click', function (event) {
      var button = event.target.closest('[data-step]');
      if (button) content.scrollBy({ top: Number(button.dataset.step) * Math.max(40, content.clientHeight - 32), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    });
    content.addEventListener('scroll', updatePagers);
    new ResizeObserver(updatePagers).observe(content);
    new MutationObserver(function () { requestAnimationFrame(updatePagers); }).observe(content, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class']});
  });
  showView();
})();
