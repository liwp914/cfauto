const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const CF_FALLBACK_IPS = ['ProxyIP.CMLiussss.net'];// cm维护

// 复用 TextEncoder，避免重复创建
const encoder = new TextEncoder();

import { connect } from 'cloudflare:sockets';

export default {
    async fetch(request, env, ctx) {
        try {
            const GITHUB_TOKEN = env.GITHUB_TOKEN || '';
            const TOKEN_JSON_URL = env.TOKEN_JSON_URL || 'https://github.com/hc990275/CloudFlare-worker/tree/main/ech/token.json';

            const upgradeHeader = request.headers.get('Upgrade');
            const urlPath = new URL(request.url).pathname;

            // --- 路由分发 ---
            if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
                // 主页展示
                if (urlPath === '/') {
                    return await handleHomePage(TOKEN_JSON_URL, GITHUB_TOKEN);
                }
                // 管理后台界面
                if (urlPath === '/admin') {
                    return handleAdminPage(env.ADMIN_PASSWORD);
                }
                // 管理后台读写 API
                if (urlPath.startsWith('/api/')) {
                    if (env.ADMIN_PASSWORD && request.headers.get('Authorization') !== env.ADMIN_PASSWORD) {
                        return new Response('Unauthorized Web Admin API', { status: 401 });
                    }
                    if (request.method === 'GET' && urlPath === '/api/tokens') {
                        return handleApiGetTokens(TOKEN_JSON_URL, GITHUB_TOKEN);
                    }
                    if (request.method === 'PUT' && urlPath === '/api/tokens') {
                        return handleApiPutTokens(request, TOKEN_JSON_URL, GITHUB_TOKEN);
                    }
                }

                return new Response('Expected WebSocket', { status: 426 });
            }

            const clientToken = request.headers.get('Sec-WebSocket-Protocol');

            // 校验 Token（只保留远程 JSON 配置）
            let isAuthorized = false;

            // 如果配置了远程 JSON 的 URL，则动态拉取并校验
            if (TOKEN_JSON_URL) {
                if (!clientToken) {
                    return new Response('Unauthorized - Token Required', { status: 401 });
                }
                const isValid = await verifyWithRemoteJson(TOKEN_JSON_URL, GITHUB_TOKEN, clientToken, env, ctx);
                if (isValid) {
                    isAuthorized = true;
                }
            }
            // 如果没配置任何 Token，默认为免密授权
            else {
                isAuthorized = true;
            }

            if (!isAuthorized) {
                return new Response('Unauthorized or Token Expired', { status: 401 });
            }

            const [client, server] = Object.values(new WebSocketPair());
            server.accept();

            handleSession(server).catch(() => safeCloseWebSocket(server));

            // 修复 spread 类型错误
            const responseInit = {
                status: 101,
                webSocket: client
            };

            if (clientToken) {
                responseInit.headers = { 'Sec-WebSocket-Protocol': clientToken };
            }

            return new Response(null, responseInit);

        } catch (err) {
            return new Response(err.toString(), { status: 500 });
        }
    },
};

// 内存级缓存
let remoteTokenCache = null;
let lastCacheTime = 0;
const CACHE_TTL = 60 * 1000; // 缓存 1 分钟，减少请求

// 默认内置的元数据格式兜底包
const fallbackData = {
    "global": {
        "SERVER_START_TIME": "2024-01-01T00:00:00Z"
    },
    "tokens": [
        {
            "token": "default_user_token_1",
            "expire": "2026-12-31T23:59:59Z"
        }
    ]
};

