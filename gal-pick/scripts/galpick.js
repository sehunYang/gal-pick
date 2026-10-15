// gal-pick helper for the Aside REPL.
// Load: eval(await fs.readFile('<skill-dir>/scripts/galpick.js', 'utf8'));
// Main flow: galpick.run(page, cfg) -> compact brief  |  galpick.finish(items) -> prices + verbatim quotes.
// Everything is kept in galpick.st; print only what run/finish return.
(() => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const strip = s => (s || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const kindOf = u => u.includes("/mgallery/") ? "mgallery" : u.includes("/mini/") ? "mini" : "board";
  const pre = k => k === "board" ? "/board" : "/" + k + "/board";
  const url = (gid, kind, no) => `https://gall.dcinside.com${pre(kind)}/view/?id=${gid}&no=${no}`;
  const low = s => (s || "").toLowerCase();
  const norm = s => low(s).replace(/[\s\-_]/g, "");
  const cut = (s, n) => s.length > n ? s.slice(0, n) + "…" : s;

  const EXCL = /거래|장터|중고|뒷담|배틀|쌀먹|사진|타건|공구|로터리|게시글 등록|댓글 등록|응모/;
  const QRE = /추천|뭐 ?사|뭐가|뭐살|살까|고민|질문|\?|입문|비교|후기|사용기|리뷰|vs|어때|어떤가|괜찮|정착|만족|단점/i;
  const ACC = /케이스|커버|덮개|키캡|팜레스트|손목|받침|케이블|보강판|파우치|가방|스킨|필름|거치대|스위치 ?단품|교체용|호환|부품/;
  // model-like token: letters+digits, e.g. QK61, FC660C, R3, Air60. Spec units are dropped.
  const MODEL = /(?<![A-Za-z0-9])(?=[A-Za-z0-9+\-]*[A-Za-z])(?=[A-Za-z0-9+\-]*\d)[A-Za-z0-9][A-Za-z0-9+\-]{1,14}(?![A-Za-z0-9])/g;
  // Korean nickname + number, e.g. 두부60, 라무네60 (no space)
  const KMODEL = /(?<![가-힣])([가-힣]{2,5})(\d{2,3})(?!\d)/g;
  const KSTOP = /배터리|가격|만원|키압|무게|용량|시간|기준|정도|배열|최대|최소|버전|공홈|키보드|에는|에서|까지|부터|으로|정가|할인|배송|보증|개월|사이즈|인치|프로|퍼센트/;
  const TRADE = /WTS|WTB|팝니다|삽니다|판매|구매합니다|나눔|교환/i;
  const NOISE = /^(\d+(\.\d+)?(hz|khz|ghz|mm|cm|g|gb|tb|ms|mah|kg|w|v|fps|p|ma|t|x|k|d|s|th|st|nd|rd|m|y|h)|v\d+|ver\d+|usb\d*|ps\d|pc\d+|moq\d+|top\d+|no\d+|a4|b5|mx\d*)$/i;

  // ---------- browser-side: list collection ----------
  const LIST_FN = async (C) => {
    const P = C.kind === "board" ? "/board" : "/" + C.kind + "/board";
    const n = s => +((s || "").replace(/[^\d]/g, "")) || 0;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const seen = new Map(); let req = 0; const per = {};
    for (const [kw, cc] of C.q) {
      let next = null, got = 0;
      for (let step = 0; step < 1 + (kw ? C.deep : 0); step++) {
        let path;
        if (step === 0) {
          const u = new URLSearchParams({ id: C.gid, page: 1 });
          if (cc) u.set("exception_mode", "recommend");
          if (kw) { u.set("s_type", "search_subject_memo"); u.set("s_keyword", kw); }
          path = P + "/lists/?" + u;
        } else if (next) path = next; else break;
        if (req++) await wait(800); // keep >= 800ms between requests
        const res = await fetch(path, { credentials: "include" });
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const trs = [...doc.querySelectorAll("tr.ub-content")];
        if (!res.ok || (!trs.length && /captcha|자동입력|비정상/i.test(html))) return { err: `HTTP ${res.status}/block` };
        for (const tr of trs) {
          const num = (tr.querySelector("td.gall_num")?.textContent || "").trim();
          const a = tr.querySelector("td.gall_tit a");
          if (!/^\d+$/.test(num) || !a) continue;
          got++;
          const no = +num, prev = seen.get(no);
          const concept = cc || /recom/.test(tr.dataset.type || "") || !!tr.querySelector("td.gall_tit em[class*=recom]") ? 1 : 0;
          if (prev) { prev[5] = prev[5] || concept; continue; }
          const d = tr.querySelector("td.gall_date");
          seen.set(no, [no, a.textContent.trim().slice(0, 60),
            n(tr.querySelector("span.reply_num")?.textContent), n(tr.querySelector("td.gall_recommend")?.textContent),
            n(tr.querySelector("td.gall_count")?.textContent), concept,
            ((d?.getAttribute("title") || d?.textContent || "").trim()).slice(0, 10)]);
        }
        next = doc.querySelector("a.search_next")?.getAttribute("href") || null;
      }
      per[(cc ? "개념:" : "") + (kw || "-")] = got;
    }
    return { per, rows: [...seen.values()] };
  };

  // ---------- browser-side: full body lines + comments (filtering happens in Node) ----------
  const VIEW_FN = async (C) => {
    const P = C.kind === "board" ? "/board" : "/" + C.kind + "/board";
    const GT = { board: "G", mgallery: "M", mini: "MI" }[C.kind];
    const n = s => +((s || "").replace(/[^\d]/g, "")) || 0;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const sq = s => (s || "").replace(/\s+/g, " ").trim();
    const out = [];
    for (const [i, no] of C.nos.entries()) {
      if (i || C.delayFirst) await wait(1000); // keep >= 1s between posts
      try {
        const res = await fetch(P + "/view/?id=" + C.gid + "&no=" + no, { credentials: "include" });
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const bodyEl = doc.querySelector("div.write_div");
        if (!bodyEl) { out.push({ no, err: /captcha|자동입력|비정상/i.test(html) ? "blocked" : `no body ${res.status}` }); if (/captcha|자동입력|비정상/i.test(html)) break; continue; }
        bodyEl.querySelectorAll("br").forEach(b => b.replaceWith("\n"));
        bodyEl.querySelectorAll("p,div,li").forEach(e => e.append("\n"));
        const lines = (bodyEl.textContent || "").split("\n").map(sq).filter(Boolean).slice(0, 120);
        const cc = n(doc.querySelector("span.gall_comment")?.textContent);
        let cm = [];
        const esno = doc.querySelector("input#e_s_n_o")?.value;
        if (cc && esno) {
          await wait(500);
          const r = await fetch("/board/comment/", { method: "POST", credentials: "include",
            headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
            body: new URLSearchParams({ id: C.gid, no, cmt_id: C.gid, cmt_no: no, focus_cno: "", focus_pno: "",
              e_s_n_o: esno, comment_page: 1, sort: "", prevCnt: "", board_type: "", _GALLTYPE_: GT }) });
          const j = await r.json().catch(() => ({}));
          cm = (j.comments || [])
            .filter(c => c.memo && !/<img|<video/.test(c.memo) && c.nicktype !== "COMMENT_BOY" && String(c.is_delete || "0") === "0")
            .map(c => sq(new DOMParser().parseFromString(c.memo, "text/html").body.textContent).replace(/\s*-\s*dc (App|official App)\s*$/i, ""))
            .filter(t => t.length >= 4 && !/@\^dc\^@|^vr\/|\.(m4a|mp4|gif)\b/.test(t)).slice(0, 80);
        }
        const d = doc.querySelector("span.gall_date");
        out.push({ no, t: sq(doc.querySelector("span.title_subject")?.textContent).slice(0, 80),
          d: (d?.getAttribute("title") || d?.textContent || "").slice(0, 10).replace(/\./g, "-"),
          up: n(doc.querySelector("p.up_num")?.textContent), dn: n(doc.querySelector("p.down_num")?.textContent),
          cc, lines, cm });
      } catch (e) { out.push({ no, err: String(e).slice(0, 80) }); }
    }
    return out;
  };

  // keep quotes within 2 sentences: verbatim excerpt around the sentence that mentions the product/keyword
  const trim2 = (text, toks, kws) => {
    const ss = text.split(/(?<=[.!?。…])\s+|(?<=[ㅋㅎㅠㅜ]{2})\s+/);
    if (ss.length <= 2 && text.length <= 220) return text;
    const has = list => { const t = list.map(norm).filter(Boolean); return ss.findIndex(s => t.some(k => norm(s).includes(k))); };
    let i = has(toks); if (i < 0) i = has(kws); if (i < 0) i = 0;
    let out = ss.slice(i, i + 2).join(" ");
    if (out.length > 220) out = out.slice(0, 220) + "…";
    return (i > 0 ? "…" : "") + out + (i + 2 < ss.length && !out.endsWith("…") ? " …" : "");
  };

  const fresh = () => ({ stage: "idle", gals: [], galAlt: [], sr: [], lists: {}, queue: [], posts: {}, viewCount: 0,
    cands: [], bank: [], sent: {}, log: {}, recencyOld: 0.4, cfg: null, t0: 0 });

  const G = {
    st: fresh(),
    url,
    reset() { G.st = fresh(); },

    score(up, cc, concept, date, dn = null) {
      const base = 1 + Math.log(1 + up) + 0.7 * Math.log(1 + cc);
      const fav = dn == null ? 1 : (up + 1) / (up + dn + 2);
      const days = date ? (Date.now() - new Date(date)) / 864e5 : 0;
      const rec = !(days >= 0) || days <= 365 ? 1 : days <= 730 ? 0.7 : G.st.recencyOld;
      return +(base * (concept ? 2.5 : 1) * fav * rec).toFixed(2);
    },

    async galleries(q) {
      const h = await (await fetch("https://search.dcinside.com/gallery/q/" + encodeURIComponent(q))).text();
      const m = new Map();
      for (const x of h.matchAll(/href="(https?:\/\/gall\.dcinside\.com\/[^"]*?lists[^"]*?id=(\w+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
        const name = strip(x[3]), kind = kindOf(x[1]), key = kind + ":" + x[2];
        if (name && !m.has(key)) m.set(key, [x[2], kind, name]);
      }
      return [...m.values()];
    },

    // integrated post search -> [[gid, kind, no, title, galleryName, date, snippet]]
    async search(q, pages = 1) {
      const out = [];
      for (let p = 1; p <= pages; p++) {
        if (p > 1) await wait(800);
        const h = await (await fetch(`https://search.dcinside.com/post${p === 1 ? "" : "/p/" + p}/sort/accuracy/q/${encodeURIComponent(q)}`)).text();
        const ul = h.split('class="sch_result_list"')[1]?.split("</ul>")[0] || "";
        let got = 0;
        for (const li of ul.split("<li>").slice(1)) {
          const a = li.match(/href="([^"]+view[^"]*?id=(\w+)&(?:amp;)?no=(\d+))"[^>]*class="tit_txt"[^>]*>([\s\S]*?)<\/a>/);
          if (!a) continue; got++;
          out.push([a[2], kindOf(a[1]), +a[3], strip(a[4]).slice(0, 80), strip(li.match(/class="sub_txt">([\s\S]*?)<\/a>/)?.[1]),
            (li.match(/date_time">([^<]+)/)?.[1] || "").slice(0, 10).replace(/\./g, "-"), strip(li.match(/<p class="link_dsc_txt">([\s\S]*?)<\/p>/)?.[1]).slice(0, 200)]);
        }
        if (got < 20) break;
      }
      return out;
    },

    // ================= main collection =================
    // cfg: { type:'item'|'food'|'place', cat, sq:[통합검색어], gq:[갤 검색어(띄어쓰기 X)], kw:[판별 키워드],
    //        brands:[브랜드·별칭], prefer:[선호 갤러리 이름 일부], gals:[{gid,kind,name}] (지정 시 그것만),
    //        max: 20 (본문 읽기 수, 최대 30), budgetMs: 95000 }
    async run(page, cfg) {
      const S = G.st; S.cfg = cfg; S.t0 = Date.now();
      const deadline = Date.now() + (cfg.budgetMs || 95000);
      if (cfg.type && cfg.type !== "item") S.recencyOld = 0.2;
      // 1) integrated search
      S.stage = "search"; S.sr = [];
      for (const [i, q] of (cfg.sq || []).entries()) { if (i) await wait(800); S.sr.push(...await G.search(q, 2)); }
      // 2) galleries
      S.stage = "galleries";
      if (cfg.gals?.length) S.gals = cfg.gals.map(g => ({ ...g, name: g.name || g.gid }));
      else {
        const gl = cfg.cat ? await G.galleries(cfg.cat) : [];
        const freq = {}, nm = {};
        for (const r of S.sr) { const k = r[1] + ":" + r[0]; freq[k] = (freq[k] || 0) + 1; nm[k] = r[4]; }
        const cand = new Map();
        gl.forEach(([gid, kind, name], i) => { if (!EXCL.test(name)) cand.set(kind + ":" + gid, { gid, kind, name, i }); });
        for (const k in freq) if (!cand.has(k) && !EXCL.test(nm[k] || "")) { const [kind, gid] = k.split(":"); cand.set(k, { gid, kind, name: nm[k], i: 99 }); }
        const pref = (cfg.prefer || []).map(low);
        const ranked = [...cand.entries()].map(([k, g]) => ({ ...g, f: freq[k] || 0,
          sc: (freq[k] || 0) + (pref.some(p => low(g.name).includes(p)) ? 30 : 0) + Math.max(0, 10 - g.i * 0.5) + (g.kind !== "board" ? 3 : 0) }))
          .sort((a, b) => b.sc - a.sc);
        S.gals = ranked.slice(0, 3); S.galAlt = ranked.slice(3, 7);
      }
      // 3) lists
      S.stage = "lists";
      const gq = (cfg.gq || []).slice(0, 2);
      const q = gq.length ? gq.flatMap(w => [[w, 1], [w, 0]]) : [["", 1], ["", 0]];
      for (const g of S.gals) {
        if (S.lists[g.gid]) continue;
        const r = await page.evaluate(LIST_FN, { gid: g.gid, kind: g.kind, q, deep: 1 });
        S.lists[g.gid] = r.err ? { err: r.err, rows: [] } : { per: r.per, rows: r.rows };
      }
      // 4) relevance-first selection
      S.stage = "select";
      const terms = [...new Set([...(cfg.kw || []), ...gq, ...(cfg.brands || []), ...(cfg.sq || []).flatMap(s => s.split(/\s+/))]
        .map(low).filter(t => t.length >= 2))];
      const pool = new Map();
      const add = (gid, kind, no, t, d, up, cc, k, src) => {
        const key = gid + ":" + no, tl = low(t);
        if (TRADE.test(t)) return; // sale/trade posts
        let rel = terms.some(x => tl.includes(x)) ? 2 : QRE.test(t) ? 1 : 0;
        if (src === "s") rel = Math.max(rel, 1); // search engine matched the body
        if (!rel) return;
        const prev = pool.get(key);
        const est = up == null ? G.score(0, 3, 0, d) : G.score(up, cc, k, d);
        if (prev) { prev.rel = Math.max(prev.rel, rel); if (up != null) Object.assign(prev, { up, cc, k, s: est }); return; }
        pool.set(key, { gid, kind, no, t, d, up, cc, k, rel, s: est });
      };
      const chosen = new Set(S.gals.map(g => g.gid));
      for (const r of S.sr) if (chosen.has(r[0])) add(r[0], r[1], r[2], r[3], r[5], null, null, 0, "s");
      for (const g of S.gals) for (const x of S.lists[g.gid].rows) add(g.gid, g.kind, x[0], x[1], x[6], x[3], x[2], x[5], "l");
      const max = Math.min(30, cfg.max || 20), capPer = Math.ceil(max * 0.5), perG = {};
      S.queue = [...pool.values()].sort((a, b) => b.rel - a.rel || b.s - a.s)
        .filter(p => !S.posts[p.gid + ":" + p.no] && (perG[p.gid] = (perG[p.gid] || 0) + 1) <= capPer).slice(0, Math.max(0, max - S.viewCount));
      S.log.pool = pool.size;
      return G._read(page, deadline);
    },

    // continue reading after a time-budget stop
    async resume(page, budgetMs = 95000) { return G._read(page, Date.now() + budgetMs); },

    async _read(page, deadline) {
      const S = G.st; S.stage = "views";
      while (S.queue.length && S.viewCount < 30) {
        if (Date.now() + 16000 > deadline) return G.brief(true);
        const g = S.queue[0].gid, chunk = [];
        while (chunk.length < 8 && S.queue.length && S.queue[0].gid === g) chunk.push(S.queue.shift());
        const r = await page.evaluate(VIEW_FN, { gid: g, kind: chunk[0].kind, nos: chunk.map(p => p.no), delayFirst: S.viewCount > 0 });
        S.viewCount += r.length;
        for (const p of r) {
          const meta = chunk.find(c => c.no === p.no);
          S.posts[g + ":" + p.no] = p.err ? { ...meta, err: p.err } : { ...meta, ...p, s: G.score(p.up, p.cc, meta.k, p.d, p.dn) };
        }
        if (r.some(p => p.err === "blocked")) { S.log.blocked = true; S.queue = []; break; }
      }
      G._analyze();
      S.stage = "done";
      return G.brief(false);
    },

    _analyze() {
      const S = G.st, cfg = S.cfg || {};
      const kw = (cfg.kw || []).map(low), brands = (cfg.brands || []).map(low).filter(Boolean);
      const posts = Object.values(S.posts).filter(p => !p.err).sort((a, b) => b.s - a.s);
      S.sent = {}; const agg = {};
      const tokensOf = s => {
        s = s.replace(/https?:\/\/\S+|\S+\.(com|net|kr|io|me)\/\S*/gi, " ");
        const l = low(s), out = new Set();
        for (const m of s.matchAll(KMODEL)) if (!KSTOP.test(m[1])) out.add(m[1] + m[2]);
        for (const m of s.match(MODEL) || []) { const t = norm(m); if (!NOISE.test(t) && (!/^\d/.test(t) || /^\d+[a-z]+\d/.test(t))) out.add(t); }
        for (const b of brands) if (l.includes(b)) out.add(norm(b));
        return out;
      };
      posts.forEach((p, i) => {
        p.pid = i + 1;
        const units = [];
        const bodyS = p.lines.flatMap(l => l.split(/(?<=[.!?。])\s+|(?<=[ㅋㅎㅠㅜ]{2})\s+/)).map(s => s.trim()).filter(s => s.length >= 2);
        bodyS.forEach((s, j) => units.push({ id: `${p.pid}b${j + 1}`, s: s.slice(0, 300), c: 0 }));
        p.cm.forEach((s, j) => units.push({ id: `${p.pid}c${j + 1}`, s: s.slice(0, 300), c: 1 }));
        const seenB = new Set(), seenC = new Set();
        for (const u of units) {
          u.tok = tokensOf(u.s); u.kw = kw.some(k => low(u.s).includes(k));
          S.sent[u.id] = { s: u.s, key: p.gid + ":" + p.no, c: u.c };
          for (const t of u.tok) {
            const seen = u.c ? seenC : seenB; if (seen.has(t)) continue; seen.add(t);
            const a = agg[t] || (agg[t] = { t, posts: new Set(), w: 0, ids: [] });
            a.posts.add(p.pid); a.w += p.s * (u.c ? 0.5 : 1); if (a.ids.length < 4) a.ids.push(u.id);
          }
        }
        p.units = units;
      });
      // title tokens count too (e.g. "FC660C 저소음 어떤가요?" + comments)
      for (const p of posts) for (const t of tokensOf(p.t)) {
        const a = agg[t] || (agg[t] = { t, posts: new Set(), w: 0, ids: [] });
        if (!a.posts.has(p.pid)) { a.posts.add(p.pid); a.w += p.s * 0.5; if (a.ids.length < 4) a.ids.push("#" + p.pid); }
      }
      S.cands = Object.values(agg).sort((a, b) => b.posts.size - a.posts.size || b.w - a.w).slice(0, 18);
      const top = new Set(S.cands.map(c => c.t));
      S.bank = posts.map(p => {
        const keep = p.units.map((u, i) => ({ u, i, pr: ([...u.tok].some(t => top.has(t)) ? 2 : 0) + (u.kw ? 1 : 0) }))
          .filter(x => x.pr > 0).sort((a, b) => b.pr - a.pr || a.i - b.i).slice(0, 6).sort((a, b) => a.i - b.i).map(x => x.u);
        return { p, keep };
      }).filter(x => x.keep.length || [...tokensOf(x.p.t)].some(t => top.has(t)));
    },

    // compact text brief for the model (no JSON envelope, no URLs)
    brief(partial) {
      const S = G.st, L = [];
      const gname = g => g.name.replace(/[ⓜⓝ]$/, "");
      L.push("갤: " + S.gals.map(g => `${g.gid}=${g.name}${S.lists[g.gid]?.err ? "(오류)" : ""}`).join(", ") +
        (S.galAlt.length ? " | 대안: " + S.galAlt.map(g => `${g.gid}(${g.kind[0]})=${gname(g)}`).join(", ") : ""));
      const errs = Object.values(S.posts).filter(p => p.err).length;
      L.push(`수집: 통합검색 ${S.sr.length} · 후보글 ${S.log.pool || 0} · 읽음 ${S.viewCount}(오류 ${errs}) · ${Math.round((Date.now() - S.t0) / 1000)}s` +
        (S.log.blocked ? " · 차단 감지: 이후 경로 B" : ""));
      if (partial) { L.push(`진행 중: 남은 ${S.queue.length}건. galpick.resume(page) 호출`); return L.join("\n"); }
      if (!S.bank.length && S.sr.length) {
        L.push("본문 없음. 검색 스니펫(s#)만 사용:");
        S.sr.slice(0, 20).forEach((r, i) => { S.sent["s" + (i + 1)] = { s: r[6], key: r[0] + ":" + r[2], snip: r }; L.push(`s${i + 1} ${r[0]} ${r[5]} ${cut(r[3], 40)} | ${cut(r[6], 110)}`); });
        return L.join("\n");
      }
      L.push("후보(토큰 글수 가중 [근거ID]): " + S.cands.map(c => `${c.t} ${c.posts.size} ${c.w.toFixed(1)} [${c.ids.join(" ")}]`).join(" | "));
      for (const { p, keep } of S.bank) {
        L.push(`[${p.pid}] ${p.gid}${p.k ? " 개념" : ""} ↑${p.up}↓${p.dn} 댓${p.cc} ${p.d.slice(0, 7)} ${cut(p.t, 50)}`);
        for (const u of keep) L.push(` ${u.id} ${cut(u.s, 100)}`);
      }
      return L.join("\n");
    },

    // ================= Danawa =================
    async _danawaOne(q, cat, retry = 1) {
      const h = await (await fetch("https://search.danawa.com/dsearch.php?query=" + encodeURIComponent(q))).text();
      if (!/<li\s+id="productItem/.test(h) && retry && !/검색결과가 없|검색된 상품이 없/.test(h)) { await wait(1500); return G._danawaOne(q, cat, retry - 1); }
      const mt = [...q.matchAll(MODEL)].map(m => norm(m[0])).filter(t => !NOISE.test(t));
      const nameOk = nm => !ACC.test(nm) && (!mt.length || mt.some(t => norm(nm).includes(t)));
      const items = h.split(/<li\s+id="productItem/).slice(1);
      const cats = items.filter(s => /^\d+"/.test(s)).map(s => ({
        pc: s.match(/^(\d+)/)[1],
        nm: strip(s.match(/<p class="prod_name">[\s\S]*?<a\s[^>]*>([\s\S]*?)<\/a>/)?.[1]),
        ct: s.match(/productItem_categoryInfo_\d+"\s+value="([^"]+)"/)?.[1] || "",
        pr: +(s.match(/min_price_\d+"\s+value="(\d+)"/)?.[1] || 0),
        sp: strip(s.match(/<div class="spec_list">([\s\S]*?)<\/div>/)?.[1]).slice(0, 150),
        op: s.split(/<li id="productInfoDetail_/).slice(1).map(o => [
          strip(o.match(/<p class="memory_sect">[\s\S]*?<span class="text">([\s\S]*?)<\/span>/)?.[1]) || "-",
          +(o.match(/<strong>([\d,]+)<\/strong>/)?.[1] || "0").replace(/,/g, ""), +o.match(/^(\d+)/)?.[1]]).slice(0, 8),
      })).filter(x => nameOk(x.nm) && (!cat || !x.ct || x.ct.includes(cat)));
      if (cats.length) return { q, kind: "catalog", list: cats.slice(0, 2) };
      const om = items.filter(s => !/^\d+"/.test(s)).map(s => ({
        nm: strip(s.match(/<p class="prod_name">[\s\S]*?<a\s[^>]*>([\s\S]*?)<\/a>/)?.[1]),
        pr: +((s.match(/price_sect"[^>]*>\s*<strong>([\d,]+)<\/strong>/) || s.match(/<strong>([\d,]+)<\/strong>\s*원/))?.[1] || "0").replace(/,/g, "") })).filter(x => x.pr && nameOk(x.nm))
        .sort((a, b) => a.pr - b.pr);
      return { q, kind: om.length ? "openmarket" : "none", list: om.slice(0, 2) };
    },

    // items: [{ name:'CIDOO QK61', dn:'CIDOO QK61'(다나와 검색어, 생략 시 name, 음식·장소는 null), tok:['qk61'], q:['2b1','5c3','9c1+9c2'] }]
    // opts: { cat:'키보드', budget:[min,max] }
    async finish(items, opts = {}) {
      const S = G.st, L = [], [bmin, bmax] = opts.budget || [0, Infinity];
      const won = n => n.toLocaleString("ko-KR") + "원";
      const qs = items.filter(it => it.dn !== null).map(it => it.dn || it.name);
      const dres = {};
      for (let i = 0; i < qs.length; i += 3) { // 3 at a time (Danawa pages are heavy)
        if (i) await wait(800);
        (await Promise.all(qs.slice(i, i + 3).map(q => G._danawaOne(q, opts.cat).catch(e => ({ q, kind: "error", list: [], e: String(e) })))))
          .forEach(r => dres[r.q] = r);
      }
      const gname = gid => (S.gals.find(g => g.gid === gid)?.name || gid).replace(/ⓜ$/, "(마이너)").replace(/ⓝ$/, "(미니)");
      for (const it of items) {
        L.push(`### ${it.name}`);
        const d = dres[it.dn || it.name];
        if (d) {
          if (d.kind === "catalog") for (const x of d.list) {
            const ops = x.op.filter(o => o[1]).map(o => `${o[0]} ${won(o[1])}${o[1] >= bmin && o[1] <= bmax ? "" : "(예산X)"} pcode=${o[2]}`).join(" / ");
            L.push(`다나와: ${x.nm} · 최저 ${won(x.pr)} · https://prod.danawa.com/info/?pcode=${x.pc}${ops ? " · 옵션: " + ops : ""} · 스펙: ${x.sp}`);
          } else if (d.kind === "openmarket") L.push(`다나와 가격비교 없음, 오픈마켓 최저 ${won(d.list[0].pr)} (${cut(d.list[0].nm, 50)}) · https://search.danawa.com/dsearch.php?query=${encodeURIComponent(d.q)}`);
          else L.push(`다나와 결과 없음(${d.kind}) · 검색어를 바꿔 다시 조회`);
        }
        if (it.tok?.length) {
          const ps = Object.values(S.posts).filter(p => !p.err && it.tok.some(t => p.units?.some(u => u.tok.has(norm(t))) || norm(p.t).includes(norm(t))));
          L.push(`근거 글: 개념글 ${ps.filter(p => p.k).length} · 일반 ${ps.filter(p => !p.k).length}`);
        }
        for (const id of it.q || []) {
          const ids = id.split("+"), parts = ids.map(x => S.sent[x]);
          if (parts.some(x => !x)) { L.push(`> (없는 ID: ${id})`); continue; }
          // "+" joins only consecutive body sentences of one post (never comments: different authors)
          if (ids.length > 1) {
            const m = ids.map(x => x.match(/^(\d+)b(\d+)$/));
            if (m.some(x => !x) || m.some(x => x[1] !== m[0][1]) || m.some((x, i) => i && +x[2] !== +m[i - 1][2] + 1)) {
              L.push(`> (결합 불가: ${id}. 같은 글 본문의 연속 문장만 + 가능)`); continue; }
          }
          const p0 = parts[0], post = S.posts[p0.key];
          const text = trim2(parts.map(x => x.s).join(" "), it.tok || [it.name], (S.cfg?.kw) || []);
          let meta;
          if (p0.snip) meta = `[${p0.snip[4]} · 검색 스니펫](${url(p0.snip[0], p0.snip[1], p0.snip[2])})`;
          else meta = `[${gname(post.gid)}${post.k ? " · 개념글" : ""} · 추천 ${post.up} · 댓글 ${post.cc}](${url(post.gid, post.kind, post.no)})${p0.c ? " 댓글" : ""}`;
          L.push(`> "${text}"\n> ${meta}`);
        }
      }
      return L.join("\n");
    },
  };
  globalThis.galpick = G;
})();
