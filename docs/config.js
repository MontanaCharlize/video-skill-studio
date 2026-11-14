// 由 tools/build-pages.mjs 生成，仅首次生成，之后不会被覆盖。
// 静态托管（GitHub Pages）没有 /api 后端。把下面改成你已经部署的后端地址，
// 例如 'https://pianyu-api.example.com'（不要带结尾斜杠），页面就会把
// /api/* 请求转发到该地址。留空则在同源查找 /api/*。
window.PIANYU_API_BASE = '';
