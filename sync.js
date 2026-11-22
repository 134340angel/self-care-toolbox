// Self-care Toolbox · 多端同步（端到端加密）
// 数据在设备上用同步码加密后才上传；服务器只保存密文，看不到内容。
(function () {
  "use strict";
  const API = "https://self-care-sync.selfcare-toolbox.workers.dev";
  const LS_CODE = "sleep-sync-code";
  const S = window.SleepSync;
  const box = document.getElementById("syncBox");
  if (!S || !box || !window.crypto || !crypto.subtle) return;

  const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const te = new TextEncoder(), td = new TextDecoder();
  let code = null, keys = null, busy = false, again = false, timer = null, statusText = "", statusWarn = false, mode = "off", deleteArmed = false;

  // ---------- helpers ----------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function norm(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
  function fmt(c) { return c.match(/.{1,4}/g).join("-"); }
  function valid(c) { return c.length === 16 && [...c].every(ch => ALPH.includes(ch)); }
  function newCode() { const b = crypto.getRandomValues(new Uint8Array(16)); return [...b].map(x => ALPH[x & 31]).join(""); }
  const b64 = u8 => { let s = ""; u8.forEach(x => s += String.fromCharCode(x)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  function stable(v) {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") { const o = {}; Object.keys(v).sort().forEach(k => o[k] = stable(v[k])); return o; }
    return v;
  }
  const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

  async function derive(c) {
    const base = await crypto.subtle.importKey("raw", te.encode(c), "PBKDF2", false, ["deriveBits", "deriveKey"]);
    const idBits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: te.encode("self-care-sync-id-v1"), iterations: 150000 }, base, 256);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: te.encode("self-care-sync-key-v1"), iterations: 150000 }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return { id: [...new Uint8Array(idBits)].map(x => x.toString(16).padStart(2, "0")).join(""), key };
  }
  async function encrypt(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keys.key, te.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return b64(out);
  }
  async function decrypt(s) {
    const u = unb64(s);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12) }, keys.key, u.slice(12));
    return JSON.parse(td.decode(pt));
  }

  // Newest edit wins for each record; a deletion wins if it is newer than the record.
  function merge(a, b) {
    const out = { records: {}, tombs: {}, colors: null, colorsAt: "" };
    const ar = a.records || {}, br = b.records || {}, at = a.tombs || {}, bt = b.tombs || {};
    const ids = new Set([...Object.keys(ar), ...Object.keys(br), ...Object.keys(at), ...Object.keys(bt)]);
    ids.forEach(id => {
      const ra = ar[id], rb = br[id];
      const r = !ra ? rb : !rb ? ra : ((rb.updatedAt || "") > (ra.updatedAt || "") ? rb : ra);
      const t = [at[id], bt[id]].filter(Boolean).sort().pop() || "";
      if (t && (!r || t >= (r.updatedAt || ""))) out.tombs[id] = t;
      else if (r) out.records[id] = r;
    });
    const ca = a.colorsAt || "", cb = b.colorsAt || "";
    if (cb > ca) { out.colors = b.colors || null; out.colorsAt = cb; } else { out.colors = a.colors || null; out.colorsAt = ca; }
    return out;
  }

  async function api(method, body) {
    const res = await fetch(API + "/v1/blob/" + keys.id, {
      method, cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null; try { data = await res.json(); } catch (e) {}
    return { status: res.status, ok: res.ok, data };
  }

  // ---------- sync ----------
  async function sync() {
    if (!keys) return;
    if (busy) { again = true; return; }
    busy = true; setStatus("同步中…");
    try {
      let done = false;
      for (let i = 0; i < 4 && !done; i++) {
        const cur = await api("GET");
        if (!cur.ok) throw new Error("server " + cur.status);
        let remote = { records: {}, tombs: {} };
        if (cur.data && cur.data.data) {
          try { remote = await decrypt(cur.data.data); }
          catch (e) { setStatus("云端数据无法解密：同步码可能不对", true); return; }
        }
        const local = S.snapshot();
        const merged = merge(local, remote);
        if (!same(merged, local)) S.apply(merged);
        if (cur.data && cur.data.data && same(merged, remote)) { done = true; break; }
        const put = await api("PUT", { prevVer: (cur.data && cur.data.ver) || 0, data: await encrypt(merged) });
        if (put.status === 409) continue;
        if (put.status === 413) { setStatus("数据太多，超过同步上限", true); return; }
        if (!put.ok) throw new Error("server " + put.status);
        done = true;
      }
      const t = new Date();
      setStatus("已同步 · " + String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0"));
    } catch (e) {
      setStatus(navigator.onLine === false ? "现在没有网络，联网后会自动同步" : "同步失败，稍后会自动重试", true);
    } finally {
      busy = false;
      if (again) { again = false; setTimeout(sync, 400); }
    }
  }
  function soon() { clearTimeout(timer); timer = setTimeout(sync, 1500); }
  S.onChange = () => { if (keys) soon(); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && keys) sync(); });
  window.addEventListener("online", () => { if (keys) sync(); });
  setInterval(() => { if (keys && document.visibilityState === "visible") sync(); }, 60000);

  async function connect(c) {
    code = c; keys = await derive(c); lsSet(LS_CODE, c);
    mode = "on"; draw(); await sync();
  }
  function disconnect() { code = null; keys = null; lsSet(LS_CODE, null); mode = "off"; statusText = ""; draw(); }

  // ---------- UI ----------
  function setStatus(t, warn) { statusText = t; statusWarn = !!warn; const el = document.getElementById("syncStatus"); if (el) { el.textContent = t; el.classList.toggle("warn", !!warn); } }
  function draw() {
    if (mode === "off") {
      box.innerHTML = `<div class="note" style="margin-bottom:10px">开启后，在另一台设备的这个页面输入同一个同步码，记录就会自动同步。数据会先在你的设备上加密，服务器只保存看不懂的密文。</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="primary" id="syncNew">生成同步码</button><button id="syncHave">我已经有同步码</button></div>`;
      box.querySelector("#syncNew").onclick = () => connect(newCode());
      box.querySelector("#syncHave").onclick = () => { mode = "enter"; draw(); };
    } else if (mode === "enter") {
      box.innerHTML = `<div class="field"><label for="syncInput">输入另一台设备上的同步码</label>
        <input id="syncInput" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX" style="font:inherit;font-family:var(--font-mono);font-size:16px;letter-spacing:.06em;color:var(--ink);background:var(--paper);border:1px solid var(--rule);border-radius:8px;padding:8px 10px;width:100%"></div>
        <div class="actions" style="margin-top:8px"><span class="err" id="syncErr"></span><span class="r" style="display:flex;gap:8px"><button id="syncCancel">取消</button><button class="primary" id="syncGo">连接</button></span></div>`;
      const inp = box.querySelector("#syncInput"); inp.focus();
      box.querySelector("#syncCancel").onclick = () => { mode = "off"; draw(); };
      box.querySelector("#syncGo").onclick = () => {
        const c = norm(inp.value);
        if (!valid(c)) { box.querySelector("#syncErr").textContent = "同步码应该是 16 位字母和数字，例如 ABCD-EFGH-JKLM-NPQR。"; return; }
        connect(c);
      };
    } else {
      box.innerHTML = `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px">
          <span class="note">同步码</span>
          <code id="syncCode" style="font-family:var(--font-mono);font-size:15px;letter-spacing:.06em;background:var(--paper);border:1px solid var(--rule);border-radius:8px;padding:4px 10px">••••-••••-••••-••••</code>
          <button id="syncShow">显示</button><button id="syncCopy">复制</button>
        </div>
        <div class="status" id="syncStatus" style="margin:8px 0"></div>
        <div class="note" style="margin-bottom:10px">请把同步码存好（比如存进备忘录或密码管理器）。忘了它就找不回云端的记录；别人拿到它也能看到你的记录，不要发给别人。</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button id="syncNow">立即同步</button><button id="syncOff">在这台设备关闭同步</button><button class="ghost danger" id="syncDel">删除云端数据</button></div>`;
      let shown = false;
      box.querySelector("#syncShow").onclick = e => { shown = !shown; box.querySelector("#syncCode").textContent = shown ? fmt(code) : "••••-••••-••••-••••"; e.target.textContent = shown ? "隐藏" : "显示"; };
      box.querySelector("#syncCopy").onclick = async e => { try { await navigator.clipboard.writeText(fmt(code)); e.target.textContent = "已复制"; } catch (err) { shown = true; box.querySelector("#syncCode").textContent = fmt(code); e.target.textContent = "请手动复制"; } };
      box.querySelector("#syncNow").onclick = () => sync();
      box.querySelector("#syncOff").onclick = disconnect;
      box.querySelector("#syncDel").onclick = async e => {
        if (!deleteArmed) { deleteArmed = true; e.target.textContent = "再点一次：删除云端数据并关闭同步"; return; }
        deleteArmed = false;
        try { const r = await api("DELETE"); if (!r.ok) throw 0; disconnect(); setStatus(""); }
        catch (err) { setStatus("删除失败，请稍后再试", true); }
      };
      setStatus(statusText, statusWarn);
    }
  }

  const saved = norm(lsGet(LS_CODE));
  if (valid(saved)) connect(saved); else draw();
})();
