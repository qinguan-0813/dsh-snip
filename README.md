# dsh-snip · DSH 微信式截图插件

在 DSH 输入框旁边加一个 📷 按钮（或按 `Alt+A`）：**框选屏幕 → 标注 → 直接贴进对话框**。
可选「截图时隐藏 DSH 窗口」，**并且不会改变窗口原有的最大化 / 全屏状态**。

- 平台：Windows（靠 PowerShell + Win32 抓屏）
- 实测环境：DSH Desktop `0.2.0-rc.2`、Windows PowerShell 5.1（没有 pwsh 7 也能跑）
- 依赖：**零**（宿主半身只用 node 内置模块；浏览器半身只用模块表里的 `react`）

> **English** — A WeChat-style screenshot plugin for DeepSeek Harness on Windows: pick a
> region, annotate it (rect / ellipse / arrow / pen / mosaic), and the PNG lands straight in
> the composer. Optionally hides the Harness window while capturing — **without touching the
> window's maximized/fullscreen state**. Zero runtime dependencies. MIT.
> Install the folder (or the npm package) as a DSH bundle; see `tools/install.mjs`.
>
> Two bugs this deliberately avoids, both found in a popular alternative: restoring the
> window with `SW_RESTORE` un-maximizes it, and PowerShell 5.1 writing stdout in the ANSI
> code page (GBK) while Node decodes it as UTF-8 — which breaks any user name or temp path
> containing non-ASCII characters.

---

## 装 / 卸

**方式一：从 GitHub 装（使用者最省事）**

在 DSH 侧栏「**插件 → 添加插件**」里填：

```
github:qinguan-0813/dsh-snip
```

点安装、再点「立即启用」即可。命令行等价写法：

```powershell
dsh plugin --profile <你的 profile> add github:qinguan-0813/dsh-snip
```

**方式二：本仓库自带的安全安装器**

（本仓库自带的安全安装器，**不跑 pnpm** —— 免得把 profile 里手做的 junction 一起冲掉）：

```powershell
# 在仓库根目录
node tools\install.mjs --link          # --link = 建 junction（改源码即时生效）
node tools\install.mjs                 # 不带 --link = 复制一份进去
node tools\install.mjs --profile "C:\Users\你\.dsh\profiles\desktop"
```

它做四件事：**备份 profile → 放进 `node_modules` → 改 `package.json`（dependencies + bundles）→ 三层校验**（字节无 BOM / JSON 可解析 / 每个 js `node --check`），并把一行现成的回滚命令打印出来。

profile 的 HMR 开着时通常**立刻生效**（本喵实测：装完按钮就出来了）；客户端半身若没出现，刷新一次页面（`Ctrl+R`）。

卸载：把 `node_modules\dsh-snip`（junction）删掉，并从 `package.json` 的
`dependencies` 与 `dsh.profile.bundles` 里去掉 `dsh-snip`。

---

## 用

| 操作 | 效果 |
|---|---|
| 左键点 📷 | 按当前设置截图 |
| 右键点 📷 / 点 ▾ | 设置菜单：隐藏窗口、截哪块屏、快捷键提示 |
| `Alt+A` | 截图 |
| `Alt+Shift+A` | 这一次**反着来**（设置勾了隐藏就用保留，反之亦然） |
| 拖拽 | 框选 |
| 单击 | 选中鼠标下的窗口 |
| 拖 8 个手柄 | 改选区大小；在选区内拖动 = 整体移动 |
| 方向键 | 微调 1px；`Ctrl+方向键` 改大小；`Alt+方向键` 每次 10px |
| `V R O A P M` | 切工具：移动 / 矩形 / 椭圆 / 箭头 / 画笔 / 马赛克 |
| 颜色圆点 | 6 色，跟着矩形/椭圆/箭头/画笔走 |
| `Ctrl+Z` | 撤销一条标注 |
| `Enter` | 完成 → 图片进输入框 |
| `Ctrl+C` | 完成 → 只复制到剪贴板 |
| `Ctrl+A` | 全选画面 |
| `Esc` / 右键 | 取消 |

工具栏右侧的 **☑ 隐藏窗口** 是持久化的，改一次就记住（存在 `$DSH_HOME/dsh-snip.json`）。

**图片怎么进输入框**：合成一个标准 `paste` 事件派发给 composer 的 Lexical 编辑器，
走的是和手动 `Ctrl+V` 完全相同的代码路径 —— 不碰任何 DSH 内部 API。

---

## 两条设计红线（都是踩过的坑换来的）

1. **绝不碰窗口的尺寸 / 状态。**
   隐藏只用 `SW_HIDE(0)`、恢复只用 `SW_SHOW(5)`，**不用 `SW_RESTORE(9)`** ——
   后者的定义就是「把最大化/全屏窗口还原成普通大小」，会让用户每截一次图就掉出全屏。
   自测脚本 `_tmp\selftest-capture.ps1` 会比对截图前后的窗口矩形与 `IsZoomed`，必须一模一样。

2. **PowerShell 的 stdout 只走 ASCII，输出路径由 Node 自己记。**
   Windows PowerShell 5.1 用**系统 ANSI 码页**（简中 = GBK）写 stdout，Node 却按 UTF-8 解。
   只要用户名或临时目录里有中文，路径回来就是乱码 → 宿主读不到文件 → 接口 500。
   所以脚本只回报 `OK <宽> <高> <x> <y> <是否隐藏>`，路径压根不从 PowerShell 那边取。
   同理：`host\capture.ps1` **纯 ASCII**，因为 BOM-less 的 .ps1 里写中文，5.1 会按 GBK 读崩。

