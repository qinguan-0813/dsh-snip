/**
 * dsh-snip — 浏览器半身（客户端插件）
 *
 * 干什么：
 *   1. 在输入框左侧注册一个 📷 按钮（右键出小菜单：隐藏窗口 / 截哪块屏 / 快捷键说明）
 *   2. 点按钮（或按 Alt+A）→ 让宿主抓一张全屏 PNG → 铺满窗口的浮层里框选
 *   3. 浮层带微信式标注工具栏：矩形 / 椭圆 / 箭头 / 画笔 / 马赛克 / 撤销 / 清空 / 6 色
 *   4. 完成后把图**合成一个 paste 事件派发给 composer 的 Lexical 编辑器** ——
 *      走的是和手动 Ctrl+V 完全相同的代码路径，不碰任何 DSH 内部 API。
 *
 * 坐标约定（重要）：
 *   - 底图 imgW×imgH 是**屏幕物理像素**（宿主脚本先 SetProcessDPIAware）
 *   - 浮层是 CSS 像素，比例 sx = imgW / 浮层宽
 *   - 选区/标注全部存 **CSS 像素**，只在导出那一刻乘 sx / sy 换算成物理像素
 */
window.__ModuleLoader__.load({
  id: 'dsh-snip',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-snip'
    const API = '/api/dsh-snip'
    const Z = 2147483600                 // 顶到最上层：免得被小鲸鱼之类的浮层盖住
    const COLOR = '#f5222d'              // 微信默认红
    const PALETTE = ['#f5222d', '#fa8c16', '#fadb14', '#52c41a', '#1677ff', '#722ed1']
    const MOSAIC_BLOCK = 10              // 马赛克块大小（CSS 像素）
    const MIN_DRAW = 3                   // 小于这个尺寸的框选当误触

    /* ══════════════════════════ 与宿主通信 ══════════════════════════ */

    async function jsonFetch(path, init) {
      const res = await fetch(API + path, Object.assign({ credentials: 'same-origin' }, init))
      let body = null
      try { body = await res.json() } catch { /* 空响应 */ }
      if (!res.ok || (body && body.ok === false)) {
        throw new Error((body && body.error) || `${res.status} ${res.statusText}`)
      }
      return body
    }

    const loadSettings = () => jsonFetch('/settings').then((r) => r.settings).catch(() => null)
    const saveSettings = (patch) => jsonFetch('/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => r.settings).catch(() => null)

    /** 抓屏要 1~2 秒，期间给个明确反馈（走快捷键时尤其需要） */
    async function capture(opts) {
      toast('正在截屏…', 20000)
      return jsonFetch('/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts),
      })
    }

    /* ══════════════════════════ 样式 ══════════════════════════ */

    const CSS = `
.dsnip-root { position: fixed; inset: 0; z-index: ${Z}; cursor: crosshair;
  user-select: none; -webkit-user-select: none; background: ${'#0b0d12'};
  font: 12px/1.4 var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif); }
.dsnip-img { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.dsnip-layer { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.dsnip-hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  padding: 10px 16px; border-radius: 10px; background: #000000a6; color: #fff;
  font-size: 13px; pointer-events: none; white-space: nowrap; }
.dsnip-size { position: absolute; padding: 2px 6px; border-radius: 4px; background: #000000b3;
  color: #fff; font-variant-numeric: tabular-nums; pointer-events: none; display: none; }
.dsnip-bar { position: absolute; display: none; align-items: center; gap: 2px; padding: 4px;
  border-radius: 8px; background: #1f2430f2; box-shadow: 0 6px 24px #00000059;
  color: #e8eaed; white-space: nowrap; }
.dsnip-bar button { display: inline-flex; align-items: center; justify-content: center;
  height: 28px; min-width: 28px; padding: 0 6px; border: 0; border-radius: 6px;
  background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dsnip-bar button:hover { background: #ffffff1f; }
.dsnip-bar button[data-on="1"] { background: #1677ff; color: #fff; }
.dsnip-bar button:disabled { opacity: .35; cursor: default; background: transparent; }
.dsnip-bar .sep { width: 1px; height: 18px; margin: 0 4px; background: #ffffff2e; }
.dsnip-bar .lbl { padding: 0 6px; opacity: .7; }
.dsnip-ok { background: #1677ff !important; color: #fff !important; padding: 0 12px !important; }
.dsnip-ok:hover { background: #4096ff !important; }
.dsnip-dot { width: 16px; height: 16px; border-radius: 50%; border: 2px solid transparent;
  cursor: pointer; padding: 0 !important; min-width: 16px !important; }
.dsnip-dot[data-on="1"] { border-color: #fff; box-shadow: 0 0 0 1px #00000080; }
.dsnip-check { display: inline-flex; align-items: center; gap: 5px; padding: 0 8px;
  height: 28px; border-radius: 6px; cursor: pointer; }
.dsnip-check:hover { background: #ffffff1f; }
.dsnip-check input { margin: 0; accent-color: #1677ff; }
.dsnip-menu { position: fixed; z-index: ${Z + 10}; min-width: 200px; padding: 6px;
  border-radius: 10px; background: #ffffff; color: #1f2329; border: 1px solid #00000014;
  box-shadow: 0 8px 28px #00000024; font: 13px/1.5 var(--dsw-font-family, system-ui, sans-serif);
  user-select: none; -webkit-user-select: none; }
body[data-ds-dark-theme] .dsnip-menu, html[data-ds-dark-theme] .dsnip-menu {
  background: #24262b; color: #e8eaed; border-color: #ffffff1f; box-shadow: 0 8px 28px #00000073; }
.dsnip-menu .opt { display: flex; align-items: center; gap: 9px; padding: 8px 10px;
  border-radius: 8px; cursor: pointer; white-space: nowrap; }
.dsnip-menu .opt:hover { background: #0000000f; }
body[data-ds-dark-theme] .dsnip-menu .opt:hover, html[data-ds-dark-theme] .dsnip-menu .opt:hover { background: #ffffff1a; }
.dsnip-menu .box { width: 15px; height: 15px; flex: none; border-radius: 4px;
  border: 1.5px solid #8a9099; display: inline-flex; align-items: center; justify-content: center;
  color: #fff; transition: background .12s, border-color .12s; }
.dsnip-menu .opt[data-on="1"] .box { background: #1677ff; border-color: #1677ff; }
.dsnip-menu .box svg { width: 11px; height: 11px; display: block; }
.dsnip-toast { position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%);
  z-index: ${Z + 20}; padding: 8px 14px; border-radius: 8px; background: #1f2430f2;
  color: #e8eaed; box-shadow: 0 6px 24px #00000059; pointer-events: none; }
`
    function ensureStyles() {
      if (document.getElementById('dsnip-style') !== null) return
      const el = document.createElement('style')
      el.id = 'dsnip-style'
      el.textContent = CSS
      document.head.append(el)
    }

    let toastTimer = null
    function toast(text, ms = 2200) {
      document.querySelectorAll('.dsnip-toast').forEach((n) => n.remove())
      const el = document.createElement('div')
      el.className = 'dsnip-toast'
      el.textContent = text
      document.body.append(el)
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => el.remove(), ms)
    }

    /* ══════════════════════════ 图标（内联 SVG，不依赖任何包）══════════════════════════ */

    const svg = (d, extra = '') =>
      `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
        stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`

    const ICON = {
      cursor: svg('<path d="M5 3l14 8-6 1.6L10.4 19z"/>'),
      rect: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/>'),
      ellipse: svg('<ellipse cx="12" cy="12" rx="8.5" ry="7"/>'),
      arrow: svg('<path d="M5 19L19 5"/><path d="M11 5h8v8"/>'),
      pen: svg('<path d="M4 20c3-8 5-11 7-11s1 3 3 3 3-4 6-8"/>'),
      mosaic: svg('<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>'),
      undo: svg('<path d="M9 7L4 12l5 5"/><path d="M4 12h9a6 6 0 010 12h-3"/>'),
      clear: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
      copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 00-2 2v9"/>'),
      save: svg('<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/>'),
      close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
      camera: svg('<path d="M3 8.5A2.5 2.5 0 015.5 6h1.7l1.2-2h7.2l1.2 2h1.7A2.5 2.5 0 0121 8.5v8A2.5 2.5 0 0118.5 19h-13A2.5 2.5 0 013 16.5z"/><circle cx="12" cy="12.5" r="3.2"/>'),
      caret: svg('<path d="M7 10l5 5 5-5"/>'),
    }

    /* ══════════════════════════ 标注绘制 ══════════════════════════ */

    function stroke(g, a) {
      g.strokeStyle = a.color
      g.fillStyle = a.color
      g.lineWidth = a.width
      g.lineCap = 'round'
      g.lineJoin = 'round'
    }

    /**
     * 画一条标注。坐标一律 CSS 像素。
     * @param g    目标 2D 上下文（导出时已施加 scale(sx,sy) 变换）
     * @param a    标注对象
     * @param src  马赛克的取样源画布
     * @param s    取样源相对 CSS 坐标的缩放（实时预览 =1，导出 =sx）
     */
    function drawAnno(g, a, src, s) {
      g.save()
      stroke(g, a)
      if (a.type === 'rect') {
        g.strokeRect(a.x, a.y, a.w, a.h)
      } else if (a.type === 'ellipse') {
        g.beginPath()
        g.ellipse(a.x + a.w / 2, a.y + a.h / 2, Math.abs(a.w / 2), Math.abs(a.h / 2), 0, 0, Math.PI * 2)
        g.stroke()
      } else if (a.type === 'arrow') {
        const head = Math.max(10, a.width * 4)
        const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1)
        g.beginPath(); g.moveTo(a.x1, a.y1); g.lineTo(a.x2, a.y2); g.stroke()
        g.beginPath()
        g.moveTo(a.x2, a.y2)
        g.lineTo(a.x2 - head * Math.cos(ang - 0.42), a.y2 - head * Math.sin(ang - 0.42))
        g.lineTo(a.x2 - head * Math.cos(ang + 0.42), a.y2 - head * Math.sin(ang + 0.42))
        g.closePath(); g.fill()
      } else if (a.type === 'pen') {
        const pts = a.points
        if (pts.length > 1) {
          g.beginPath(); g.moveTo(pts[0][0], pts[0][1])
          for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
          g.stroke()
        } else if (pts.length === 1) {
          g.beginPath(); g.arc(pts[0][0], pts[0][1], a.width / 2, 0, Math.PI * 2); g.fill()
        }
      } else if (a.type === 'mosaic' && src) {
        const w = Math.max(1, Math.abs(a.w)), hh = Math.max(1, Math.abs(a.h))
        const tw = Math.max(1, Math.round(w / MOSAIC_BLOCK))
        const th = Math.max(1, Math.round(hh / MOSAIC_BLOCK))
        const t = document.createElement('canvas')
        t.width = tw; t.height = th
        const tg = t.getContext('2d')
        tg.imageSmoothingEnabled = true
        tg.drawImage(src, a.x * s, a.y * s, w * s, hh * s, 0, 0, tw, th)
        const prev = g.imageSmoothingEnabled
        g.imageSmoothingEnabled = false
        g.drawImage(t, 0, 0, tw, th, a.x, a.y, w, hh)
        g.imageSmoothingEnabled = prev
      }
      g.restore()
    }

    /* ══════════════════════════ 浮层 ══════════════════════════ */

    /**
     * 打开框选浮层。
     * @param shot  宿主返回的 { dataUrl, width, height }
     * @param opts  { settings, onSettings }
     * @returns 控制器 { destroy }
     */
    function openOverlay(shot, opts) {
      ensureStyles()
      document.querySelectorAll('.dsnip-toast').forEach((n) => n.remove())   // 「正在截屏…」到此为止
      const imgW = shot.width, imgH = shot.height
      const prevActive = document.activeElement

      const root = document.createElement('div')
      root.className = 'dsnip-root'
      const img = document.createElement('img')
      img.className = 'dsnip-img'
      img.draggable = false
      img.src = shot.dataUrl
      const layer = document.createElement('canvas')
      layer.className = 'dsnip-layer'
      const hint = document.createElement('div')
      hint.className = 'dsnip-hint'
      hint.textContent = '按住左键拖动框选 · Esc 取消'
      const sizeTag = document.createElement('div')
      sizeTag.className = 'dsnip-size'
      const bar = document.createElement('div')
      bar.className = 'dsnip-bar'
      root.append(img, layer, sizeTag, bar, hint)
      document.body.append(root)

      // 进 HTML 全屏，一举两得：
      //   ① 右上角那三个**原生**窗口按钮（最小化/最大化/关闭）会消失 —— 截屏时用不着，
      //      而且它们是 Electron 的标题栏覆盖层，网页样式盖不住，只有全屏能让它们让位；
      //   ② 浮层从此铺满整块屏，选区不再被限制在 DSH 窗口范围内。
      const openedAt = Date.now()
      let enteredFullscreen = false
      const goFullscreen = async () => {
        if (document.fullscreenElement !== null) return
        try {
          await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
          enteredFullscreen = document.fullscreenElement !== null
        } catch { enteredFullscreen = false }
      }
      void goFullscreen()
      const onFsChange = () => {
        // 全屏里按 Esc：浏览器会先退全屏。直接当成「取消」，省得主人按两次。
        if (enteredFullscreen && document.fullscreenElement === null && Date.now() - openedAt > 800) {
          controller.destroy()
        }
      }
      document.addEventListener('fullscreenchange', onFsChange)

      const g = layer.getContext('2d')
      let viewW = root.clientWidth, viewH = root.clientHeight
      let dpr = Math.min(window.devicePixelRatio || 1, 2)
      // 马赛克实时预览的取样源：CSS 尺寸的底图副本
      const base = document.createElement('canvas')

      /** 所有可变状态集中一处，render() 只读它 */
      const st = {
        ready: false,
        sel: null,                  // { x, y, w, h } CSS 像素
        annos: [],                  // 已提交标注
        draft: null,                // 正在画的
        tool: 'cursor',             // cursor | rect | ellipse | arrow | pen | mosaic
        color: COLOR,
        width: 2,
        hover: null,                // 悬停的窗口矩形（吸附用）
        mode: null,                 // new | move | resize | draw
        handle: null,               // nw | n | ne | e | se | s | sw | w
        anchor: null,               // 起始点
        origin: null,               // 移动/缩放开始时的快照
        snap: true,
        windows: [],
      }

      /* ---------- 尺寸 / 渲染 ---------- */
      function resize() {
        viewW = root.clientWidth; viewH = root.clientHeight
        dpr = Math.min(window.devicePixelRatio || 1, 2)
        layer.width = Math.round(viewW * dpr)
        layer.height = Math.round(viewH * dpr)
        base.width = Math.round(viewW)
        base.height = Math.round(viewH)
        const bg = base.getContext('2d')
        bg.drawImage(img, 0, 0, base.width, base.height)
        st.ready = true
        render()
      }
      const sx = () => imgW / Math.max(1, viewW)
      const sy = () => imgH / Math.max(1, viewH)

      const rectOf = (el) => el.getBoundingClientRect()
      const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

      /** 选区归一化到整数 CSS 像素，并夹在画布内 */
      function normSel(r) {
        let x = Math.min(r.x, r.x + r.w), y = Math.min(r.y, r.y + r.h)
        let w = Math.abs(r.w), hh = Math.abs(r.h)
        x = clamp(x, 0, viewW - 1); y = clamp(y, 0, viewH - 1)
        w = Math.min(w, viewW - x); hh = Math.min(hh, viewH - y)
        return { x, y, w, h: hh }
      }

      function render() {
        if (!st.ready) return
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.clearRect(0, 0, viewW, viewH)
        const sel = st.sel
        // 1) 遮罩 + 挖洞
        if (sel === null || sel.w < 1 || sel.h < 1) {
          g.fillStyle = 'rgba(0,0,0,0.42)'
          g.fillRect(0, 0, viewW, viewH)
        } else {
          g.fillStyle = 'rgba(0,0,0,0.55)'
          g.fillRect(0, 0, viewW, viewH)
          g.globalCompositeOperation = 'destination-out'
          g.fillRect(sel.x, sel.y, sel.w, sel.h)
          g.globalCompositeOperation = 'source-over'
        }
        // 2) 悬停窗口高亮（吸附预览）
        if (st.hover !== null && (sel === null || sel.w < 1)) {
          const hr = st.hover
          g.strokeStyle = '#1677ff'
          g.lineWidth = 1
          g.strokeRect(hr.x + 0.5, hr.y + 0.5, hr.w - 1, hr.h - 1)
        }
        // 3) 标注
        const all = st.draft === null ? st.annos : st.annos.concat([st.draft])
        for (const a of all) drawAnno(g, a, base, 1)
        // 4) 选区描边 + 8 个手柄
        if (sel !== null && sel.w >= 1 && sel.h >= 1) {
          g.strokeStyle = '#1677ff'
          g.lineWidth = 1
          g.strokeRect(sel.x + 0.5, sel.y + 0.5, Math.max(0, sel.w - 1), Math.max(0, sel.h - 1))
          g.fillStyle = '#1677ff'
          for (const p of handlePoints(sel)) g.fillRect(p[0] - 3, p[1] - 3, 6, 6)
          // 尺寸标签：显示的是**导出后的真实像素**
          sizeTag.style.display = 'block'
          sizeTag.textContent = `${Math.round(sel.w * sx())} × ${Math.round(sel.h * sy())}`
          const top = sel.y > 26 ? sel.y - 24 : sel.y + 4
          sizeTag.style.left = `${Math.max(2, sel.x)}px`
          sizeTag.style.top = `${top}px`
          hint.style.display = 'none'
        } else {
          sizeTag.style.display = 'none'
          hint.style.display = 'block'
        }
      }

      const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
      function handlePoints(r) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2
        const x2 = r.x + r.w, y2 = r.y + r.h
        return [[r.x, r.y], [cx, r.y], [x2, r.y], [x2, cy], [x2, y2], [cx, y2], [r.x, y2], [r.x, cy]]
      }
      function hitHandle(pt, sel) {
        if (sel === null || sel.w < 4 || sel.h < 4) return null
        const pts = handlePoints(sel)
        for (let i = 0; i < pts.length; i++) {
          if (Math.abs(pt.x - pts[i][0]) <= 6 && Math.abs(pt.y - pts[i][1]) <= 6) return HANDLES[i]
        }
        return null
      }
      const inside = (pt, r) => r !== null && pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h

      /** 光标跟着手柄变，微信那种感觉 */
      function cursorFor(pt) {
        const hd = hitHandle(pt, st.sel)
        if (hd !== null) {
          return ({ nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' })[hd]
        }
        if (st.tool !== 'cursor') return 'crosshair'
        return inside(pt, st.sel) ? 'move' : 'crosshair'
      }

      /* ---------- 窗口吸附 ---------- */
      /** 把鼠标位置换算成图片坐标系，再找最近的窗口边（窗口矩形是物理像素） */
      function snapRect(r) {
        if (!st.snap || st.windows.length === 0) return r
        const kx = sx(), ky = sy()
        const TH = 12
        const out = { ...r }
        const edges = { left: out.x, right: out.x + out.w, top: out.y, bottom: out.y + out.h }
        let best = null
        for (const w of st.windows) {
          const wx = w.x / kx, wy = w.y / ky, ww = w.width / kx, wh = w.height / ky
          const cand = [
            ['left', Math.abs(edges.left - wx)], ['right', Math.abs(edges.right - (wx + ww))],
            ['top', Math.abs(edges.top - wy)], ['bottom', Math.abs(edges.bottom - (wy + wh))],
          ].filter(([, d]) => d <= TH).sort((a, b) => a[1] - b[1])[0]
          if (cand !== undefined && (best === null || cand[1] < best[1])) best = [cand[0], cand[1], { wx, wy, ww, wh }]
        }
        if (best === null) return out
        const w = best[2]
        // 只要一条边贴上就贴：把该边对齐到窗口同侧
        if (best[0] === 'left') { out.w += out.x - w.wx; out.x = w.wx }
        if (best[0] === 'right') { out.w = (w.wx + w.ww) - out.x }
        if (best[0] === 'top') { out.h += out.y - w.wy; out.y = w.wy }
        if (best[0] === 'bottom') { out.h = (w.wy + w.wh) - out.y }
        return out
      }

      /* ---------- 指针交互 ---------- */
      const local = (ev) => {
        const r = rectOf(root)
        return { x: ev.clientX - r.left, y: ev.clientY - r.top }
      }

      function onPointerDown(ev) {
        if (ev.button !== 0) return
        // ★ 关键：工具条也是 root 的子元素，它上面的点击会冒泡到这里。
        //   不挡住的话，点「完成」会先被当成「在空白处重新框选」→ 选区被清空 → 撤单。
        if (ev.target !== root) return
        const pt = local(ev)
        const hd = hitHandle(pt, st.sel)
        if (hd !== null) {
          st.mode = 'resize'; st.handle = hd; st.origin = { ...st.sel }
          root.setPointerCapture?.(ev.pointerId)
          return
        }
        if (st.sel !== null && inside(pt, st.sel)) {
          if (st.tool === 'cursor') {
            st.mode = 'move'; st.anchor = pt; st.origin = { ...st.sel }
          } else {
            st.mode = 'draw'; st.anchor = pt
            if (st.tool === 'pen') st.draft = { type: 'pen', points: [[pt.x, pt.y]], color: st.color, width: st.width }
            else if (st.tool === 'arrow') st.draft = { type: 'arrow', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, color: st.color, width: st.width }
            else st.draft = { type: st.tool, x: pt.x, y: pt.y, w: 0, h: 0, color: st.color, width: st.width }
          }
          root.setPointerCapture?.(ev.pointerId)
          render()
          return
        }
        // 点空白（或选区外）＝重新框选；若只是单击（没拖动）则尝试选中鼠标下的窗口
        st.mode = 'new'; st.anchor = pt
        st.sel = { x: pt.x, y: pt.y, w: 0, h: 0 }
        root.setPointerCapture?.(ev.pointerId)
        render()
      }

      function onPointerMove(ev) {
        if (st.mode === null && ev.target !== root) return   // 鼠标在工具条上时别改光标/悬停
        const pt = local(ev)
        if (st.mode === null) {
          root.style.cursor = cursorFor(pt)
          const next = nearestWindow(pt)
          if (JSON.stringify(next) !== JSON.stringify(st.hover)) { st.hover = next; render() }
          return
        }
        if (st.mode === 'new') {
          st.sel = normSel({ x: st.anchor.x, y: st.anchor.y, w: pt.x - st.anchor.x, h: pt.y - st.anchor.y })
        } else if (st.mode === 'move') {
          const dx = pt.x - st.anchor.x, dy = pt.y - st.anchor.y
          st.sel = normSel({
            x: clamp(st.origin.x + dx, 0, viewW - st.origin.w),
            y: clamp(st.origin.y + dy, 0, viewH - st.origin.h),
            w: st.origin.w, h: st.origin.h,
          })
        } else if (st.mode === 'resize') {
          st.sel = resizeSel(st.origin, st.handle, pt)
        } else if (st.mode === 'draw' && st.draft !== null) {
          const a = st.draft
          if (a.type === 'pen') { a.points.push([pt.x, pt.y]) }
          else if (a.type === 'arrow') { a.x2 = pt.x; a.y2 = pt.y }
          else { const r = normSel({ x: a.x, y: a.y, w: pt.x - a.x, h: pt.y - a.y }); a.x = r.x; a.y = r.y; a.w = r.w; a.h = r.h }
        }
        render()
      }

      function resizeSel(o, hd, pt) {
        let { x, y, w, h: hh } = o
        const right = x + w, bottom = y + hh
        if (hd.includes('w')) { x = clamp(pt.x, 0, right - 1); w = right - x }
        if (hd.includes('e')) { w = clamp(pt.x, x + 1, viewW) - x }
        if (hd.includes('n')) { y = clamp(pt.y, 0, bottom - 1); hh = bottom - y }
        if (hd.includes('s')) { hh = clamp(pt.y, y + 1, viewH) - y }
        return { x, y, w, h: hh }
      }

      function onPointerUp(ev) {
        if (st.mode === null) return
        const mode = st.mode
        st.mode = null
        root.releasePointerCapture?.(ev.pointerId)
        if (mode === 'new') {
          let sel = st.sel
          if (sel !== null && (sel.w < MIN_DRAW || sel.h < MIN_DRAW)) {
            // 单击：选中鼠标下那个窗口（微信也是点一下选一扇窗）
            const win = nearestWindow(local(ev))
            sel = win === null ? null : win
          } else if (sel !== null) {
            sel = normSel(snapRect(sel))
          }
          st.sel = sel
        } else if (mode === 'resize' || mode === 'move') {
          st.sel = normSel(st.sel)
        } else if (mode === 'draw' && st.draft !== null) {
          const a = st.draft
          const tiny = (a.type === 'arrow' || a.type === 'pen')
            ? false
            : (Math.abs(a.w) < 4 && Math.abs(a.h) < 4)
          if (!tiny) st.annos.push(a)
          st.draft = null
        }
        st.hover = null
        render()
        placeBar()
      }

      /** 图片坐标 → CSS 坐标的窗口矩形 */
      function nearestWindow(pt) {
        if (st.windows.length === 0) return null
        const kx = sx(), ky = sy()
        const ix = pt.x * kx, iy = pt.y * ky
        let best = null
        for (const w of st.windows) {
          if (ix >= w.x && ix <= w.x + w.width && iy >= w.y && iy <= w.y + w.height) {
            const area = w.width * w.height
            if (best === null || area < best.area) best = { area, r: { x: w.x / kx, y: w.y / ky, w: w.width / kx, h: w.height / ky } }
          }
        }
        return best === null ? null : best.r
      }

      /* ---------- 工具栏 ---------- */
      const TOOLS = [
        ['cursor', '移动/调整选区 (V)', ICON.cursor],
        ['rect', '矩形 (R)', ICON.rect],
        ['ellipse', '椭圆 (O)', ICON.ellipse],
        ['arrow', '箭头 (A)', ICON.arrow],
        ['pen', '画笔 (P)', ICON.pen],
        ['mosaic', '马赛克 (M)', ICON.mosaic],
      ]
      bar.innerHTML =
        TOOLS.map(([k, t, ic]) => `<button data-tool="${k}" title="${t}">${ic}</button>`).join('')
        + '<span class="sep"></span>'
        + PALETTE.map((c, i) => `<button class="dsnip-dot" data-color="${c}" title="颜色 ${i + 1}" style="background:${c}"></button>`).join('')
        + '<span class="sep"></span>'
        + `<button data-act="undo" title="撤销 (Ctrl+Z)">${ICON.undo}</button>`
        + `<button data-act="clear" title="清空标注">${ICON.clear}</button>`
        + '<span class="sep"></span>'
        + `<label class="dsnip-check" title="下次截图时把 DSH 窗口藏起来，画面里就没有自己了"><input type="checkbox" data-act="hide">隐藏窗口</label>`
        + '<span class="sep"></span>'
        + `<button data-act="copy" title="复制到剪贴板 (Ctrl+C)">${ICON.copy}</button>`
        + `<button data-act="save" title="保存为 PNG">${ICON.save}</button>`
        + `<button data-act="cancel" title="取消 (Esc)">${ICON.close}</button>`
        + `<button data-act="ok" class="dsnip-ok" title="完成 (Enter)">完成</button>`

      const hideBox = bar.querySelector('input[data-act="hide"]')
      hideBox.checked = opts.settings.hideWindow === true
      hideBox.addEventListener('change', () => {
        // 本地先认：一次点击立刻生效，不依赖宿主那边的回包
        setSetting(opts.settings, 'hideWindow', hideBox.checked)
        toast(hideBox.checked ? '下次截图会隐藏 DSH 窗口' : '下次截图会保留 DSH 窗口', 1600)
      })

      function syncBar() {
        bar.querySelectorAll('[data-tool]').forEach((b) => { b.dataset.on = b.dataset.tool === st.tool ? '1' : '0' })
        bar.querySelectorAll('[data-color]').forEach((b) => {
          b.dataset.on = b.dataset.color.toLowerCase() === st.color.toLowerCase() ? '1' : '0'
          // 颜色选中态的可见性：直接描一圈
          b.style.boxShadow = b.dataset.on === '1' ? '0 0 0 2px #ffffffcc' : 'none'
        })
      }

      bar.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('button')
        if (btn === null) return
        if (btn.dataset.tool !== undefined) {
          st.tool = st.tool === btn.dataset.tool ? 'cursor' : btn.dataset.tool
          syncBar(); root.style.cursor = 'crosshair'; render(); return
        }
        if (btn.dataset.color !== undefined) { st.color = btn.dataset.color; syncBar(); return }
        const act = btn.dataset.act
        if (act === 'undo') { st.annos.pop(); render() }
        else if (act === 'clear') { st.annos = []; render() }
        else if (act === 'cancel') { controller.destroy() }
        else if (act === 'ok') { void finish('attach') }
        else if (act === 'copy') { void finish('copy') }
        else if (act === 'save') { void finish('save') }
      })

      /** 工具栏跟着选区跑：优先放选区下方，放不下就放里面/上方 */
      function placeBar() {
        const sel = st.sel
        if (sel === null || sel.w < 1) { bar.style.display = 'none'; return }
        bar.style.display = 'flex'
        const bw = bar.offsetWidth || 560, bh = bar.offsetHeight || 36
        let left = sel.x
        let top = sel.y + sel.h + 8
        if (top + bh > viewH - 4) top = Math.max(st.tool === null ? 4 : 4, sel.y - bh - 8)
        if (top < 4) top = Math.min(viewH - bh - 4, sel.y + sel.h - bh - 8)
        left = clamp(left, 4, Math.max(4, viewW - bw - 4))
        top = clamp(top, 4, Math.max(4, viewH - bh - 4))
        bar.style.left = `${left}px`
        bar.style.top = `${top}px`
      }

      /* ---------- 导出 ---------- */
      function exportCanvas() {
        const sel = st.sel
        if (sel === null || sel.w < 1 || sel.h < 1) return null
        const kx = sx(), ky = sy()
        const full = document.createElement('canvas')
        full.width = imgW; full.height = imgH
        const fg = full.getContext('2d')
        fg.drawImage(img, 0, 0, imgW, imgH)
        fg.save()
        fg.scale(kx, ky)
        for (const a of st.annos) drawAnno(fg, a, full, kx)
        fg.restore()
        const out = document.createElement('canvas')
        out.width = Math.max(1, Math.round(sel.w * kx))
        out.height = Math.max(1, Math.round(sel.h * ky))
        const og = out.getContext('2d')
        og.drawImage(full, Math.round(sel.x * kx), Math.round(sel.y * ky), out.width, out.height, 0, 0, out.width, out.height)
        return out
      }

      function toBlob(canvas) {
        return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
      }

      function stamp() {
        const d = new Date(), p = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
      }

      async function finish(action) {
        if (st.draft !== null) { st.annos.push(st.draft); st.draft = null }
        const canvas = exportCanvas()
        if (canvas === null) { toast('先框选一块区域'); return }
        const blob = await toBlob(canvas)
        if (blob === null) { toast('导出图片失败'); return }
        const name = `snip-${stamp()}.png`
        let ok = false
        if (action === 'attach') {
          ok = await attachToComposer(blob, name)
          if (!ok) {
            toast('没找到输入框，已复制到剪贴板，按 Ctrl+V 即可', 3200)
            await copyBlob(blob).catch(() => undefined)
          }
        } else if (action === 'copy') {
          try { await copyBlob(blob); toast(`已复制 ${canvas.width}×${canvas.height}`, 1600) } catch { toast('复制失败') }
          return
        } else if (action === 'save') {
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url; a.download = name
          document.body.append(a); a.click(); a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 10000)
        }
        if (action === 'attach') toast(`已放入输入框 ${canvas.width}×${canvas.height}`, 1600)
        controller.destroy()
      }

      /* ---------- 键盘 ---------- */
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); controller.destroy(); return }
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); void finish('attach'); return }
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); st.annos.pop(); render(); return }
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c' && st.sel !== null) { ev.preventDefault(); void finish('copy'); return }
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
          ev.preventDefault(); st.sel = { x: 0, y: 0, w: viewW, h: viewH }; render(); placeBar(); return
        }
        // 工具快捷键
        const map = { v: 'cursor', r: 'rect', o: 'ellipse', a: 'arrow', p: 'pen', m: 'mosaic' }
        if (!ev.ctrlKey && !ev.altKey && map[ev.key.toLowerCase()] !== undefined) {
          st.tool = map[ev.key.toLowerCase()]; syncBar(); render(); return
        }
        // 方向键微调
        if (st.sel !== null && ev.key.startsWith('Arrow')) {
          ev.preventDefault()
          const step = ev.altKey ? 10 : 1
          const dx = (ev.key === 'ArrowRight' ? step : ev.key === 'ArrowLeft' ? -step : 0)
          const dy = (ev.key === 'ArrowDown' ? step : ev.key === 'ArrowUp' ? -step : 0)
          if (ev.ctrlKey) {
            st.sel = normSel({ ...st.sel, w: st.sel.w + dx, h: st.sel.h + dy })
          } else {
            st.sel = normSel({ ...st.sel, x: st.sel.x + dx, y: st.sel.y + dy })
          }
          render(); placeBar()
        }
      }

      root.addEventListener('pointerdown', onPointerDown)
      root.addEventListener('pointermove', onPointerMove)
      root.addEventListener('pointerup', onPointerUp)
      root.addEventListener('pointercancel', onPointerUp)
      root.addEventListener('contextmenu', (ev) => { ev.preventDefault(); controller.destroy() })
      window.addEventListener('keydown', onKey, true)

      const ro = new ResizeObserver(() => resize())
      ro.observe(root)

      const controller = {
        destroy() {
          window.removeEventListener('keydown', onKey, true)
          document.removeEventListener('fullscreenchange', onFsChange)
          ro.disconnect()
          clearTimeout(barTimer)
          root.remove()
          if (enteredFullscreen && document.fullscreenElement !== null) {
            document.exitFullscreen().catch(() => { /* 已经退了就算了 */ })
          }
          if (prevActive && prevActive.isConnected && typeof prevActive.focus === 'function') {
            try { prevActive.focus({ preventScroll: true }) } catch { /* 忽略 */ }
          }
        },
      }
      let barTimer = null

      img.addEventListener('load', () => { resize(); syncBar() })
      if (img.complete) { resize(); syncBar() } else { resize(); syncBar() }
      // 窗口列表：异步拿，拿到就更新（吸附用），拿不到也不影响框选
      fetch(API + '/windows').then((r) => r.json()).then((data) => {
        if (Array.isArray(data.windows)) st.windows = data.windows.filter((w) => !w.own)
      }).catch(() => undefined)
      // 工具栏位置在首帧之后才知道宽度
      requestAnimationFrame(() => render())

      return controller
    }

    /* ══════════════════════════ 投递给输入框 ══════════════════════════ */

    let lastEditable = null
    function trackEditor() {
      document.addEventListener('focusin', (ev) => {
        const t = ev.target
        if (t && t.nodeType === 1 && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) lastEditable = t
      }, true)
    }

    /** 找 composer 的编辑器：优先 Lexical 自己打的标记，其次上次聚焦过的，再其次最靠下的 */
    function findEditor() {
      const lexical = Array.from(document.querySelectorAll('[data-lexical-editor="true"]'))
        .filter((el) => el.isConnected && el.getClientRects().length > 0)
      if (lexical.length > 0) return lexical[lexical.length - 1]
      if (lastEditable && lastEditable.isConnected) return lastEditable
      const list = Array.from(document.querySelectorAll('[contenteditable="true"]'))
        .filter((el) => el.isConnected && el.getClientRects().length > 0)
      list.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
      return list[0] ?? null
    }

    /**
     * 把 PNG 塞进输入框。手法：在编辑器元素上派发**合成 paste 事件**，
     * 走的就是用户手动 Ctrl+V 的同一段代码（Lexical 自己的 paste 处理器读 clipboardData.items）。
     */
    async function attachToComposer(blob, filename) {
      const editor = findEditor()
      if (editor === null) return false
      try { editor.focus({ preventScroll: true }) } catch { /* 忽略 */ }
      const file = new File([blob], filename, { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      editor.dispatchEvent(ev)
      return true
    }

    async function copyBlob(blob) {
      if (navigator.clipboard === undefined || typeof ClipboardItem === 'undefined') throw new Error('no clipboard')
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    }

    /* ══════════════════════════ 设置（本地优先）══════════════════════════ */

    const LS_KEY = 'dsh-snip:settings'

    function readLocal() {
      try {
        const parsed = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch { return {} }
    }

    function writeLocal(patch) {
      try { localStorage.setItem(LS_KEY, JSON.stringify({ ...readLocal(), ...patch })) } catch { /* 隐私模式等 */ }
    }

    /**
     * 改一个设置：本地先认（立刻生效、刷新后还在），再尽力同步给宿主。
     * 这样即使宿主那边的持久化出问题，开关也不会「点了没反应」。
     */
    function setSetting(settings, key, value) {
      settings[key] = value
      writeLocal({ [key]: value })
      void saveSettings({ [key]: value })
    }

    /* ══════════════════════════ 按钮 ══════════════════════════ */

    function ShotButton(props) {
      const [busy, setBusy] = React.useState(false)
      const [ui, setMenu] = React.useState(null)   // 菜单坐标 { x, y }
      const settings = props.settings

      const start = async (override) => {
        if (busy) return
        setBusy(true)
        try {
          const hide = override === undefined ? settings.hideWindow === true : override
          const shot = await capture({ hide, screen: settings.screen || 'window' })
          openOverlay(shot, { settings })
        } catch (err) {
          toast(`截图失败：${err && err.message ? err.message : err}`, 4000)
        } finally { setBusy(false) }
      }

      const style = {
        display: 'inline-flex', alignItems: 'center', gap: 2, height: 28, padding: '0 4px',
        border: 0, borderRadius: 8, background: 'transparent', cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary, #5f6b7a)',
      }
      return h('div', {
        style: { display: 'inline-flex', alignItems: 'center' },
        onContextMenu: (ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY }) },
      },
        h('button', {
          type: 'button', title: busy ? '正在截图…' : `截图（${settings.hotkey || 'Alt+A'}）· 右键设置`,
          onClick: () => { void start() },
          onAuxClick: (ev) => { if (ev.button === 1) void start(settings.hideWindow !== true) },
          style: { ...style, opacity: busy ? 0.5 : 1 },
        }, h('span', { style: { display: 'inline-flex' }, dangerouslySetInnerHTML: { __html: ICON.camera } })),
        h('button', {
          type: 'button', title: '截图设置',
          onClick: (ev) => {
            const r = ev.currentTarget.getBoundingClientRect()
            setMenu({ x: r.left, y: r.bottom + 4 })
          },
          style: { ...style, padding: '0 2px' },
        }, h('span', { style: { display: 'inline-flex' }, dangerouslySetInnerHTML: { __html: ICON.caret } })),
        ui !== null ? h(Menu, {
          x: ui.x, y: ui.y, settings, close: () => setMenu(null),
          onToggleHide: () => { setSetting(settings, 'hideWindow', settings.hideWindow !== true); setMenu(null) },
        }) : null,
      )
    }

    /**
     * 菜单只有一个开关：「截屏时隐藏当前窗口」。
     * 样式走 DSH 主题（浅色/深色各一套），不再自说自话。
     */
    function Menu({ x, y, settings, close, onToggleHide }) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        const onDoc = (ev) => { if (ref.current && !ref.current.contains(ev.target)) close() }
        const onKey = (ev) => { if (ev.key === 'Escape') close() }
        // 用 mousedown（不是 pointerdown）：免得把菜单内部那一次点击一起吃
        document.addEventListener('mousedown', onDoc, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDoc, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [close])
      const on = settings.hideWindow === true
      const left = Math.min(x, Math.max(8, window.innerWidth - 216))
      const top = Math.min(y, Math.max(8, window.innerHeight - 56))
      return h('div', {
        ref, className: 'dsnip-menu', style: { left, top },
        onContextMenu: (ev) => ev.preventDefault(),
      },
        h('div', {
          className: 'opt', 'data-on': on ? '1' : '0', onClick: onToggleHide,
          title: '勾上：截图前先把 DSH 窗口藏起来，画面里就没有 DSH；不勾则连 DSH 一起截',
        },
          h('span', { className: 'box' },
            on ? h('span', { dangerouslySetInnerHTML: { __html: svg('<path d="M4 12.5l5 5L20 6.5"/>', 'stroke-width="3.2"') } }) : null),
          h('span', null, '截屏时隐藏当前窗口'),
        ),
      )
    }

    /* ══════════════════════════ 插件本体 ══════════════════════════ */

    const inject = ['slots']

    function apply(ctx) {
      ensureStyles()
      trackEditor()

      // 优先级：本地存的（立刻生效、刷新还在）> 宿主给的（patch 默认值 / 落盘值）> 内置默认
      const settings = { hideWindow: false, screen: 'window', hotkey: 'Alt+A' }
      const local = readLocal()
      const hasLocal = Object.keys(local).length > 0
      if (hasLocal) Object.assign(settings, local)
      void loadSettings().then((s) => { if (s && !hasLocal) Object.assign(settings, s) })

      let busy = false
      async function trigger(override) {
        if (busy) return
        busy = true
        try {
          const hide = override === undefined ? settings.hideWindow === true : override
          const shot = await capture({ hide, screen: settings.screen || 'window' })
          openOverlay(shot, { settings })
        } catch (err) {
          toast(`截图失败：${err && err.message ? err.message : err}`, 4000)
        } finally { busy = false }
      }

      // 快捷键（DSH 窗口有焦点时生效）
      //   Alt+A        → 按当前设置截
      //   Alt+Shift+A  → 这一次反着来（设置里勾了隐藏就用保留，反之亦然）
      ctx.effect(() => {
        const onKey = (ev) => {
          const hk = String(settings.hotkey || '').trim()
          if (hk === '') return
          if (!/^(Alt|Ctrl|Shift|Meta)(\+(Alt|Ctrl|Shift|Meta))*\+[A-Za-z0-9]$/.test(hk)) return
          const parts = hk.split('+')
          const key = parts.pop().toLowerCase()
          const need = { alt: false, ctrl: false, shift: false, meta: false }
          for (const p of parts) need[p.toLowerCase()] = true
          if (ev.altKey !== need.alt || ev.ctrlKey !== need.ctrl || ev.metaKey !== need.meta) return
          const gotKey = (ev.key || '').toLowerCase()
          const gotCode = (ev.code || '').toLowerCase()
          if (gotKey !== key && gotCode !== `key${key}` && gotCode !== key) return
          if (ev.shiftKey === need.shift) {
            ev.preventDefault(); ev.stopPropagation()
            void trigger()
          } else if (!need.shift && ev.shiftKey) {
            ev.preventDefault(); ev.stopPropagation()
            void trigger(settings.hideWindow !== true)
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      })

      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          { name: 'conversation.input.left', id: NS, order: 40 },
          () => h(ShotButton, { settings, trigger }),
        ))
    }

    return { name: NS, inject, apply }
  },
})
