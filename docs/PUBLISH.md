# 发布到插件市场（awesome-dsh-plugin）

这个插件市场的「列表」不是上传到某个后台，而是收录在社区仓库
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 里；
DSH 的插件市场（`dshmarket`）读的就是它的索引。上架 = 一个新增条目文件的 PR。

> 本仓库已按 GitHub 账号 `AnnaAlexyevna` 填好（`package.json` / `README.md` /
> `docs/market-entry.yml`）；换账号时全局替换 `AnnaAlexyevna` 即可。

## 0. 收录硬性要求

- [x] 仓库 `package.json` 声明了 `dsh.bundle`（本仓库已满足；只有 `dsh.client` 不算）
- [ ] 仓库是公开的 GitHub 仓库，且**创建满 1 天**
- [ ] 仓库加了 topic `dsh-plugin`
- [ ] 描述与代码一致，别夸大（评审会对着代码看）
- [ ] 依赖指向原作者（本插件零运行时依赖）

## 1. 本地校验

```powershell
$node = 'C:\Users\ASUS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

# 语法
& $node --check index.js
Get-ChildItem lib,test -Recurse -Filter *.js | ForEach-Object { & $node --check $_.FullName }

# 全部测试（23 + 10 + client checks）
& $node test\smoke.mjs
& $node test\host-integration.mjs
& $node test\check-client.cjs

# 打包检查（tarball 里应包含 index.js client.js lib/ locale/ cordis.patch.yml icon.svg README LICENSE package.json）
& 'C:\Users\ASUS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs' pack
& 'C:\Program Files\7-Zip\7z.exe' l dsh-usage-watch-1.0.0.tgz   # 或 tar -tf
```

## 2. 发布到 npm

```sh
npm login            # 浏览器授权，账号需能发布 dsh-usage-watch（该名字目前未被占用）
npm publish          # publishConfig.access = public
npm view dsh-usage-watch version dist.tarball
```

如果不想发 npm：也可以在 GitHub Release 里附上 `pnpm pack` 生成的 tgz，并在市场条目里加一行
`tarball: <release 里的 tgz 地址>`（官方推荐仍是发 npm，安装更顺）。

## 3. 建 GitHub 仓库

```sh
cd D:\DSH-Workspace\dsh-usage-watch
git init -b main
git add .
git commit -m "feat: dsh-usage-watch 1.0.0 — Doubao/WorkBuddy/DSH token floating monitor"
# 先在 GitHub 网页建空仓库 dsh-usage-watch，再：
git remote add origin https://github.com/AnnaAlexyevna/dsh-usage-watch.git
git push -u origin main
```

建好后在仓库 **Settings → Topics** 加 `dsh-plugin`。

> 仓库创建满 1 天后才能被收录；可以先 push、发 npm，第二天再提市场 PR。

## 4. 提市场 PR

1. Fork `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`；
2. 新建 `data/plugins/AnnaAlexyevna__dsh-usage-watch.yml`，内容用本仓库的
   `docs/market-entry.yml`（`category` 固定为 `usage`）；
3. PR 只新增这一个文件，别改别人的条目；
4. PR 描述里贴：插件用途、npm 包名、截图（`docs/screenshot.png`）、以及
   `dsh plugin add dsh-usage-watch` 的安装方式。

合并后，插件市场刷新即可搜到「Usage Watch / 用量监控」。

## 5. 安装后自检

```sh
dsh plugin add dsh-usage-watch
```

- 左侧栏出现「用量监控」图标，底部出现悬浮窗开关；
- 悬浮窗可拖标题栏、可置顶、可收起，位置刷新后保留；
- `%USERPROFILE%\.dsh\usage-watch\state.json` 里 `diagnostics.services` 有真实进程探测结果。

## 常见问题

- **和旧本地版冲突**：旧包 `@local/usage-watch` 与本包都插入 `usage-watch` Host 行，
  安装前先 `dsh plugin remove usage-watch` 或停用旧 bundle。
- **engines.dsh**：本包声明 `>=0.2.0`；DSH 太旧会在安装时被拦下。
- **进程探测为空**：仅 Windows 支持；非 Windows 会显示「进程探测失败」，不伪造数据。
- **8787 / 8765 接口**：都是本机可选服务，掉线时卡片保留上次数字或回退本机统计，不影响插件本身。
