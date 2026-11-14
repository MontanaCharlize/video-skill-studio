// 把 studio/web 转换成可被 GitHub Pages 直接托管的静态目录 docs/。
// 只做路径重写与素材复制，不改动 FastAPI 版本的行为。
import { cp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'studio', 'web');
const OUT = path.join(ROOT, 'docs');
const SAMPLES = ['metal-cover.webp', 'metal-hybrid-demo.mp4'];

const CONFIG_JS = `// 由 tools/build-pages.mjs 生成，仅首次生成，之后不会被覆盖。
// 静态托管（GitHub Pages）没有 /api 后端。把下面改成你已经部署的后端地址，
// 例如 'https://pianyu-api.example.com'（不要带结尾斜杠），页面就会把
// /api/* 请求转发到该地址。留空则在同源查找 /api/*。
window.PIANYU_API_BASE = '';
`;

async function main() {
  const missing = [];
  for (const file of ['index.html', 'studio.js', 'home.js']) {
    if (!existsSync(path.join(SRC, file))) missing.push(`studio/web/${file}`);
  }
  if (missing.length) throw new Error(`缺少源文件：${missing.join(', ')}`);

  const configFile = path.join(OUT, 'config.js');
  // docs/ 每次重建都会清空，所以先备份用户可能手改过的 config.js。
  const previousConfig = await readFile(configFile, 'utf8').catch(() => null);

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  await cp(SRC, OUT, { recursive: true });

  const indexFile = path.join(OUT, 'index.html');
  const html = await readFile(indexFile, 'utf8');
  const rewritten = html
    .replaceAll('"/ui/', '"./')
    .replaceAll("'/ui/", "'./")
    .replaceAll('"/api/examples/media/', '"./examples/')
    .replaceAll('href="/config-template"', 'href="./env.example"')
    .replace(
      /<script src="\.\/studio\.js"/,
      '<script src="./config.js"></script>\n<script src="./studio.js"',
    );

  if (rewritten === html) throw new Error('index.html 未发生任何路径重写，请检查源文件是否已变化。');
  if (!rewritten.includes('<script src="./config.js">')) {
    throw new Error('未能把 config.js 注入 index.html。');
  }
  await writeFile(indexFile, rewritten, 'utf8');

  const mediaDir = path.join(OUT, 'examples');
  await mkdir(mediaDir, { recursive: true });
  for (const name of SAMPLES) {
    const from = path.join(ROOT, 'examples', 'outputs', name);
    if (!existsSync(from)) throw new Error(`缺少样片素材：examples/outputs/${name}`);
    await cp(from, path.join(mediaDir, name));
  }

  const envExample = path.join(ROOT, '.env.example');
  if (existsSync(envExample)) await cp(envExample, path.join(OUT, 'env.example'));

  // Pages 默认走 Jekyll，会忽略下划线开头的文件；关掉它并放行常规静态文件。
  await writeFile(path.join(OUT, '.nojekyll'), '', 'utf8');
  await writeFile(path.join(OUT, '404.html'), NOT_FOUND_HTML, 'utf8');

  await writeFile(configFile, previousConfig ?? CONFIG_JS, 'utf8');

  const { size, files } = await measure(OUT);
  console.log(`docs/ 已生成：${files} 个文件，共 ${(size / 1048576).toFixed(2)} MB`);
  console.log('提交后请在仓库 Settings → Pages 选择 main 分支的 /docs 目录。');
}

const NOT_FOUND_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>片语 · 页面不存在</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1a16;color:#eefaed;font:16px/1.7 system-ui,sans-serif}main{max-width:32rem;padding:2rem;text-align:center}a{color:#a4e68d}</style>
</head>
<body><main><h1>页面不存在</h1>
<p>这里是片语工作台的静态前端。生成、合成等需要后端的能力请先部署 <code>studio/app.py</code>，再把 <code>config.js</code> 里的 <code>PIANYU_API_BASE</code> 指向它。</p>
<p><a href="./">返回首页</a></p></main></body></html>
`;

async function measure(dir) {
  let size = 0;
  let files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await measure(full);
      size += inner.size;
      files += inner.files;
    } else {
      size += (await stat(full)).size;
      files += 1;
    }
  }
  return { size, files };
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