async function verifyWithRemoteJson(url, githubToken, clientToken, env, ctx) {
    const now = Date.now();
    // 缓存有效时直接使用
    if (remoteTokenCache && (now - lastCacheTime < CACHE_TTL)) {
        return checkTokenInConfig(remoteTokenCache, clientToken, now);
    }

    try {
        const headers = { 'User-Agent': 'CF-Worker-Auth' };
        if (githubToken) {
            headers['Authorization'] = `token ${githubToken}`;
        }

        let fetchUrl = url;
        // 如果是 GitHub API / repos URL
        if (url.includes('api.github.com/repos/')) {
            headers['Accept'] = 'application/vnd.github.v3.raw';
        }
        // 尝试自动将 html url 转为 raw url
        else if (url.includes('github.com') && !url.includes('raw.githubusercontent.com')) {
            fetchUrl = url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/').replace('/tree/', '/');
        }

        const res = await fetch(fetchUrl, { headers });
        if (!res.ok) {
            console.error('Fetch remote token JSON failed:', res.status, res.statusText);
            if (remoteTokenCache) return checkTokenInConfig(remoteTokenCache, clientToken, now);

            // 远端文件不存在且无缓存，实施兜底策略提供一套临时默认配表
            remoteTokenCache = fallbackData;
            lastCacheTime = now;
            return checkTokenInConfig(fallbackData, clientToken, now);
        }

        const data = await res.json();
        remoteTokenCache = data;
        lastCacheTime = now;
        return checkTokenInConfig(data, clientToken, now);

    } catch (e) {
        console.error('Error verifying remote JSON:', e.message);
        if (remoteTokenCache) return checkTokenInConfig(remoteTokenCache, clientToken, now);
        // 网络报错后备兜底
        remoteTokenCache = fallbackData;
        lastCacheTime = now;
        return checkTokenInConfig(fallbackData, clientToken, now);
    }
}

// 提取验证逻辑
function checkTokenInConfig(data, token, now) {
    if (!data) return false;

    // 为了兼容老版本扁平化数组，提取实际的 Token Array 参数
    let config = data;
    if (typeof data === 'object' && !Array.isArray(data)) {
        // 如果是新标准的含 tokens 的封装体
        if (data.tokens) {
            config = data.tokens;
        }
    }

    // --- 开始鉴权 ---

    // 如果是数组形式 (新旧兼容)
    if (Array.isArray(config)) {
        const row = config.find(item => item.token === token);
        if (!row) return false;
        if (row.expire && now > new Date(row.expire).getTime()) {
            return false;
        }
        return true;
    }
    // 如果是仅包含键值对字典的旧格式兼容
    else if (typeof config === 'object') {
        if (!(token in config)) return false;
        const expire = config[token];
        if (expire && now > new Date(expire).getTime()) {
            return false;
        }
        return true;
    }
    return false;
}

// 获取配置辅助方法 (外部需要提取开始时间时复用此缓存逻辑但不牵扯具体某个 token)
async function getRemoteConfig(url, githubToken) {
    const now = Date.now();
    if (remoteTokenCache && (now - lastCacheTime < CACHE_TTL)) {
        return remoteTokenCache;
    }
    // 借用鉴权方法自动更新一次缓存
    await verifyWithRemoteJson(url, githubToken, "PRELOAD", null, null);
    return remoteTokenCache || fallbackData;
}

// ============== 前后端分离功能模块 ==============