---

## 配置

profile 的 `cordis.patch.yml` 里按 id 覆盖（**会替换整份 config**，要保留的键请全部重述）：

```yaml
- id: dsh-snip
  name: dsh-snip
  config:
    hideWindow: false        # 默认是否隐藏 DSH 窗口
    screen: window           # window | primary | all
    hotkey: Alt+A            # 留空 = 不挂快捷键
    powershell: ''           # 抓屏用的解释器绝对路径，留空 = 自动探测
    debug: false
```

界面上的改动只写 `$DSH_HOME/dsh-snip.json`，**不回头改 YAML**（免得手抖改坏启动配置）。

---

## 发版流程（owner 备忘）

```powershell
# 1. 改完代码，升版本号（package.json 的 version）
# 2. 确认包里没有多余文件、且能通过校验
npm publish --dry-run
# 3. 登录一次（浏览器授权），然后发布
npm login
npm publish
```

- 包名 `dsh-snip` 是**非 scoped** 的，所以 npm 用户名不影响别人怎么装 —— 别人永远是输入 `dsh-snip`。
- 发布后别人在 DSH「插件 → 添加插件」里填 `dsh-snip` 即可；`os: ["win32"]` 会让 macOS/Linux 上的安装被干净拒绝。
- 更新 = 升版本号再 `npm publish`（同一个版本号不能发第二次）。
- 想让人"不知道名字也能发现"，得单独去收录：`dshmarket`（清单在它自己发布的 catalog 包里，要联系作者）、`dshbase.com`、`dsh.so`，或者发帖 + GitHub。

## 变更记录

### 0.1.1

- **去掉「文字」工具**（主人要求精简）。它本来就点不动：`openText()` 里 `focus()` 之后
  没挡住 mousedown 的默认行为 —— 浏览器会把焦点抢走，于是 textarea 立刻失焦、
  被 `blur` 当成「空文字」提交并隐藏。删掉比修它更符合「工具栏别太长」的诉求
  （真要恢复：加上 `ev.preventDefault()` 再 focus 即可）。
- **修：点工具条上的任何按钮都会把选区判成「取消」**。
  工具条是浮层的子元素，`pointerdown` 冒泡到浮层后被当成「在空白处重新框选」；
  松开时框太小 → 清空选区。因为 `pointerdown` 先把工具条 `display:none` 了，
  随后的 `click` 被派发到公共祖先，**「完成」按钮的点击根本到不了**
  —— 这也是「点完成没反应」的真因。现在 `ev.target !== root` 一律不当作画布操作。
- **修：菜单**。原来是一整块写死深色的弹层，跟 DSH 主题不搭，里面还塞了屏幕选择等一堆东西。
  现在只剩一个「截屏时隐藏当前窗口」开关，颜色跟主题走（浅色/深色各一套）。
- **修：开关点了没反应**。宿主写盘用了 `{version, values}` 嵌套、读盘却没取 `.values`，
  于是回包永远是默认值。现在客户端**本地优先**（`localStorage` 立刻生效、刷新还在），
  并且每次截图都把 `hide` 明确写进请求参数，不再依赖那次回包。
- **新：进截图模式自动进 HTML 全屏**。右上角那三个**原生**窗口按钮（最小化/最大化/关闭）
  是 Electron 的标题栏覆盖层，网页盖不住，全屏才会让位；顺带把选区从
  「DSH 窗口内」解放到「整块屏幕」。全屏里按 `Esc` 直接当取消，不用按两次。
- 编辑器查找改为优先认 Lexical 的 `data-lexical-editor` 标记。

### 0.1.0

首个能用的版本：框选 / 8 手柄调整 / 6 种标注工具 / 6 色 / 撤销 / 复制 / 保存 /
隐藏窗口（不破坏最大化状态）/ `Alt+A` / 图片直进输入框。

## 已知限制 / 迭代计划

- **没有窗口边缘吸附**（社区那个插件有）。`/windows` 路由还没做，所以「单击选中整窗」暂时无效。
- **没有长截图**（滚动拼接）。
- **不做模型工具**：本插件只服务「人截图给人看」，不给模型开自动截屏的口子。
- 只支持单屏抓取（`all` 是把所有屏拼起来当一张图，不是逐屏选）。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 按钮点了弹「抓屏失败」 | 看错误里的原文。多半是 PowerShell 找不到 → 在 config 里写 `powershell:` 绝对路径 |
| 图片没进输入框，提示已复制 | 没找到 composer 编辑器：先点一下输入框再截图 |
| 窗口状态被改坏 | 不该发生。跑 `tools\selftest-capture.ps1` 定位（它会比对截图前后的窗口矩形与最大化状态） |

跑自检：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\selftest-capture.ps1
```

它会抓两张图（保留 / 隐藏）并断言窗口状态没变。<mark>注意前提</mark>：想验证「隐藏确实让 DSH 从画面里消失」，
**得先把 DSH 切到前台**再跑 —— 否则它本来就被别的窗口盖着，隐藏与否屏幕上根本没差别，
脚本会如实报 `INCONCLUSIVE` 而不是硬判失败。
