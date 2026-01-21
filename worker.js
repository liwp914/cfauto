/**
 * Cloudflare Worker 多项目部署管理器 (V7.3 DOH Select Support)
 * * 更新日志：
 * 1. [新增] CMliu DOH 增加 'https://dns.jhb.ovh/joeyblog'。
 * 2. [优化] DOH 变量输入升级为下拉辅助选择模式 (同 PROXYIP 交互一致)。
 * 3. [保留] V7.2 的所有功能 (UI自适应, PWA, ECH支持)。
 */

// ==========================================
// 1. 项目模板配置
// ==========================================
const TEMPLATES = {
    'cmliu': {
      name: "CMliu - EdgeTunnel",
      scriptUrl: "https://raw.githubusercontent.com/cmliu/edgetunnel/beta2.0/_worker.js",
      apiUrl: "https://api.github.com/repos/cmliu/edgetunnel/commits/beta2.0",
      defaultVars: ["UUID", "PROXYIP", "DOH", "PATH", "URL", "KEY", "ADMIN"],
      uuidField: "UUID",
      description: "CMliu (beta2.0)"
    },
    'joey': {
      name: "Joey - 少年你相信光吗",
      scriptUrl: "https://raw.githubusercontent.com/byJoey/cfnew/main/%E5%B0%91%E5%B9%B4%E4%BD%A0%E7%9B%B8%E4%BF%A1%E5%85%89%E5%90%97",
      apiUrl: "https://api.github.com/repos/byJoey/cfnew/commits?path=%E5%B0%91%E5%B9%B4%E4%BD%A0%E7%9B%B8%E4%BF%A1%E5%85%89%E5%90%97&per_page=1",
      defaultVars: ["u", "d", "p"],
      uuidField: "u",
      description: "Joey (自动修复)"
    },
    'ech': {
      name: "ECH - WebSocket Proxy",
      // 使用 raw 链接确保直接获取代码
      scriptUrl: "https://raw.githubusercontent.com/hc990275/ech-wk/main/_worker.js",
      apiUrl: "https://api.github.com/repos/hc990275/ech-wk/commits?path=_worker.js&per_page=1",
      // PROXYIP 是一个虚拟变量，用于部署时替换代码中的常量
      defaultVars: ["PROXYIP"], 
      uuidField: "", 
      description: "ECH (无需频繁更新)"
    }
  };
  
  export default {
    // ================= 定时任务 (Cron) =================
    async scheduled(event, env, ctx) {
      ctx.waitUntil(handleCronJob(env));
    },
  
    // ================= HTTP 请求入口 =================
    async fetch(request, env) {
      const url = new URL(request.url);
      const correctCode = env.ACCESS_CODE; 
      const urlCode = url.searchParams.get("code");
      const cookieHeader = request.headers.get("Cookie") || "";
      
      // PWA Manifest 路由
      if (url.pathname === "/manifest.json") {
          return new Response(JSON.stringify({
              "name": "Worker 智能中控",
              "short_name": "Worker中控",
              "start_url": "/",
              "display": "standalone",
              "background_color": "#f3f4f6",
              "theme_color": "#1e293b",
              "icons": [
                  { "src": "https://www.cloudflare.com/img/logo-cloudflare-dark.svg", "sizes": "192x192", "type": "image/svg+xml" }
              ]
          }), { headers: { "Content-Type": "application/json" } });
      }

      // 登录验证
      if (correctCode && !cookieHeader.includes(`auth=${correctCode}`) && urlCode !== correctCode) {
        return new Response(loginHtml(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }
  
      // 路由常量
      const ACCOUNTS_KEY = `ACCOUNTS_UNIFIED_STORAGE`; 
      const GLOBAL_CONFIG_KEY = `AUTO_UPDATE_CFG_GLOBAL`;
  
      // API: 账号管理
      if (url.pathname === "/api/accounts") {
        if (request.method === "GET") {
          return new Response(await env.CONFIG_KV.get(ACCOUNTS_KEY) || "[]", { headers: { "Content-Type": "application/json" } });
        }
        if (request.method === "POST") {
          await env.CONFIG_KV.put(ACCOUNTS_KEY, JSON.stringify(await request.json()));
          return new Response(JSON.stringify({ success: true }));
        }
      }
  
      // API: 变量管理
      if (url.pathname === "/api/settings") {
        const type = url.searchParams.get("type");
        const VARS_KEY = `VARS_${type}`;
        if (request.method === "GET") {
          return new Response(await env.CONFIG_KV.get(VARS_KEY) || "null", { headers: { "Content-Type": "application/json" } });
        }
        if (request.method === "POST") {
          await env.CONFIG_KV.put(VARS_KEY, JSON.stringify(await request.json()));
          return new Response(JSON.stringify({ success: true }));
        }
      }
  
      // API: 全局自动配置
      if (url.pathname === "/api/auto_config") {
        if (request.method === "GET") {
          return new Response(await env.CONFIG_KV.get(GLOBAL_CONFIG_KEY) || "{}", { headers: { "Content-Type": "application/json" } });
        }
        if (request.method === "POST") {
          const body = await request.json();
          const oldCfg = JSON.parse(await env.CONFIG_KV.get(GLOBAL_CONFIG_KEY) || "{}");
          body.lastCheck = oldCfg.lastCheck || 0; 
          await env.CONFIG_KV.put(GLOBAL_CONFIG_KEY, JSON.stringify(body));
          return new Response(JSON.stringify({ success: true }));
        }
      }
  
      // API: 检查更新
      if (url.pathname === "/api/check_update") {
          const type = url.searchParams.get("type");
          return await handleCheckUpdate(env, type, `VERSION_INFO_${type}`);
      }
  
      // API: 部署
      if (url.pathname === "/api/deploy" && request.method === "POST") {
        const type = url.searchParams.get("type");
        const { variables, deletedVariables } = await request.json();
        return await handleManualDeploy(env, type, variables, deletedVariables, ACCOUNTS_KEY, `VERSION_INFO_${type}`);
      }
  
      // API: 统计
      if (url.pathname === "/api/stats") {
        return await handleStats(env, ACCOUNTS_KEY);
      }
  
      // API: 读取线上变量
      if (url.pathname === "/api/fetch_bindings" && request.method === "POST") {
          const { accountId, apiToken, workerName } = await request.json();
          return await handleFetchBindings(accountId, apiToken, workerName);
      }
  
      // API: 删除线上变量 (修复版：重新拉取代码)
      if (url.pathname === "/api/delete_binding" && request.method === "POST") {
          const { accountId, apiToken, workerName, key, type } = await request.json();
          return await handleDeleteBinding(accountId, apiToken, workerName, key, type);
      }
  
      const response = new Response(mainHtml(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      if (urlCode === correctCode && correctCode) {
        response.headers.set("Set-Cookie", `auth=${correctCode}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
      }
      return response;
    }
  };
  
  // ... Cron, Deploy, Stats 逻辑 ...
  
  async function handleCronJob(env) {
      const ACCOUNTS_KEY = `ACCOUNTS_UNIFIED_STORAGE`;
      const GLOBAL_CONFIG_KEY = `AUTO_UPDATE_CFG_GLOBAL`;
      const configStr = await env.CONFIG_KV.get(GLOBAL_CONFIG_KEY);
      if (!configStr) return;
      const config = JSON.parse(configStr);
      if (!config.enabled) return;
      const now = Date.now();
      const lastCheck = config.lastCheck || 0;
      const intervalVal = parseInt(config.interval) || 30;
      const unit = config.unit || 'minutes';
      const intervalMs = unit === 'minutes' ? intervalVal * 60 * 1000 : intervalVal * 60 * 60 * 1000;
  
      if (now - lastCheck <= intervalMs) return;
      console.log(`[Cron] 🕒 Global Check Started.`);
      
      const accounts = JSON.parse(await env.CONFIG_KV.get(ACCOUNTS_KEY) || "[]");
      if (accounts.length === 0) return;
      const statsData = await fetchInternalStats(accounts);
  
      let actionTaken = false;
      const fuseThreshold = parseInt(config.fuseThreshold || 0);
      if (fuseThreshold > 0) {
          for (const acc of accounts) {
              const stat = statsData.find(s => s.alias === acc.alias);
              if (!stat || stat.error) continue;
              const limit = stat.max || 100000;
              const usedPercent = (stat.total / limit) * 100;
              if (usedPercent >= fuseThreshold) {
                  // ECH 通常不需要轮换 UUID
                  await rotateUUIDAndDeploy(env, 'cmliu', accounts, ACCOUNTS_KEY);
                  await rotateUUIDAndDeploy(env, 'joey', accounts, ACCOUNTS_KEY);
                  actionTaken = true;
                  break;
              }
          }
      }
      if (!actionTaken) {
          // ECH 不包含在自动更新检查中，因为用户表示它不需要经常更新
          await Promise.all([
              checkAndDeployUpdate(env, 'cmliu', accounts, ACCOUNTS_KEY),
              checkAndDeployUpdate(env, 'joey', accounts, ACCOUNTS_KEY)
          ]);
      }
      config.lastCheck = now;
      await env.CONFIG_KV.put(GLOBAL_CONFIG_KEY, JSON.stringify(config));
  }
  
  async function checkAndDeployUpdate(env, type, accounts, accountsKey) {
      try {
          const VERSION_KEY = `VERSION_INFO_${type}`;
          const checkRes = await handleCheckUpdate(env, type, VERSION_KEY);
          const checkData = await checkRes.json();
          if (checkData.remote && (!checkData.local || checkData.remote.sha !== checkData.local.sha)) {
              const VARS_KEY = `VARS_${type}`;
              const varsStr = await env.CONFIG_KV.get(VARS_KEY);
              const variables = varsStr ? JSON.parse(varsStr) : [];
              await coreDeployLogic(env, type, variables, [], accountsKey, VERSION_KEY);
          }
      } catch(e) { console.error(`[Update Error] ${type}: ${e.message}`); }
  }
  
  async function rotateUUIDAndDeploy(env, type, accounts, accountsKey) {
      const VARS_KEY = `VARS_${type}`;
      const varsStr = await env.CONFIG_KV.get(VARS_KEY);
      let variables = varsStr ? JSON.parse(varsStr) : [];
      const uuidField = TEMPLATES[type].uuidField;
      // 如果没有 uuidField (例如 ech)，则跳过
      if (!uuidField) return; 
  
      let uuidUpdated = false;
      variables = variables.map(v => {
          if (v.key === uuidField) { v.value = crypto.randomUUID(); uuidUpdated = true; }
          return v;
      });
      if (!uuidUpdated) variables.push({ key: uuidField, value: crypto.randomUUID() });
      await env.CONFIG_KV.put(VARS_KEY, JSON.stringify(variables));
      await coreDeployLogic(env, type, variables, [], accountsKey, `VERSION_INFO_${type}`);
  }
  
  async function fetchInternalStats(accounts) {
      const now = new Date();
      const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
      const query = `query getBillingMetrics($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
          viewer { accounts(filter: {accountTag: $AccountID}) {
              workersInvocationsAdaptive(limit: 10000, filter: $filter) { sum { requests } }
              pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) { sum { requests } }
          }}}`;
      return await Promise.all(accounts.map(async (acc) => {
        try {
          const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
            method: "POST",
            headers: { "Authorization": `Bearer ${acc.apiToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ query: query, variables: { AccountID: acc.accountId, filter: { datetime_geq: todayStart.toISOString(), datetime_leq: now.toISOString() } } })
          });
          const data = await res.json();
          const accountData = data.data?.viewer?.accounts?.[0];
          if (!accountData) return { alias: acc.alias, error: "无数据" };
          const workerReqs = accountData.workersInvocationsAdaptive?.reduce((a, b) => a + (b.sum.requests || 0), 0) || 0;
          const pagesReqs = accountData.pagesFunctionsInvocationsAdaptiveGroups?.reduce((a, b) => a + (b.sum.requests || 0), 0) || 0;
          return { alias: acc.alias, total: workerReqs + pagesReqs, max: 100000 };
        } catch (e) { return { alias: acc.alias, error: e.message }; }
      }));
  }
  
  async function handleStats(env, accountsKey) {
      try {
          const accounts = JSON.parse(await env.CONFIG_KV.get(accountsKey) || "[]");
          if (accounts.length === 0) return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
          const results = await fetchInternalStats(accounts);
          return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
  }
  
  function getGithubHeaders(env) {
      const headers = { "User-Agent": "Cloudflare-Worker-Manager" };
      if (env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim() !== "") headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;
      return headers;
  }
  
  async function handleCheckUpdate(env, type, versionKey) {
      try {
          const config = TEMPLATES[type];
          const localData = JSON.parse(await env.CONFIG_KV.get(versionKey) || "null");
          const apiUrlWithTs = `${config.apiUrl}${config.apiUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
          const ghRes = await fetch(apiUrlWithTs, { headers: getGithubHeaders(env) });
          if (!ghRes.ok) throw new Error(`GitHub API Error: ${ghRes.status}`);
          const ghData = await ghRes.json();
          const commitObj = Array.isArray(ghData) ? ghData[0] : ghData;
          return new Response(JSON.stringify({ local: localData, remote: { sha: commitObj.sha, date: commitObj.commit.committer.date, message: commitObj.commit.message } }), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
  }
  
  async function handleFetchBindings(accountId, apiToken, workerName) {
      try {
          const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/bindings`;
          const res = await fetch(url, { headers: { "Authorization": `Bearer ${apiToken}` } });
          if(!res.ok) throw new Error("Fetch failed: " + res.status);
          const data = await res.json();
          const bindings = data.result.filter(b => b.type === "plain_text" || b.type === "secret_text").map(b => ({
              key: b.name, value: b.type === "plain_text" ? b.text : ""
          }));
          return new Response(JSON.stringify({ success: true, data: bindings }), { headers: { "Content-Type": "application/json" } });
      } catch(e) {
          return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500 });
      }
  }
  
  // 核心修复：删除变量并重新拉取正确代码
  async function handleDeleteBinding(accountId, apiToken, workerName, keyToDelete, type) {
      try {
          const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`;
          const headers = { "Authorization": `Bearer ${apiToken}` };
          
          // 1. 获取当前变量
          const bindingsRes = await fetch(`${baseUrl}/bindings`, { headers });
          if (!bindingsRes.ok) throw new Error("获取变量失败");
          const currentBindings = (await bindingsRes.json()).result;
  
          // 2. 过滤掉要删除的
          const newBindings = currentBindings.filter(b => b.name !== keyToDelete);
          
          // 3. 重新从 GitHub 拉取代码
          const templateConfig = TEMPLATES[type];
          if (!templateConfig) throw new Error("未知项目类型，无法拉取代码");
  
          const codeRes = await fetch(templateConfig.scriptUrl + `?t=${Date.now()}`);
          if (!codeRes.ok) throw new Error("从 GitHub 拉取代码失败");
          let scriptContent = await codeRes.text();
  
          // 特殊处理
          if (type === 'joey') scriptContent = 'var window = globalThis;\n' + scriptContent;
          // ECH 不需要在这里特殊处理 ProxyIP，因为删除绑定不涉及修改代码逻辑，
          // 但如果 ECH 依赖的变量被删除了，下次部署时会重置为默认值。
  
          // 4. 重新部署
          const metadata = { main_module: "index.js", bindings: newBindings, compatibility_date: "2024-01-01" };
          const formData = new FormData();
          formData.append("metadata", JSON.stringify(metadata));
          formData.append("script", new Blob([scriptContent], { type: "application/javascript+module" }), "index.js");
  
          const updateRes = await fetch(baseUrl, { method: "PUT", headers, body: formData });
          
          if (!updateRes.ok) {
              const err = await updateRes.json();
              throw new Error(err.errors?.[0]?.message || "部署失败");
          }
          return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
          return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500 });
      }
  }
  
  async function handleManualDeploy(env, type, variables, deletedVariables, accountsKey, versionKey) {
      return new Response(JSON.stringify(await coreDeployLogic(env, type, variables, deletedVariables, accountsKey, versionKey)), { headers: { "Content-Type": "application/json" } });
  }
  
  async function coreDeployLogic(env, type, variables, deletedVariables, accountsKey, versionKey) {
      try {
          const templateConfig = TEMPLATES[type];
          const accounts = JSON.parse(await env.CONFIG_KV.get(accountsKey) || "[]");
          if (accounts.length === 0) return [{ name: "提示", success: false, msg: "无账号配置" }];
          
          let githubScriptContent = "";
          let currentSha = "";
          try {
              const [codeRes, apiRes] = await Promise.all([ 
                  fetch(templateConfig.scriptUrl + `?t=${Date.now()}`), 
                  fetch(templateConfig.apiUrl + `?t=${Date.now()}`, { headers: getGithubHeaders(env) }) 
              ]);
              if (!codeRes.ok) throw new Error(`代码下载失败`);
              githubScriptContent = await codeRes.text();
              if (apiRes.ok) {
                  const json = await apiRes.json();
                  currentSha = (Array.isArray(json) ? json[0] : json).sha;
              }
          } catch (e) { return [{ name: "网络错误", success: false, msg: e.message }]; }
  
          // === 代码预处理 ===
          if (type === 'joey') {
              githubScriptContent = 'var window = globalThis;\n' + githubScriptContent;
          }
          
          // [新增] ECH 特殊处理：直接替换代码中的 ProxyIP 常量
          if (type === 'ech') {
              const proxyVar = variables ? variables.find(v => v.key === 'PROXYIP') : null;
              const targetIP = proxyVar && proxyVar.value ? proxyVar.value.trim() : 'ProxyIP.CMLiussss.net';
              // 使用正则替换：查找 const CF_FALLBACK_IPS = [...]; 替换为用户设定的值
              // 匹配 const CF_FALLBACK_IPS = ['...']; 格式
              const regex = /const\s+CF_FALLBACK_IPS\s*=\s*\[.*?\];/s;
              githubScriptContent = githubScriptContent.replace(regex, `const CF_FALLBACK_IPS = ['${targetIP}'];`);
              
              // 过滤掉 PROXYIP 变量，不让它作为 Cloudflare Binding 环境变量上传，因为我们已经硬编码进去了
              // 当然，上传了也不影响，但为了整洁可以保留或删除。这里保留，方便前端读取回显。
          }
  
          const logs = [];
          let updateCount = 0;
          for (const acc of accounts) {
            const targetWorkers = acc[`workers_${type}`] || [];
            for (const wName of targetWorkers) {
                updateCount++;
                const logItem = { name: `${acc.alias} -> [${wName}]`, success: false, msg: "" };
                try {
                  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/scripts/${wName}`;
                  const headers = { "Authorization": `Bearer ${acc.apiToken}` };
                  const bindingsRes = await fetch(`${baseUrl}/bindings`, { headers });
                  let currentBindings = bindingsRes.ok ? (await bindingsRes.json()).result : [];
                  if (deletedVariables && deletedVariables.length > 0) currentBindings = currentBindings.filter(b => !deletedVariables.includes(b.name));
                  
                  if (variables) {
                      for (const newVar of variables) {
                          // ECH 的 PROXYIP 实际上我们已经注入代码了，但也可以作为变量存着，方便下次读取
                          if (newVar.value && newVar.value.trim() !== "") {
                              const idx = currentBindings.findIndex(b => b.name === newVar.key);
                              if (idx !== -1) currentBindings[idx] = { name: newVar.key, type: "plain_text", text: newVar.value };
                              else currentBindings.push({ name: newVar.key, type: "plain_text", text: newVar.value });
                          }
                      }
                  }
                  const metadata = { main_module: "index.js", bindings: currentBindings, compatibility_date: "2024-01-01" };
                  const formData = new FormData();
                  formData.append("metadata", JSON.stringify(metadata));
                  formData.append("script", new Blob([githubScriptContent], { type: "application/javascript+module" }), "index.js");
                  const updateRes = await fetch(baseUrl, { method: "PUT", headers, body: formData });
                  if (updateRes.ok) { logItem.success = true; logItem.msg = `✅ 更新成功 (IP: ${type==='ech'?variables.find(v=>v.key==='PROXYIP')?.value:'Default'})`; } 
                  else { logItem.msg = `❌ ${(await updateRes.json()).errors?.[0]?.message}`; }
                } catch (err) { logItem.msg = `❌ ${err.message}`; }
                logs.push(logItem);
              } 
          }
          if (updateCount > 0 && currentSha) await env.CONFIG_KV.put(versionKey, JSON.stringify({ sha: currentSha, deployDate: new Date().toISOString() }));
          return logs;
      } catch (e) { return [{ name: "系统错误", success: false, msg: e.message }]; }
  }
  
  function loginHtml() { return `<!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f3f4f6"><form method="GET"><input type="password" name="code" placeholder="密码" style="padding:10px"><button style="padding:10px">登录</button></form></body></html>`; }
  
  // ==========================================
  // 2. 前端页面
  // ==========================================
  function mainHtml() {
    return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="theme-color" content="#1e293b">
    <link rel="manifest" href="/manifest.json">
    <title>Worker 智能中控 (V7.3)</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
      .input-field { border: 1px solid #cbd5e1; padding: 0.25rem 0.5rem; width:100%; border-radius: 4px; font-size: 0.8rem; } 
      .input-field:focus { border-color:#3b82f6; outline:none; }
      .toggle-checkbox:checked { right: 0; border-color: #68D391; }
      .toggle-checkbox:checked + .toggle-label { background-color: #68D391; }
      .compact-table th, .compact-table td { padding: 8px; font-size: 13px; border-bottom: 1px solid #f1f5f9; white-space: nowrap; }
      .compact-table th { background-color: #f8fafc; color: #64748b; font-weight: 600; text-align: left; }
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
      details > summary { list-style: none; cursor: pointer; }
      details > summary::-webkit-details-marker { display: none; }
    </style>
  </head>
  <body class="bg-slate-100 p-2 md:p-4 min-h-screen text-slate-700">
    <div class="max-w-7xl mx-auto space-y-4">
      
      <header class="bg-white px-4 py-3 md:px-6 md:py-4 rounded shadow flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
          <div class="flex-none">
              <h1 class="text-xl font-bold text-slate-800 flex items-center gap-2">🚀 Worker 部署中控 <span class="text-xs bg-slate-200 text-slate-600 px-2 py-0.5 rounded ml-2">V7.3</span></h1>
              <div class="text-[10px] text-gray-400 mt-1">全局管理 · 自动读取 · ECH/Proxy智能支持</div>
          </div>

          <div id="logs" class="bg-slate-900 text-green-400 p-2 rounded text-xs font-mono hidden max-h-[80px] lg:max-h-[50px] overflow-y-auto shadow-inner w-full lg:flex-1 lg:mx-4 order-2 lg:order-none mb-2 lg:mb-0"></div>
          
          <div class="flex flex-wrap items-center gap-2 md:gap-3 bg-slate-50 p-2 rounded border border-slate-200 w-full lg:w-auto flex-none">
               <button onclick="toggleLayout()" class="text-xs bg-white border border-gray-300 text-gray-600 px-2 py-1 rounded hover:bg-gray-50 flex items-center gap-1" id="btn_layout">
                  <span id="layout_icon">◫</span> <span id="layout_text">布局</span>
               </button>
               <div class="w-px h-4 bg-gray-300 mx-1"></div>
  
               <div class="flex items-center gap-2 border-r border-slate-200 pr-3 mr-1">
                  <span class="text-xs font-bold text-gray-600">自动检测</span>
                  <div class="relative inline-block w-8 align-middle select-none">
                      <input type="checkbox" id="auto_update_toggle" class="toggle-checkbox absolute block w-4 h-4 rounded-full bg-white border-4 appearance-none cursor-pointer border-gray-300"/>
                      <label for="auto_update_toggle" class="toggle-label block overflow-hidden h-4 rounded-full bg-gray-300 cursor-pointer"></label>
                  </div>
               </div>
               <div class="flex items-center gap-1">
                  <input type="number" id="auto_update_interval" value="30" class="w-8 text-center text-xs border rounded py-0.5">
                  <span class="text-xs text-gray-400">分</span>
               </div>
               <div class="flex items-center gap-1 ml-auto lg:ml-0">
                  <span class="text-xs text-red-600 font-bold">熔断:</span>
                  <input type="number" id="fuse_threshold" value="0" placeholder="0" class="w-8 text-center text-xs border border-red-300 bg-red-50 rounded py-0.5 font-bold text-red-600">
               </div>
               <button onclick="saveAutoConfig()" class="text-[10px] bg-slate-700 text-white px-2 py-1 rounded hover:bg-slate-800 font-bold ml-1">保存</button>
          </div>
      </header>
      
      <div id="layout_container" class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        
        <div id="section_accounts" class="lg:col-span-7 space-y-4">
            <div class="bg-white p-4 rounded shadow flex-1">
              <div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-3 gap-2">
                   <h2 class="font-bold text-gray-700 text-sm">📡 账号列表 (按流量降序)</h2>
                   <div class="flex gap-2 w-full md:w-auto">
                       <button onclick="loadStats()" id="btn_stats" class="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-1 rounded font-bold hover:bg-indigo-100 transition flex-1 md:flex-none text-center">🔄 刷新用量</button>
                       <button onclick="resetFormForAdd()" class="text-[10px] bg-blue-50 text-blue-600 px-2 py-1 rounded flex-1 md:flex-none text-center">➕ 添加账号</button>
                   </div>
              </div>
              
              <div id="account_form" class="hidden bg-slate-50 p-3 mb-3 border rounded text-xs space-y-3 relative">
                   <div class="flex gap-2">
                       <input id="in_alias" placeholder="备注" class="input-field w-1/3">
                       <input id="in_id" placeholder="Account ID" class="input-field w-2/3">
                   </div>
                   <input id="in_token" type="password" placeholder="API Token" class="input-field">
                   <div class="grid grid-cols-3 gap-2">
                      <input id="in_workers_cmliu" placeholder="🔴 CMliu Workers" class="input-field bg-red-50">
                      <input id="in_workers_joey" placeholder="🔵 Joey Workers" class="input-field bg-blue-50">
                      <input id="in_workers_ech" placeholder="🟢 ECH Workers" class="input-field bg-green-50">
                   </div>
  
                   <div class="flex gap-2 pt-2">
                      <button onclick="saveAccount()" id="btn_save_acc" class="flex-1 bg-slate-700 text-white py-1.5 rounded font-bold hover:bg-slate-800 transition">💾 保存账号</button>
                      <button onclick="deleteFromEdit()" id="btn_del_edit" class="hidden flex-none bg-red-100 text-red-600 px-3 py-1.5 rounded font-bold hover:bg-red-200 transition">🗑️ 删除</button>
                      <button onclick="cancelEdit()" class="flex-none bg-gray-200 text-gray-600 px-3 py-1.5 rounded font-bold hover:bg-gray-300 transition">❌ 取消</button>
                   </div>
  
                   <div id="edit_vars_section" class="hidden border-t border-gray-200 pt-2 mt-2">
                      <div class="flex justify-between items-center mb-2">
                          <span class="font-bold text-gray-600">🌍 线上 Worker 变量管理</span>
                          <span id="loading_indicator" class="text-[10px] text-blue-500 hidden animate-pulse">⚡ 正在读取线上配置...</span>
                      </div>
                      <div id="edit_vars_container" class="space-y-2"></div>
                   </div>
              </div>
         
              <div id="account_list_container" class="overflow-x-auto min-h-[300px]">
                <table class="w-full compact-table">
                  <thead><tr>
                      <th width="15%">备注</th>
                      <th width="20%">Worker</th>
                      <th width="25%">今日流量</th>
                      <th width="25%">使用占比</th>
                      <th width="15%" class="text-right">操作</th>
                  </tr></thead>
                  <tbody id="account_body">
                      <tr><td colspan="5" class="text-center text-gray-300 py-4">加载中...</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
        </div>
  
        <div id="section_projects" class="lg:col-span-5 space-y-4">
          
          <div class="bg-white rounded shadow overflow-hidden border-t-4 border-red-500 project-card">
              <div class="bg-red-50 px-4 py-2 flex justify-between items-center border-b border-red-100">
                  <span class="text-sm font-bold text-red-700">🔴 CMliu 配置</span>
                  <span id="ver_cmliu" class="text-[10px] font-mono flex items-center">Checking...</span>
              </div>
              <div class="p-3">
                  <details class="group bg-slate-50 rounded border border-slate-200 overflow-hidden mb-3">
                      <summary class="bg-slate-100 px-3 py-2 text-xs font-bold text-gray-600 border-b border-slate-200 flex justify-between hover:bg-slate-200 transition">
                          <span>📝 变量列表</span><span class="text-gray-400">▼</span>
                      </summary>
                      <div id="vars_cmliu" class="p-2 space-y-1 max-h-[250px] overflow-y-auto"></div>
                  </details>
  
                  <div class="flex gap-2 mb-2">
                       <button onclick="addVarRow('cmliu')" class="flex-1 bg-dashed border border-gray-300 text-gray-500 text-xs py-1 rounded hover:bg-gray-50 hover:text-gray-700">➕ 变量</button>
                       <button onclick="selectSyncAccount('cmliu')" class="flex-none bg-orange-50 text-orange-600 border border-orange-200 text-xs px-2 py-1 rounded hover:bg-orange-100" title="选择账号读取配置">🔄 同步</button>
                  </div>
                  <div class="flex gap-2">
                       <button onclick="refreshUUID('cmliu')" class="flex-1 bg-gray-100 text-gray-600 text-xs py-1.5 rounded hover:bg-gray-200">🎲 刷 UUID</button>
                       <button onclick="deploy('cmliu')" id="btn_deploy_cmliu" class="flex-[2] bg-red-600 text-white text-xs py-1.5 rounded hover:bg-red-700 font-bold">🚀 部署 CMliu</button>
                  </div>
              </div>
          </div>
  
          <div class="bg-white rounded shadow overflow-hidden border-t-4 border-blue-500 project-card">
              <div class="bg-blue-50 px-4 py-2 flex justify-between items-center border-b border-blue-100">
                  <span class="text-sm font-bold text-blue-700">🔵 Joey 配置</span>
                  <span id="ver_joey" class="text-[10px] font-mono flex items-center">Checking...</span>
              </div>
              <div class="p-3">
                   <details class="group bg-slate-50 rounded border border-slate-200 overflow-hidden mb-3">
                      <summary class="bg-slate-100 px-3 py-2 text-xs font-bold text-gray-600 border-b border-slate-200 flex justify-between hover:bg-slate-200 transition">
                          <span>📝 变量列表</span><span class="text-gray-400">▼</span>
                      </summary>
                      <div id="vars_joey" class="p-2 space-y-1 max-h-[250px] overflow-y-auto"></div>
                  </details>
  
                  <div class="flex gap-2 mb-2">
                       <button onclick="addVarRow('joey')" class="flex-1 bg-dashed border border-gray-300 text-gray-500 text-xs py-1 rounded hover:bg-gray-50 hover:text-gray-700">➕ 变量</button>
                       <button onclick="selectSyncAccount('joey')" class="flex-none bg-orange-50 text-orange-600 border border-orange-200 text-xs px-2 py-1 rounded hover:bg-orange-100" title="选择账号读取配置">🔄 同步</button>
                  </div>
                  
                  <div class="flex gap-2">
                       <button onclick="refreshUUID('joey')" class="flex-1 bg-gray-100 text-gray-600 text-xs py-1.5 rounded hover:bg-gray-200">🎲 刷 UUID</button>
                       <button onclick="deploy('joey')" id="btn_deploy_joey" class="flex-[2] bg-blue-600 text-white text-xs py-1.5 rounded hover:bg-blue-700 font-bold">🚀 部署 Joey</button>
                  </div>
              </div>
          </div>
  
          <div class="bg-white rounded shadow overflow-hidden border-t-4 border-green-500 project-card">
              <div class="bg-green-50 px-4 py-2 flex justify-between items-center border-b border-green-100">
                  <span class="text-sm font-bold text-green-700">🟢 ECH 配置 (固定代码)</span>
                  <span id="ver_ech" class="text-[10px] font-mono flex items-center">Checking...</span>
              </div>
              <div class="p-3">
                   <div class="mb-2 p-2 bg-slate-50 border rounded text-xs text-gray-600">
                      <p class="mb-1 font-bold">📡 ProxyIP 设置:</p>
                      <p class="text-[10px] text-gray-400 mb-2">部署时会自动将此 IP 写入代码。</p>
                      
                      <div id="ech_proxy_selector_container" class="mb-2">
                          </div>
  
                      <div id="vars_ech" class="space-y-1">
                          </div>
                   </div>
  
                  <div class="flex gap-2">
                       <button onclick="selectSyncAccount('ech')" class="flex-1 bg-orange-50 text-orange-600 border border-orange-200 text-xs px-2 py-1 rounded hover:bg-orange-100">🔄 从账号同步</button>
                       <button onclick="deploy('ech')" id="btn_deploy_ech" class="flex-[2] bg-green-600 text-white text-xs py-1.5 rounded hover:bg-green-700 font-bold">🚀 部署 ECH</button>
                  </div>
              </div>
          </div>
  
        </div>
      </div>
    </div>
  
    <div id="sync_select_modal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
        <div class="bg-white rounded-lg p-4 w-80 shadow-xl max-h-[80vh] flex flex-col">
            <h3 class="text-sm font-bold mb-3 text-gray-700">📥 选择同步源</h3>
            <p class="text-[10px] text-gray-400 mb-2">点击选择要从哪个账号读取配置：</p>
            <div id="sync_list" class="space-y-1 overflow-y-auto flex-1 mb-3"></div>
            <button onclick="document.getElementById('sync_select_modal').classList.add('hidden')" class="w-full bg-gray-200 text-gray-600 text-xs py-1.5 rounded">取消</button>
        </div>
    </div>
  
    <script>
      const TEMPLATES = {
        'cmliu': { defaultVars: ["UUID", "PROXYIP", "DOH", "PATH", "URL", "KEY", "ADMIN"], uuidField: "UUID", name: "CMliu - EdgeTunnel" },
        'joey':  { defaultVars: ["u", "d", "p"], uuidField: "u", name: "Joey - 少年你相信光吗" },
        'ech':   { defaultVars: ["PROXYIP"], uuidField: "", name: "ECH - WebSocket Proxy" }
      };

      // DOH 预设列表
      const DOH_PRESETS = [
          "https://dns.jhb.ovh/joeyblog",
          "https://doh.cmliussss.com/CMLiussss",
          "cloudflare-ech.com"
      ];
  
      const ECH_PROXIES = [
          {group:"全球 Global", list:["ProxyIP.CMLiussss.net"]},
          {group:"亚洲 Asia", list:[
              "ProxyIP.HK.CMLiussss.net (香港)", "ProxyIP.SG.CMLiussss.net (新加坡)", 
              "ProxyIP.JP.CMLiussss.net (日本)", "ProxyIP.KR.CMLiussss.net (韩国)", "ProxyIP.IN.CMLiussss.net (印度)"
          ]},
          {group:"欧洲 Europe", list:[
              "ProxyIP.GB.CMLiussss.net (英国)", "ProxyIP.FR.CMLiussss.net (法国)", "ProxyIP.DE.CMLiussss.net (德国)", 
              "ProxyIP.NL.CMLiussss.net (荷兰)", "ProxyIP.SE.CMLiussss.net (瑞典)", "ProxyIP.FI.CMLiussss.net (芬兰)",
              "ProxyIP.PL.CMLiussss.net (波兰)", "ProxyIP.RU.CMLiussss.net (俄罗斯)", "ProxyIP.CH.CMLiussss.net (瑞士)",
              "ProxyIP.LV.CMLiussss.net (拉脱维亚)"
          ]},
          {group:"北美 North America", list:[
              "ProxyIP.US.CMLiussss.net (美国)", "ProxyIP.CA.CMLiussss.net (加拿大)"
          ]}
      ];
  
      let accounts = [];
      let editingIndex = -1;
      let deletedVars = { 'cmliu': [], 'joey': [], 'ech': [] };
      let currentLayout = 'standard'; 
  
      async function init() {
          const savedLayout = localStorage.getItem('cw_layout');
          if(savedLayout) currentLayout = savedLayout;
          applyLayout();
  
          renderProxySelector();
  
          await loadAccounts();
          await Promise.all([
              loadVars('cmliu'),
              loadVars('joey'),
              loadVars('ech'),
              loadGlobalConfig()
          ]);
          loadStats();
          checkUpdate('cmliu');
          checkUpdate('joey');
          checkUpdate('ech');
      }
  
      // ECH 专属渲染 (保留原逻辑)
      function renderProxySelector() {
          const container = document.getElementById('ech_proxy_selector_container');
          let html = '<select id="ech_proxy_select" onchange="applyEchProxy()" class="w-full text-xs border border-gray-300 rounded p-1 mb-2 bg-white">';
          html += '<option value="">-- 快速选择 ProxyIP --</option>';
          ECH_PROXIES.forEach(group => {
              html += \`<optgroup label="\${group.group}">\`;
              group.list.forEach(item => {
                  const val = item.split(' ')[0];
                  html += \`<option value="\${val}">\${item}</option>\`;
              });
              html += '</optgroup>';
          });
          html += '</select>';
          container.innerHTML = html;
      }
  
      function applyEchProxy() {
          const select = document.getElementById('ech_proxy_select');
          const val = select.value;
          if (!val) return;
          
          const rows = document.querySelectorAll('.var-row-ech');
          let found = false;
          rows.forEach(r => {
              const k = r.querySelector('.var-key');
              if (k && k.value === 'PROXYIP') {
                  const v = r.querySelector('.var-val');
                  v.value = val; // ECH 默认不加端口，保持原样
                  v.classList.add('bg-green-100');
                  setTimeout(() => v.classList.remove('bg-green-100'), 500);
                  found = true;
              }
          });
          
          if (!found) {
              addVarRow('ech', 'PROXYIP', val);
          }
      }
  
      function toggleLayout() {
          currentLayout = currentLayout === 'standard' ? 'vertical' : 'standard';
          localStorage.setItem('cw_layout', currentLayout);
          applyLayout();
      }
  
      function applyLayout() {
          const container = document.getElementById('layout_container');
          const secAcc = document.getElementById('section_accounts');
          const secProj = document.getElementById('section_projects');
          const icon = document.getElementById('layout_icon');
          const text = document.getElementById('layout_text');
  
          if (currentLayout === 'vertical') {
              container.className = "flex flex-col gap-4";
              secProj.className = "grid grid-cols-1 md:grid-cols-2 gap-4 order-first"; 
              secAcc.className = "w-full order-last";
              icon.innerText = "☰";
              text.innerText = "切左右";
          } else {
              container.className = "grid grid-cols-1 lg:grid-cols-12 gap-4";
              secAcc.className = "lg:col-span-7 space-y-4";
              secProj.className = "lg:col-span-5 space-y-4 block"; 
              icon.innerText = "◫";
              text.innerText = "切上下";
          }
      }
  
      function timeAgo(dateString) {
          if(!dateString) return "无记录";
          const date = new Date(dateString);
          const seconds = Math.floor((new Date() - date) / 1000);
          if (seconds > 86400) return Math.floor(seconds/86400) + "天前";
          if (seconds > 3600) return Math.floor(seconds/3600) + "小时前";
          if (seconds > 60) return Math.floor(seconds/60) + "分钟前";
          return "刚刚";
      }
  
      async function loadAccounts() {
          try {
              const res = await fetch('/api/accounts');
              accounts = await res.json();
              accounts.forEach(a => a.stats = a.stats || { total: 0, max: 100000, loaded: false });
              renderTable();
          } catch(e) { console.error(e); }
      }
  
      function renderTable() {
          const tb = document.getElementById('account_body');
          if(accounts.length === 0) {
              tb.innerHTML = '<tr><td colspan="5" class="text-center text-gray-300 py-4">暂无账号</td></tr>';
              return;
          }
  
          tb.innerHTML = accounts.map((a,i) => {
              const loaded = a.stats && a.stats.loaded;
              const total = loaded ? a.stats.total.toLocaleString() : '-';
              const max = loaded ? a.stats.max.toLocaleString() : '-';
              const rawPercent = loaded ? (a.stats.total / a.stats.max) * 100 : 0;
              const percent = Math.min(rawPercent, 100).toFixed(1);
              
              let barColor = 'bg-green-500';
              if(rawPercent > 80) barColor = 'bg-orange-500';
              if(rawPercent >= 100) barColor = 'bg-red-600';
  
              return \`
              <tr class="hover:bg-gray-50 border-b border-gray-100">
                  <td class="font-medium">\${a.alias}</td>
                  <td>
                      \${(a.workers_cmliu||[]).map(w=>\`<span class="text-red-600 bg-red-50 border border-red-100 px-1 rounded text-[10px] mr-1">\${w}</span>\`).join('')}
                      \${(a.workers_joey||[]).map(w=>\`<span class="text-blue-600 bg-blue-50 border border-blue-100 px-1 rounded text-[10px] mr-1">\${w}</span>\`).join('')}
                      \${(a.workers_ech||[]).map(w=>\`<span class="text-green-600 bg-green-50 border border-green-100 px-1 rounded text-[10px] mr-1">\${w}</span>\`).join('')}
                  </td>
                  <td>
                      <div class="flex flex-col">
                          <span class="text-xs font-mono text-gray-700 font-bold">\${total}</span>
                          <span class="text-[10px] text-gray-400">/ \${max}</span>
                      </div>
                  </td>
                  <td>
                      <div class="flex flex-col w-full min-w-[60px] pr-2">
                          <div class="flex justify-between text-[10px] text-gray-500 mb-0.5">
                              <span>\${percent}%</span>
                          </div>
                          <div class="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
                              <div class="\${barColor} h-1.5 rounded-full" style="width: \${percent}%"></div>
                          </div>
                      </div>
                  </td>
  
                  <td class="text-right flex justify-end gap-2 py-3">
                      <button onclick="editAccount(\${i})" class="text-blue-500 hover:text-blue-700 text-sm" title="修改设置/管理变量">✎</button>
                      <button onclick="delAccount(\${i})" class="text-red-500 hover:text-red-700 text-sm" title="删除">×</button>
                  </td>
              </tr>
          \`}).join('');
      }
  
      async function loadStats() {
          const btn = document.getElementById('btn_stats');
          const originalText = btn.innerText;
          btn.innerText = '刷新...'; btn.disabled = true;
          try {
              const res = await fetch('/api/stats');
              const statsData = await res.json();
              accounts.forEach(acc => {
                  const stat = statsData.find(s => s.alias === acc.alias);
                  if (stat && !stat.error) {
                      acc.stats = { total: stat.total, max: stat.max, loaded: true };
                  } else {
                      acc.stats = { total: 0, max: 100000, loaded: true, error: true };
                  }
              });
              accounts.sort((a, b) => (b.stats.total || 0) - (a.stats.total || 0));
              renderTable();
          } catch(e) { console.error('Stats load error', e); }
          btn.innerText = originalText; btn.disabled = false;
      }
  
      function editAccount(i) {
          editingIndex = i;
          const a = accounts[i];
          
          document.getElementById('in_alias').value = a.alias;
          document.getElementById('in_id').value = a.accountId;
          document.getElementById('in_token').value = a.apiToken;
          document.getElementById('in_workers_cmliu').value = (a.workers_cmliu||[]).join(',');
          document.getElementById('in_workers_joey').value = (a.workers_joey||[]).join(',');
          document.getElementById('in_workers_ech').value = (a.workers_ech||[]).join(',');
          
          document.getElementById('edit_vars_section').classList.remove('hidden');
          document.getElementById('edit_vars_container').innerHTML = '';
          
          document.getElementById('account_form').classList.remove('hidden');
          document.getElementById('in_alias').focus();
          
          const btn = document.getElementById('btn_save_acc');
          btn.innerText = "✅ 确认修改";
          btn.className = "flex-1 bg-orange-600 text-white py-1.5 rounded font-bold hover:bg-orange-700 transition";
          document.getElementById('btn_del_edit').classList.remove('hidden');
  
          loadEditAccountVars();
      }
  
      async function loadEditAccountVars() {
          if (editingIndex === -1) return;
          const acc = accounts[editingIndex];
          const container = document.getElementById('edit_vars_container');
          const loader = document.getElementById('loading_indicator');
          
          loader.classList.remove('hidden'); 
          container.innerHTML = ''; 
  
          const workerTypes = ['cmliu', 'joey', 'ech'];
          let html = '';
  
          for (const type of workerTypes) {
              const workers = acc[\`workers_\${type}\`] || [];
              if (workers.length === 0) continue;
              
              const typeName = TEMPLATES[type].name;
              
              html += \`<div class="border rounded bg-slate-50 overflow-hidden mb-2"><div class="bg-slate-200 px-3 py-1 font-bold text-gray-700 text-xs">\${typeName}</div><div class="p-2 space-y-2">\`;
              
              for (const wName of workers) {
                  try {
                      const res = await fetch('/api/fetch_bindings', {
                          method: 'POST', body: JSON.stringify({ accountId: acc.accountId, apiToken: acc.apiToken, workerName: wName })
                      });
                      const d = await res.json();
                      html += \`<div><div class="font-mono text-blue-600 mb-1 font-bold text-xs">Worker: \${wName}</div>\`;
                      if (d.success) {
                          if (d.data.length === 0) {
                               html += \`<div class="text-[10px] text-gray-400 italic">无环境变量 (可能是纯代码部署)</div>\`;
                          } else {
                              html += \`<div class="bg-white border rounded p-1 grid grid-cols-1 gap-1">\`;
                              d.data.forEach(v => {
                                  html += \`<div class="flex items-center gap-2 border-b border-gray-100 last:border-0 pb-1 last:pb-0">
                                      <span class="font-bold text-gray-600 w-1/3 truncate text-[10px]" title="\${v.key}">\${v.key}</span>
                                      <span class="text-gray-800 font-mono w-1/2 break-all truncate text-[10px]" title="\${v.value}">\${v.value || '<i class="text-gray-300">Secret</i>'}</span>
                                      <button onclick="deleteLiveBinding('\${acc.accountId}', '\${acc.apiToken}', '\${wName}', '\${v.key}', '\${type}')" class="text-gray-300 hover:text-red-600 font-bold ml-auto px-1" title="删除">🗑️</button>
                                  </div>\`;
                              });
                              html += \`</div>\`;
                          }
                      } else { html += \`<div class="text-red-500 text-[10px]">读取失败: \${d.msg}</div>\`; }
                      html += \`</div>\`;
                  } catch(e) { html += \`<div>\${wName}: 读取错误</div>\`; }
              }
              html += \`</div></div>\`;
          }
          
          loader.classList.add('hidden'); 
          if (html === '') html = '<div class="text-center text-gray-400 text-xs">该账号未配置任何 Worker</div>';
          container.innerHTML = html;
      }
  
      async function deleteLiveBinding(accId, token, wName, key, type) {
          if (!confirm(\`⚠️ 确定要删除变量 [\${key}] 吗？\n这将触发重新拉取代码部署。\n注意：\${type === 'joey' ? 'Joey 项目会自动添加 window polyfill' : '常规模式'}\`)) return;
          const targetBtn = event.target;
          targetBtn.innerHTML = "⏳";
          try {
              const res = await fetch('/api/delete_binding', {
                  method: 'POST',
                  body: JSON.stringify({ accountId: accId, apiToken: token, workerName: wName, key: key, type: type })
              });
              const d = await res.json();
              if(d.success) {
                  loadEditAccountVars();
              } else {
                  alert("❌ 删除失败: " + d.msg);
                  targetBtn.innerHTML = "🗑️";
              }
          } catch(e) { alert("❌ 网络错误"); targetBtn.innerHTML = "🗑️"; }
      }
  
      function selectSyncAccount(type) {
          const modal = document.getElementById('sync_select_modal');
          const list = document.getElementById('sync_list');
          list.innerHTML = '';
          
          const validAccounts = accounts.filter(a => a[\`workers_\${type}\`] && a[\`workers_\${type}\`].length > 0);
          
          if (validAccounts.length === 0) {
              alert('❌ 没有账号配置了该类型的 Worker，请先在账号中添加。');
              return;
          }
  
          validAccounts.forEach(acc => {
              const wName = acc[\`workers_\${type}\`][0];
              const btn = document.createElement('button');
              btn.className = "w-full text-left bg-slate-50 hover:bg-blue-50 p-2 rounded border border-slate-100 mb-1 text-xs transition";
              btn.innerHTML = \`<div class="font-bold text-slate-700">\${acc.alias}</div><div class="text-[9px] text-gray-400">读取: \${wName}</div>\`;
              btn.onclick = () => doSync(acc, type, wName);
              list.appendChild(btn);
          });
          
          modal.classList.remove('hidden');
      }
  
      async function doSync(acc, type, workerName) {
          document.getElementById('sync_select_modal').classList.add('hidden');
          if (!confirm(\`即将从账号 [\${acc.alias}] 读取 [\${workerName}] 的配置覆盖当前面板，确定吗？\`)) return;
          
          try {
              const res = await fetch('/api/fetch_bindings', {
                  method: 'POST', body: JSON.stringify({ accountId: acc.accountId, apiToken: acc.apiToken, workerName: workerName })
              });
              const result = await res.json();
              if (result.success) {
                  const container = document.getElementById(\`vars_\${type}\`);
                  container.innerHTML = ''; 
                  deletedVars[type] = [];
                  result.data.forEach(v => addVarRow(type, v.key, v.value));
                  alert('✅ 同步成功');
              } else { alert('❌ 同步失败: ' + result.msg); }
          } catch(e) { alert('❌ 网络错误'); }
      }
  
      async function loadGlobalConfig() { try {const res=await fetch('/api/auto_config');const cfg=await res.json();document.getElementById('auto_update_toggle').checked=!!cfg.enabled;document.getElementById('auto_update_interval').value=cfg.interval||30;document.getElementById('fuse_threshold').value=cfg.fuseThreshold||0;}catch(e){} }
      async function saveAutoConfig() { const enabled=document.getElementById('auto_update_toggle').checked;const interval=parseInt(document.getElementById('auto_update_interval').value);const fuseThreshold=parseInt(document.getElementById('fuse_threshold').value);await fetch('/api/auto_config',{method:'POST',body:JSON.stringify({enabled,interval,unit:'minutes',fuseThreshold})});alert('✅ 全局设置已保存'); }
      async function loadVars(type) { const container=document.getElementById(\`vars_\${type}\`);container.innerHTML='<div class="text-gray-300 text-center py-2">加载中...</div>';try{const res=await fetch(\`/api/settings?type=\${type}\`);const savedVars=await res.json();const defaults=TEMPLATES[type].defaultVars;const uuidKey=TEMPLATES[type].uuidField;const varMap=new Map();if(Array.isArray(savedVars))savedVars.forEach(v=>varMap.set(v.key,v.value));defaults.forEach(k=>{if(!varMap.has(k))varMap.set(k,k===uuidKey?crypto.randomUUID():'');});container.innerHTML='';deletedVars[type]=[];varMap.forEach((v,k)=>{addVarRow(type,k,v);});}catch(e){container.innerHTML='加载失败';} }
      function removeVarRow(btn, type) { const row=btn.parentElement;const keyInput=row.querySelector('.var-key');if(keyInput&&keyInput.value)deletedVars[type].push(keyInput.value);row.remove(); }
      
      // [重构] 添加变量行，支持智能辅助输入 (V7.3 Update: DOH Select Support)
      function addVarRow(type, key='', val='') { 
          const container = document.getElementById(\`vars_\${type}\`);
          const div = document.createElement('div');
          div.className = \`flex gap-1 items-center mb-1 var-row-\${type}\`;
          
          let inputExtras = '';
          let helperHtml = '';
          
          // 逻辑 1: DOH 变量添加下拉辅助 (同 PROXYIP)
          if (type === 'cmliu' && key === 'DOH') {
             helperHtml = \`
              <select onchange="this.parentElement.querySelector('.var-val').value = this.value" class="w-6 border border-gray-300 rounded text-xs bg-white text-gray-500 cursor-pointer focus:outline-none focus:border-blue-500" title="快速选择 DOH">
                  <option value="">▼</option>
                  \${DOH_PRESETS.map(url => \`<option value="\${url}">\${url}</option>\`).join('')}
              </select>
             \`;
          }
          
          // 逻辑 2: Proxy 变量添加快速选择下拉框
          const isCmliuProxy = (type === 'cmliu' && key === 'PROXYIP');
          const isJoeyProxy = (type === 'joey' && key === 'p');
          
          if (isCmliuProxy || isJoeyProxy) {
              helperHtml = \`
              <select onchange="this.parentElement.querySelector('.var-val').value = this.value + ':443'" class="w-6 border border-gray-300 rounded text-xs bg-white text-gray-500 cursor-pointer focus:outline-none focus:border-blue-500" title="快速选择节点">
                  <option value="">▼</option>
                  \${ECH_PROXIES.map(g => 
                      \`<optgroup label="\${g.group}">\${g.list.map(i => \`<option value="\${i.split(' ')[0]}">\${i}</option>\`).join('')}</optgroup>\`
                  ).join('')}
              </select>
              \`;
          }

          div.innerHTML=\`
            <input class="input-field w-1/3 var-key font-bold text-gray-700" placeholder="Key" value="\${key}">
            <input class="input-field w-2/3 var-val" placeholder="Value" value="\${val}" \${inputExtras}>
            \${helperHtml}
            <button onclick="removeVarRow(this, '\${type}')" class="text-gray-400 hover:text-red-500 px-1 font-bold" title="删除并同步到Worker">×</button>
          \`;
          container.appendChild(div); 
      }

      async function deploy(type) { const btn=document.getElementById(\`btn_deploy_\${type}\`);const originalText=btn.innerText;btn.disabled=true;btn.innerText="⏳ 部署中...";const rows=document.querySelectorAll(\`.var-row-\${type}\`);const variables=[];rows.forEach(r=>{const k=r.querySelector('.var-key').value.trim();const v=r.querySelector('.var-val').value.trim();if(k)variables.push({key:k,value:v});});await fetch(\`/api/settings?type=\${type}\`,{method:'POST',body:JSON.stringify(variables)});const logBox=document.getElementById('logs');logBox.classList.remove('hidden');logBox.innerHTML=\`<div class="text-yellow-400">⚡ 正在部署 \${type} ...</div>\`;try{const res=await fetch(\`/api/deploy?type=\${type}\`,{method:'POST',body:JSON.stringify({variables,deletedVariables:deletedVars[type]})});const logs=await res.json();logBox.innerHTML+=logs.map(l=>\`<div>[\${l.success?'OK':'ERR'}] \${l.name}: <span class="text-gray-400">\${l.msg}</span></div>\`).join('');deletedVars[type]=[];setTimeout(()=>checkUpdate(type),1000);}catch(e){logBox.innerHTML+=\`<div class="text-red-500">❌ 系统错误: \${e.message}</div>\`;}btn.disabled=false;btn.innerText=originalText; }
      async function checkUpdate(type) { const el=document.getElementById(\`ver_\${type}\`);try{const res=await fetch(\`/api/check_update?type=\${type}\`);const d=await res.json();const upstreamTime=d.remote?timeAgo(d.remote.date):"未知";const localTime=d.local?timeAgo(d.local.deployDate):"无记录";const timeInfo=\`<div class="text-[10px] text-gray-500 font-medium mr-2 bg-gray-100 px-2 py-0.5 rounded border border-gray-200 flex items-center gap-2"><span>📦 上游: \${upstreamTime}</span><span class="text-gray-300">|</span><span>🏠 本地: \${localTime}</span></div>\`;if(d.remote&&(!d.local||d.remote.sha!==d.local.sha)){el.innerHTML=\`\${timeInfo}<span class="text-red-500 font-bold animate-pulse">🔴 有更新</span>\`;}else{el.innerHTML=\`\${timeInfo}<span class="text-green-600">✅ 已是最新</span>\`;}}catch(e){el.innerText='状态获取失败';} }
      function refreshUUID(type) { const key=TEMPLATES[type].uuidField;if(!key)return; const rows=document.querySelectorAll(\`.var-row-\${type}\`);rows.forEach(r=>{const k=r.querySelector('.var-key').value;if(k===key){const input=r.querySelector('.var-val');input.value=crypto.randomUUID();input.classList.add('bg-green-100');setTimeout(()=>input.classList.remove('bg-green-100'),500);}}); }
      function resetFormForAdd() { editingIndex=-1;document.getElementById('in_alias').value='';document.getElementById('in_id').value='';document.getElementById('in_token').value='';document.getElementById('in_workers_cmliu').value='';document.getElementById('in_workers_joey').value='';document.getElementById('in_workers_ech').value='';document.getElementById('edit_vars_section').classList.add('hidden');document.getElementById('account_form').classList.remove('hidden');document.getElementById('btn_save_acc').innerText="💾 保存账号";document.getElementById('btn_save_acc').className="flex-1 bg-slate-700 text-white py-1.5 rounded font-bold hover:bg-slate-800 transition";document.getElementById('btn_del_edit').classList.add('hidden'); }
      async function saveAccount() { const alias=document.getElementById('in_alias').value.trim();const id=document.getElementById('in_id').value.trim();const token=document.getElementById('in_token').value.trim();const cW=document.getElementById('in_workers_cmliu').value.split(/,|，/).map(s=>s.trim()).filter(s=>s);const jW=document.getElementById('in_workers_joey').value.split(/,|，/).map(s=>s.trim()).filter(s=>s);const eW=document.getElementById('in_workers_ech').value.split(/,|，/).map(s=>s.trim()).filter(s=>s);if(!id||!token)return alert('ID 和 Token 必填');const accObj={alias:alias||'未命名',accountId:id,apiToken:token,workers_cmliu:cW,workers_joey:jW,workers_ech:eW};if(editingIndex>=0&&accounts[editingIndex].stats){accObj.stats=accounts[editingIndex].stats;}else{accObj.stats={total:0,max:100000,loaded:false};}if(editingIndex>=0){accounts[editingIndex]=accObj;}else{accounts.push(accObj);}await fetch('/api/accounts',{method:'POST',body:JSON.stringify(accounts)});accounts.sort((a,b)=>(b.stats.total||0)-(a.stats.total||0));renderTable();resetFormForAdd();document.getElementById('account_form').classList.add('hidden'); }
      function cancelEdit() { resetFormForAdd();document.getElementById('account_form').classList.add('hidden'); }
      async function delAccount(i) { if(!confirm('确定要删除此账号吗？此操作不可恢复。'))return;accounts.splice(i,1);await fetch('/api/accounts',{method:'POST',body:JSON.stringify(accounts)});renderTable();if(editingIndex===i)cancelEdit(); }
      async function deleteFromEdit() { if(editingIndex===-1)return;if(!confirm('确定要删除当前编辑的账号吗？'))return;accounts.splice(editingIndex,1);await fetch('/api/accounts',{method:'POST',body:JSON.stringify(accounts)});renderTable();cancelEdit(); }
  
      init();
    </script>
  </body></html>
    `;
  }