async function handleHomePage(url, githubToken) {
    const config = await getRemoteConfig(url, githubToken);
    let startTimeStr = "2024-01-01T00:00:00Z";
    if (config?.global?.SERVER_START_TIME) {
        startTimeStr = config.global.SERVER_START_TIME;
    }

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>服务器</title>
    <style>
        body { margin: 0; padding: 0; height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #0f2027, #203a43, #2c5364); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: white; overflow: hidden; }
        .glass-panel { background: rgba(255, 255, 255, 0.05); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-radius: 20px; border: 1px solid rgba(255, 255, 255, 0.1); padding: 40px 60px; box-shadow: 0 25px 50px rgba(0,0,0,0.5); text-align: center; display: flex; flex-direction: column; align-items: center; gap: 20px; transition: transform 0.3s ease; }
        .glass-panel:hover { transform: translateY(-5px); }
        .status-dot { width: 12px; height: 12px; background-color: #4ade80; border-radius: 50%; box-shadow: 0 0 10px #4ade80, 0 0 20px #4ade80; animation: pulse 2s infinite; display: inline-block; margin-right: 10px; }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(74, 222, 128, 0); } 100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); } }
        h1 { margin: 0; font-size: 24px; font-weight: 500; letter-spacing: 2px; text-transform: uppercase; color: rgba(255, 255, 255, 0.9); }
        .timer-box { font-variant-numeric: tabular-nums; font-family: "Courier New", Courier, monospace; font-size: 32px; font-weight: bold; background: linear-gradient(to right, #4ade80, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; filter: drop-shadow(0 0 8px rgba(255,255,255,0.1)); }
        .labels { display: flex; gap: 20px; font-size: 12px; color: rgba(255,255,255,0.5); text-transform: uppercase; margin-top: -10px; }
        .footer { position: fixed; bottom: 20px; padding: 10px; font-size: 12px; color: rgba(255, 255, 255, 0.3); letter-spacing: 1px; }
    </style>
</head>
<body>
    <div class="glass-panel">
        <div style="display: flex; align-items: center;">
            <div class="status-dot"></div>
            <h1>服务器已安全运行</h1>
        </div>
        <div class="timer-box" id="timer">00  00  00  00</div>
        <div class="labels"><span>天(Days)</span><span>时(Hrs)</span><span>分(Mins)</span><span>秒(Secs)</span></div>
    </div>
    <div class="footer">Server is running</div>

    <script>
        const startTime = new Date("${startTimeStr}").getTime();
        const timerEl = document.getElementById('timer');

        function updateTimer() {
            const now = new Date().getTime();
            const diff = now - startTime;
            
            if (diff < 0) { timerEl.innerText = "STARTING..."; return; }
            
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((diff % (1000 * 60)) / 1000);
            
            const p = n => n.toString().padStart(2, '0');
            timerEl.innerText = \`\${p(days)}  \${p(hours)}  \${p(minutes)}  \${p(seconds)}\`;
        }
        
        setInterval(updateTimer, 1000);
        updateTimer();
    </script>
</body>
</html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function handleAdminPage(pwd) {
    if (!pwd) {
        return new Response(`<h1>未配置 ADMIN_PASSWORD 环境变数，拒绝访问</h1>`, { status: 403, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Token 管理面板</title>
    <style>
        :root { --bg: #f8fafc; --text: #334155; --border: #e2e8f0; --primary: #3b82f6; --primary-hover: #2563eb; --danger: #ef4444; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
        body { margin: 0; padding: 20px; background: var(--bg); color: var(--text); display: flex; flex-direction: column; align-items: center; }
        .container { width: 100%; max-width: 800px; background: white; border-radius: 8px; border: 1px solid var(--border); box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); padding: 20px; }
        h1 { margin-top: 0; border-bottom: 2px solid var(--border); padding-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
        .auth-panel { text-align: center; margin-top: 50px; }
        input[type="password"], input[type="text"], input[type="datetime-local"] { padding: 8px 12px; border: 1px solid var(--border); border-radius: 4px; outline: none; transition: border-color 0.2s; }
        input:focus { border-color: var(--primary); }
        button { padding: 8px 16px; border: none; border-radius: 4px; background: var(--primary); color: white; cursor: pointer; font-weight: 500; transition: background 0.2s; }
        button:hover { background: var(--primary-hover); }
        button.danger { background: white; color: var(--danger); border: 1px solid var(--danger); padding: 4px 8px; font-size: 12px; }
        button.danger:hover { background: var(--danger); color: white; }
        
        .global-settings { background: #f1f5f9; padding: 15px; border-radius: 6px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;}
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid var(--border); }
        th { background: #f8fafc; font-weight: 600; color: #475569; }
        tr:hover { background: #f1f5f9; }
        .actions { display: flex; gap: 10px; }
        
        .add-row { display: flex; gap: 10px; margin-bottom: 20px; background: #e0f2fe; padding: 15px; border-radius: 6px;}
        #toast { position: fixed; bottom: 20px; right: 20px; background: #333; color: white; padding: 10px 20px; border-radius: 4px; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
    </style>
</head>
<body>
    <div id="auth-view" class="container auth-panel">
        <h2 style="border:none">🔒 请登入安全网关后台</h2>
        <input type="password" id="pwdInput" placeholder="输入 ADMIN_PASSWORD" onkeyup="if(event.key==='Enter') login()">
        <button onclick="login()">登入</button>
    </div>

    <div id="main-view" class="container" style="display:none;">
        <h1>概览与 Token 管理 
            <button onclick="saveToGithub()" style="font-size: 14px;">🔼 保存修改并推送 GitHub</button>
        </h1>
        
        <div class="global-settings">
            <div>
                <strong>🌐 服务器全局启动时间:</strong>
                <span id="displayStartTime" style="margin-left:10px; color:#64748b;">读取中...</span>
            </div>
            <div>
                <input type="datetime-local" id="newStartTime" step="1">
                <button onclick="setGlobalTime()" style="padding: 4px 10px; font-size:12px;">重设更新</button>
            </div>
        </div>

        <div class="add-row">
            <input type="text" id="newToken" placeholder="新 Token (如 a1b2c3d4)" style="flex:1;">
            <input type="datetime-local" id="newExpire" step="1" title="留空标识永久有效">
            <button onclick="addToken()">➕ 增加记录</button>
        </div>

        <table>
            <thead>
                <tr>
                    <th style="width: 35%"><div style="display:flex; justify-content: space-between;"><span>Token 凭证标识</span></div></th>
                    <th style="width: 35%"><div style="display:flex; justify-content: space-between;"><span>过期日 (空=永久)</span></div></th>
                    <th style="width: 30%">操作</th>
                </tr>
            </thead>
            <tbody id="tokenList">
                <tr><td colspan="3" style="text-align: center;">加载中...</td></tr>
            </tbody>
        </table>
    </div>
    
    <div id="toast"></div>

    <script>
        let currentPwd = '';
        let fullData = { global: {}, tokens: [] };

        function showToast(msg, isErr = false) {
            const t = document.getElementById('toast');
            t.style.background = isErr ? '#ef4444' : '#10b981';
            t.innerText = msg;
            t.style.opacity = 1;
            setTimeout(() => t.style.opacity = 0, 3000);
        }

        async function login() {
            currentPwd = document.getElementById('pwdInput').value;
            if(!currentPwd) return;
            
            showToast("正在鉴权...");
            try {
                const res = await fetch('/api/tokens', { headers: { 'Authorization': currentPwd } });
                if (res.status === 401) {
                    showToast("密码错误", true);
                    return;
                }
                const data = await res.json();
                
                // 兼容转换逻辑
                if (Array.isArray(data)) {
                    fullData.tokens = data;
                    fullData.global = { SERVER_START_TIME: "2024-01-01T00:00:00Z" };
                } else if (data.tokens) {
                    fullData = data;
                }
                
                document.getElementById('auth-view').style.display = 'none';
                document.getElementById('main-view').style.display = 'block';
                renderData();
                showToast("拉取源列表成功");
            } catch (e) {
                showToast("加载网络错误", true);
            }
        }

        function formatForLocal(isoString) {
            if(!isoString) return '';
            const d = new Date(isoString);
            if(isNaN(d)) return '';
            // 补齐 LocalDateTime 允许的格式 (去除了 Z 并修正时区展示)
            return new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().slice(0, 19);
        }

        function renderData() {
            // Render Global
            const st = fullData.global?.SERVER_START_TIME;
            document.getElementById('displayStartTime').innerText = st ? new Date(st).toLocaleString() : '未设置';
            
            // Render Tokens
            const tbody = document.getElementById('tokenList');
            tbody.innerHTML = '';
            
            if(fullData.tokens.length === 0) {
               tbody.innerHTML = '<tr><td colspan="3" style="text-align: center;color:#94a3b8">空空如也，请在上方添加</td></tr>';
               return; 
            }
            
            fullData.tokens.forEach((item, index) => {
                const tr = document.createElement('tr');
                tr.id = 'row-' + index;
                const expireText = item.expire ? new Date(item.expire).toLocaleString() : '♾️ 永久有效';
                const editExpireVal = formatForEdit(item.expire);
                // NOTE: 使用普通字符串拼接而非模板字面量，规避 TS/JSX 误报
                const rowHtml = '' +
                    '<td>' +
                        '<span id="text-token-' + index + '"><code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;">' + item.token + '</code></span>' +
                        '<input type="text" id="edit-token-' + index + '" value="' + item.token + '" style="display:none; width: 100%;" />' +
                    '</td>' +
                    '<td>' +
                        '<span id="text-expire-' + index + '">' + expireText + '</span>' +
                        '<input type="datetime-local" id="edit-expire-' + index + '" value="' + editExpireVal + '" step="1" style="display:none; width: 100%;" />' +
                    '</td>' +
                    '<td class="actions">' +
                        '<button id="btn-edit-' + index + '" onclick="startEdit(' + index + ')" style="background:#f59e0b; padding: 4px 10px; font-size: 12px;">✏️ 编辑</button>' +
                        '<button id="btn-save-' + index + '" onclick="saveEdit(' + index + ')" style="background:#10b981; display:none; padding: 4px 10px; font-size: 12px;">✅ 确认</button>' +
                        '<button id="btn-cancel-' + index + '" class="danger" onclick="cancelEdit(' + index + ')" style="display:none;"> 取消</button>' +
                        '<button id="btn-del-' + index + '" class="danger" onclick="delToken(' + index + ')">🗑️ 删除</button>' +
                    '</td>';
                tr.innerHTML = rowHtml;
                tbody.appendChild(tr);
            });
        }

        function formatForEdit(isoString) {
            if(!isoString) return '';
            const d = new Date(isoString);
            if(isNaN(d)) return '';
            // HTML datetime-local 要求 yyyy-MM-ddThh:mm:ss 格式 (不带时区后缀Z)
            return new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().slice(0, 19);
        }

        function startEdit(idx) {
            document.getElementById("text-token-" + idx).style.display = 'none';
            document.getElementById("text-expire-" + idx).style.display = 'none';
            document.getElementById("edit-token-" + idx).style.display = 'block';
            document.getElementById("edit-expire-" + idx).style.display = 'block';
            
            document.getElementById("btn-edit-" + idx).style.display = 'none';
            document.getElementById("btn-del-" + idx).style.display = 'none';
            document.getElementById("btn-save-" + idx).style.display = 'inline-block';
            document.getElementById("btn-cancel-" + idx).style.display = 'inline-block';
        }

        function cancelEdit(idx) {
            // 取消即重新渲染一次视图即可
            renderData();
        }

        function saveEdit(idx) {
            const newToken = document.getElementById("edit-token-" + idx).value.trim();
            const newExpire = document.getElementById("edit-expire-" + idx).value;
            
            if(!newToken) { showToast("Token不能为空", true); return; }
            
            // 检查有没有和其他的（非自己这行的）重复
            const duplicate = fullData.tokens.find((x, i) => i !== idx && x.token === newToken);
            if(duplicate) { showToast("Token 已存在", true); return; }
            
            fullData.tokens[idx].token = newToken;
            if(newExpire) {
                fullData.tokens[idx].expire = new Date(newExpire).toISOString();
            } else {
                delete fullData.tokens[idx].expire;
            }
            
            showToast("单条记录修改成功");
            renderData();
        }

        function setGlobalTime() {
            const val = document.getElementById('newStartTime').value;
            if(!val) return;
            // 转为标准 UTC 时间存储
            fullData.global.SERVER_START_TIME = new Date(val).toISOString();
            renderData();
            showToast("本地全局设定更新，请记得点击推向 GitHub");
        }

        function addToken() {
            const t = document.getElementById('newToken').value.trim();
            const e = document.getElementById('newExpire').value;
            if(!t) { showToast("Token不能为空", true); return; }
            if(fullData.tokens.find(x => x.token === t)) { showToast("Token 已存在", true); return; }
            
            const newItem = { token: t };
            if(e) newItem.expire = new Date(e).toISOString();
            
            fullData.tokens.push(newItem);
            document.getElementById('newToken').value = '';
            document.getElementById('newExpire').value = '';
            renderData();
        }

        function delToken(idx) {
            fullData.tokens.splice(idx, 1);
            renderData();
        }

        async function saveToGithub() {
            if(!confirm("确定要把目前的变更正式提交到 GitHub 并覆盖全网记录吗？")) return;
            showToast("正在打包推送 Commit...");
            try {
                const res = await fetch('/api/tokens', {
                    method: 'PUT',
                    headers: { 'Authorization': currentPwd, 'Content-Type': 'application/json' },
                    body: JSON.stringify(fullData, null, 2)
                });
                if(!res.ok) {
                    const txt = await res.text();
                    showToast("推送失败: " + txt, true);
                    return;
                }
                showToast("✅ 同步与覆盖成功！所有节点将在 60s 内刷新");
            } catch(e) {
                showToast("网络请求错误", true);
            }
        }
    </script>
</body>
</html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// ============== GitHub Rest API 操作钩子 ==============

async function handleApiGetTokens(url, githubToken) {
    const data = await getRemoteConfig(url, githubToken);
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}

// 智能切分从直链提取 repo 接口所需参数
function parseGithubUrl(rawUrl) {
    try {
        let u = rawUrl;
        if (u.includes('raw.githubusercontent.com')) {
            const parts = u.split('raw.githubusercontent.com/')[1].split('/');
            return { owner: parts[0], repo: parts[1], path: parts.slice(3).join('/') };
        }
        if (u.includes('github.com')) {
            const parts = u.split('github.com/')[1].split('/');
            // 结构如: hc990275/CloudFlare-worker/tree/main/ech/token.json
            return { owner: parts[0], repo: parts[1], path: parts.slice(4).join('/') };
        }
    } catch (e) { }
    return null;
}

// 核心利用具有读写权限的 PAT 将改动写回 Github 远程
async function handleApiPutTokens(request, targetUrl, githubToken) {
    if (!githubToken) {
        return new Response('Missing GITHUB_TOKEN on server env to commit changes.', { status: 400 });
    }

    const parsed = parseGithubUrl(targetUrl);
    if (!parsed) {
        return new Response('Unable to parse TOKEN_JSON_URL for GitHub API ops.', { status: 400 });
    }

    const apiBase = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${parsed.path}`;
    const headers = {
        'Authorization': `token ${githubToken}`,
        'User-Agent': 'CF-Worker-Admin',
        'Accept': 'application/vnd.github.v3+json'
    };

    try {
        // 1. 获取最新文件 SHA (若不用 SHA 则 Github 拒接更新)
        let fileSha = undefined;
        const getRes = await fetch(apiBase, { headers });
        if (getRes.ok) {
            const getJson = await getRes.json();
            fileSha = getJson.sha;
        }

        // 2. 将传入的新 JSON 发送 PUT 请求
        const newPayload = await request.text();
        // GitHub API 要求内容强转 base64
        const uint8array = new TextEncoder().encode(newPayload);
        let contentBase64 = "";
        for (let i = 0; i < uint8array.length; i++) {
            contentBase64 += String.fromCharCode(uint8array[i]);
        }
        contentBase64 = btoa(contentBase64);

        const putBody = {
            message: "Update tokens via Admin Panel",
            content: contentBase64,
            sha: fileSha
        };

        const putRes = await fetch(apiBase, {
            method: 'PUT',
            headers,
            body: JSON.stringify(putBody)
        });

        if (!putRes.ok) {
            return new Response(`Git Commit Error: ${putRes.status} ${await putRes.text()}`, { status: 502 });
        }

        // 为了防止刚更新完读取的仍是旧缓存，操作成功后直接清空本地缓存
        remoteTokenCache = null;

        return new Response('OK', { status: 200 });

    } catch (e) {
        return new Response(e.message, { status: 500 });
    }
}


async function handleSession(webSocket) {
    let remoteSocket, remoteWriter, remoteReader;
    let isClosed = false;

    const cleanup = () => {
        if (isClosed) return;
        isClosed = true;

        try { remoteWriter?.releaseLock(); } catch { }
        try { remoteReader?.releaseLock(); } catch { }
        try { remoteSocket?.close(); } catch { }

        remoteWriter = remoteReader = remoteSocket = null;
        safeCloseWebSocket(webSocket);
    };

    const pumpRemoteToWebSocket = async () => {
        try {
            while (!isClosed && remoteReader) {
                const { done, value } = await remoteReader.read();

                if (done) break;
                if (webSocket.readyState !== WS_READY_STATE_OPEN) break;
                if (value?.byteLength > 0) webSocket.send(value);
            }
        } catch { }

        if (!isClosed) {
            try { webSocket.send('CLOSE'); } catch { }
            cleanup();
        }
    };

    const parseAddress = (addr) => {
        if (addr[0] === '[') {
            const end = addr.indexOf(']');
            return {
                host: addr.substring(1, end),
                port: parseInt(addr.substring(end + 2), 10)
            };
        }
        const sep = addr.lastIndexOf(':');
        return {
            host: addr.substring(0, sep),
            port: parseInt(addr.substring(sep + 1), 10)
        };
    };

    const isCFError = (err) => {
        const msg = err?.message?.toLowerCase() || '';
        return msg.includes('proxy request') ||
            msg.includes('cannot connect') ||
            msg.includes('cloudflare');
    };

    const connectToRemote = async (targetAddr, firstFrameData) => {
        const { host, port } = parseAddress(targetAddr);
        const attempts = [null, ...CF_FALLBACK_IPS];

        for (let i = 0; i < attempts.length; i++) {
            try {
                remoteSocket = connect({
                    hostname: attempts[i] || host,
                    port
                });

                if (remoteSocket.opened) await remoteSocket.opened;

                remoteWriter = remoteSocket.writable.getWriter();
                remoteReader = remoteSocket.readable.getReader();

                // 发送首帧数据
                if (firstFrameData) {
                    await remoteWriter.write(encoder.encode(firstFrameData));
                }

                webSocket.send('CONNECTED');
                pumpRemoteToWebSocket();
                return;

            } catch (err) {
                // 清理失败的连接
                try { remoteWriter?.releaseLock(); } catch { }
                try { remoteReader?.releaseLock(); } catch { }
                try { remoteSocket?.close(); } catch { }
                remoteWriter = remoteReader = remoteSocket = null;

                // 如果不是 CF 错误或已是最后尝试，抛出错误
                if (!isCFError(err) || i === attempts.length - 1) {
                    throw err;
                }
            }
        }
    };

    webSocket.addEventListener('message', async (event) => {
        if (isClosed) return;

        try {
            const data = event.data;

            if (typeof data === 'string') {
                if (data.startsWith('CONNECT:')) {
                    const sep = data.indexOf('|', 8);
                    await connectToRemote(
                        data.substring(8, sep),
                        data.substring(sep + 1)
                    );
                }
                else if (data.startsWith('DATA:')) {
                    if (remoteWriter) {
                        await remoteWriter.write(encoder.encode(data.substring(5)));
                    }
                }
                else if (data === 'CLOSE') {
                    cleanup();
                }
            }
            else if (data instanceof ArrayBuffer && remoteWriter) {
                await remoteWriter.write(new Uint8Array(data));
            }
        } catch (err) {
            try { webSocket.send('ERROR:' + err.message); } catch { }
            cleanup();
        }
    });

    webSocket.addEventListener('close', cleanup);
    webSocket.addEventListener('error', cleanup);
}

function safeCloseWebSocket(ws) {
    try {
        if (ws.readyState === WS_READY_STATE_OPEN ||
            ws.readyState === WS_READY_STATE_CLOSING) {
            ws.close(1000, 'Server closed');
        }
    } catch { }
}
