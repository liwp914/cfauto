/**
 * Cloudflare Worker 多项目部署管理器 (V7.5 Full Expanded)
 * * 版本特性：
 * 1. [收藏夹] 支持将特定版本加入收藏，永久置顶。
 * 2. [动态历史] 支持前端自定义获取历史版本的数量 (Limit)。
 * 3. [完全展开] 代码无任何压缩，逻辑清晰可见。
 */

// ==========================================
// 1. 项目模板配置
// ==========================================
const TEMPLATES = {
    'cmliu': {
      name: "CMliu - EdgeTunnel",
      ghUser: "cmliu",
      ghRepo: "edgetunnel",
      ghBranch: "beta2.0",
      ghPath: "_worker.js",
      defaultVars: ["UUID", "PROXYIP", "DOH", "PATH", "URL", "KEY", "ADMIN"],
      uuidField: "UUID",
      description: "CMliu (beta2.0)"
    },
    'joey': {
      name: "Joey - 少年你相信光吗",
      ghUser: "byJoey",
      ghRepo: "cfnew",
      ghBranch: "main",
      ghPath: "少年你相信光吗",
      defaultVars: ["u", "d", "p"],
      uuidField: "u",
      description: "Joey (自动修复)"
    },
    'ech': {
      name: "ECH - WebSocket Proxy",
      ghUser: "hc990275",
      ghRepo: "ech-wk",
      ghBranch: "main",
      ghPath: "_worker.js",
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
      
      // PWA Manifest 配置
      if (url.pathname === "/manifest.json") {
          return new Response(JSON.stringify({
              "name": "Worker 中控 Pro",
              "short_name": "WorkerPro",
              "start_url": "/",
              "display": "standalone",
              "background_color": "#f3f4f6",
              "theme_color": "#1e293b",
              "icons": [{ "src": "https://www.cloudflare.com/img/logo-cloudflare-dark.svg", "sizes": "192x192", "type": "image/svg+xml" }]
          }), { headers: { "Content-Type": "application/json" } });
      }

      // 登录验证逻辑
      if (correctCode && !cookieHeader.includes(`auth=${correctCode}`) && urlCode !== correctCode) {
        return new Response(loginHtml(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }
  
      // 常量定义
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

      // API: 获取部署状态 (判断是否锁定)
      if (url.pathname === "/api/deploy_config") {
          const type = url.searchParams.get("type");
          const key = `DEPLOY_CONFIG_${type}`;
          const defaultCfg = { mode: 'latest', currentSha: null, deployTime: null };
          const stored = await env.CONFIG_KV.get(key);
          return new Response(stored || JSON.stringify(defaultCfg), { headers: { "Content-Type": "application/json" } });
      }
      
      // [新增] API: 收藏夹管理
      if (url.pathname === "/api/favorites") {
          const type = url.searchParams.get("type");
          const key = `FAVORITES_${type}`;
          
          if (request.method === "GET") {
              return new Response(await env.CONFIG_KV.get(key) || "[]", { headers: { "Content-Type": "application/json" } });
          }
          
          if (request.method === "POST") {
              const { action, item } = await request.json();
              let favs = JSON.parse(await env.CONFIG_KV.get(key) || "[]");
              
              if (action === 'add') {
                  // 避免重复添加
                  if (!favs.find(f => f.sha === item.sha)) {
                      favs.unshift(item); // 添加到头部
                  }
              } else if (action === 'remove') {
                  favs = favs.filter(f => f.sha !== item.sha);
              }
              
              await env.CONFIG_KV.put(key, JSON.stringify(favs));
              return new Response(JSON.stringify({ success: true, favorites: favs }), { headers: { "Content-Type": "application/json" } });
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
            // 保留上次检查时间，避免被重置
            body.lastCheck = oldCfg.lastCheck || 0; 
            await env.CONFIG_KV.put(GLOBAL_CONFIG_KEY, JSON.stringify(body));
            return new Response(JSON.stringify({ success: true }));
        }
      }
  
      // API: 检查更新 (支持 limit 参数)
      if (url.pathname === "/api/check_update") {
          const type = url.searchParams.get("type");
          const mode = url.searchParams.get("mode"); // 'latest' or 'history'
          const limit = url.searchParams.get("limit") || 10; // [新增] 获取数量
          return await handleCheckUpdate(env, type, mode, limit);
      }
  
      // API: 部署 (支持指定 SHA)
      if (url.pathname === "/api/deploy" && request.method === "POST") {
        const type = url.searchParams.get("type");
        const { variables, deletedVariables, targetSha } = await request.json();
        return await handleManualDeploy(env, type, variables, deletedVariables, ACCOUNTS_KEY, targetSha);
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
  
      // API: 删除线上变量
      if (url.pathname === "/api/delete_binding" && request.method === "POST") {
          const data = await request.json();
          return await handleDeleteBinding(env, data);
      }
  
      const response = new Response(mainHtml(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      if (urlCode === correctCode && correctCode) {
        response.headers.set("Set-Cookie", `auth=${correctCode}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
      }
      return response;
    }
  };
  
  // ================= 辅助函数区 =================
  
  // 构造 GitHub URL (API 或 Raw)
  function getGithubUrls(type, sha = null) {
      const t = TEMPLATES[type];
      const safePath = t.ghPath.split('/').map(p => encodeURIComponent(p)).join('/');
      
      const apiUrl = `https://api.github.com/repos/${t.ghUser}/${t.ghRepo}/commits`;
      
      // 如果没有 SHA，默认使用 Branch (Latest)
      // 如果有 SHA，使用 SHA (Fixed)
      const ref = sha || t.ghBranch;
      const scriptUrl = `https://raw.githubusercontent.com/${t.ghUser}/${t.ghRepo}/${ref}/${safePath}`;
      
      return { apiUrl, scriptUrl, branch: t.ghBranch };
  }

  // Cron 任务 (核心：熔断时遵守版本锁定)
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
      const intervalMs = intervalVal * 60 * 1000;
  
      if (now - lastCheck <= intervalMs) return;
      console.log(`[Cron] 🕒 Global Check Started.`);
      
      const accounts = JSON.parse(await env.CONFIG_KV.get(ACCOUNTS_KEY) || "[]");
      if (accounts.length === 0) return;
      
      const statsData = await fetchInternalStats(accounts);
      let actionTaken = false;
  
      // === 熔断逻辑 ===
      const fuseThreshold = parseInt(config.fuseThreshold || 0);
      if (fuseThreshold > 0) {
          for (const acc of accounts) {
              const stat = statsData.find(s => s.alias === acc.alias);
              if (!stat || stat.error) continue;
              const limit = stat.max || 100000;
              const usedPercent = (stat.total / limit) * 100;
              
              if (usedPercent >= fuseThreshold) {
                  // 熔断时，严格遵守当前的部署版本配置
                  await rotateUUIDAndDeploy(env, 'cmliu', accounts, ACCOUNTS_KEY);
                  await rotateUUIDAndDeploy(env, 'joey', accounts, ACCOUNTS_KEY);
                  actionTaken = true;
                  break; 
              }
          }
      }
  
      // === 自动更新逻辑 ===
      // 只有在没有触发熔断时才检查更新
      if (!actionTaken) {
          await Promise.all([
              checkAndDeployUpdate(env, 'cmliu', accounts, ACCOUNTS_KEY),
              checkAndDeployUpdate(env, 'joey', accounts, ACCOUNTS_KEY)
          ]);
      }
  
      config.lastCheck = now;
      await env.CONFIG_KV.put(GLOBAL_CONFIG_KEY, JSON.stringify(config));
  }
  
  // 检查并部署更新 (自动更新模式)
  async function checkAndDeployUpdate(env, type, accounts, accountsKey) {
      try {
          // 如果处于锁定模式，则跳过
          const deployConfigKey = `DEPLOY_CONFIG_${type}`;
          const deployConfig = JSON.parse(await env.CONFIG_KV.get(deployConfigKey) || '{"mode":"latest"}');
          if (deployConfig.mode === 'fixed') return; 

          const VERSION_KEY = `VERSION_INFO_${type}`;
          const res = await handleCheckUpdate(env, type, 'latest');
          const checkData = await res.json();
          
          if (checkData.remote && (!checkData.local || checkData.remote.sha !== checkData.local.sha)) {
              const VARS_KEY = `VARS_${type}`;
              const varsStr = await env.CONFIG_KV.get(VARS_KEY);
              const variables = varsStr ? JSON.parse(varsStr) : [];
              // 自动更新强制使用 'latest'
              await coreDeployLogic(env, type, variables, [], accountsKey, 'latest');
          }
      } catch(e) { console.error(`[Update Error] ${type}: ${e.message}`); }
  }
  
  // 旋转 UUID 并部署 (熔断专用)
  async function rotateUUIDAndDeploy(env, type, accounts, accountsKey) {
      const VARS_KEY = `VARS_${type}`;
      const varsStr = await env.CONFIG_KV.get(VARS_KEY);
      let variables = varsStr ? JSON.parse(varsStr) : [];
      const uuidField = TEMPLATES[type].uuidField;
      if (!uuidField) return; 
  
      // 1. 更新 UUID
      let uuidUpdated = false;
      variables = variables.map(v => {
          if (v.key === uuidField) { v.value = crypto.randomUUID(); uuidUpdated = true; }
          return v;
      });
      if (!uuidUpdated) variables.push({ key: uuidField, value: crypto.randomUUID() });
      await env.CONFIG_KV.put(VARS_KEY, JSON.stringify(variables));
  
      // 2. 获取当前部署策略 (决定使用哪个版本的代码)
      const deployConfigKey = `DEPLOY_CONFIG_${type}`;
      const deployConfig = JSON.parse(await env.CONFIG_KV.get(deployConfigKey) || '{"mode":"latest"}');
      const targetSha = deployConfig.mode === 'fixed' ? deployConfig.currentSha : 'latest';
      
      // 3. 执行部署
      await coreDeployLogic(env, type, variables, [], accountsKey, targetSha);
  }
  
  // 检查更新接口 (支持 Limit)
  async function handleCheckUpdate(env, type, mode, limit = 10) {
      try {
          const VERSION_KEY = `VERSION_INFO_${type}`;
          const localData = JSON.parse(await env.CONFIG_KV.get(VERSION_KEY) || "null");
          
          const { apiUrl, branch } = getGithubUrls(type);
          
          let fetchUrl = apiUrl;
          if (mode === 'history') {
              fetchUrl += `?sha=${branch}&per_page=${limit}`; // 动态 Limit
          } else {
              fetchUrl += `?sha=${branch}&per_page=1`;
          }
          
          const headers = { "User-Agent": "Cloudflare-Worker-Manager" };
          if (env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim() !== "") headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;
  
          const ghRes = await fetch(fetchUrl + `&t=${Date.now()}`, { headers });
          if (!ghRes.ok) throw new Error(`GitHub API Error: ${ghRes.status}`);
          const ghData = await ghRes.json();
          
          if (mode === 'history') {
              return new Response(JSON.stringify({ history: ghData }), { headers: { "Content-Type": "application/json" } });
          }
  
          const commitObj = Array.isArray(ghData) ? ghData[0] : ghData;
          return new Response(JSON.stringify({ 
              local: localData, 
              remote: { sha: commitObj.sha, date: commitObj.commit.committer.date, message: commitObj.commit.message } 
          }), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
  }
  
  // 手动部署入口
  async function handleManualDeploy(env, type, variables, deletedVariables, accountsKey, targetSha) {
      // 'latest' 字符串转为 null，以便 coreDeployLogic 识别
      const actualSha = (targetSha === 'latest' || targetSha === '') ? null : targetSha;
      const result = await coreDeployLogic(env, type, variables, deletedVariables, accountsKey, actualSha);
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  }

  // 核心部署逻辑 (完全体)
  async function coreDeployLogic(env, type, variables, deletedVariables, accountsKey, targetSha) {
      try {
          const accounts = JSON.parse(await env.CONFIG_KV.get(accountsKey) || "[]");
          if (accounts.length === 0) return [{ name: "提示", success: false, msg: "无账号配置" }];
          
          // 1. 获取代码链接
          const { scriptUrl, apiUrl } = getGithubUrls(type, targetSha);
          let githubScriptContent = "";
          let deployedSha = targetSha;
          
          try {
              // 2. 拉取代码
              const codeRes = await fetch(scriptUrl + `?t=${Date.now()}`);
              if (!codeRes.ok) throw new Error(`代码下载失败: ${codeRes.status}`);
              githubScriptContent = await codeRes.text();
              
              // 3. 如果是 Latest，需要补全 SHA 信息以便记录
              if (!deployedSha) {
                  const headers = { "User-Agent": "CF-Worker" };
                  if (env.GITHUB_TOKEN) headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;
                  const apiRes = await fetch(apiUrl + `?sha=${TEMPLATES[type].ghBranch}&per_page=1`, { headers });
                  if (apiRes.ok) {
                      const json = await apiRes.json();
                      deployedSha = (Array.isArray(json) ? json[0] : json).sha;
                  }
              }
          } catch (e) { return [{ name: "网络错误", success: false, msg: e.message }]; }
  
          // 4. 代码注入/预处理
          if (type === 'joey') githubScriptContent = 'var window = globalThis;\n' + githubScriptContent;
          if (type === 'ech') {
             const proxyVar = variables ? variables.find(v => v.key === 'PROXYIP') : null;
             const targetIP = proxyVar && proxyVar.value ? proxyVar.value.trim() : 'ProxyIP.CMLiussss.net';
             const regex = /const\s+CF_FALLBACK_IPS\s*=\s*\[.*?\];/s;
             githubScriptContent = githubScriptContent.replace(regex, `const CF_FALLBACK_IPS = ['${targetIP}'];`);
          }
  
          const logs = [];
          let updateCount = 0;
          
          // 5. 遍历账号部署
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
                      variables.forEach(v => {
                          if (v.value && v.value.trim() !== "") {
                              const idx = currentBindings.findIndex(b => b.name === v.key);
                              if (idx !== -1) currentBindings[idx] = { name: v.key, type: "plain_text", text: v.value };
                              else currentBindings.push({ name: v.key, type: "plain_text", text: v.value });
                          }
                      });
                  }
                  
                  const metadata = { main_module: "index.js", bindings: currentBindings, compatibility_date: "2024-01-01" };
                  const formData = new FormData();
                  formData.append("metadata", JSON.stringify(metadata));
                  formData.append("script", new Blob([githubScriptContent], { type: "application/javascript+module" }), "index.js");
                  const updateRes = await fetch(baseUrl, { method: "PUT", headers, body: formData });
                  
                  if (updateRes.ok) { 
                      logItem.success = true; 
                      logItem.msg = `✅ Ver: ${deployedSha ? deployedSha.substring(0,7) : 'Unknown'}`; 
                  } else { 
                      logItem.msg = `❌ ${(await updateRes.json()).errors?.[0]?.message}`; 
                  }
                } catch (err) { logItem.msg = `❌ ${err.message}`; }
                logs.push(logItem);
            } 
          }
  
          // 6. 保存状态 (版本信息 + 锁定状态)
          if (updateCount > 0 && deployedSha) {
              const VERSION_KEY = `VERSION_INFO_${type}`;
              await env.CONFIG_KV.put(VERSION_KEY, JSON.stringify({ sha: deployedSha, deployDate: new Date().toISOString() }));
              
              const DEPLOY_CONFIG_KEY = `DEPLOY_CONFIG_${type}`;
              const mode = targetSha ? 'fixed' : 'latest';
              await env.CONFIG_KV.put(DEPLOY_CONFIG_KEY, JSON.stringify({
                  mode: mode,
                  currentSha: deployedSha,
                  deployTime: new Date().toISOString()
              }));
          }
          return logs;
      } catch (e) { return [{ name: "系统错误", success: false, msg: e.message }]; }
  }
  
  // 统计功能
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
           method: "POST", headers: { "Authorization": `Bearer ${acc.apiToken}`, "Content-Type": "application/json" },
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
  
  async function handleStats(env, k) {
      try {
          const accounts = JSON.parse(await env.CONFIG_KV.get(k) || "[]");
          const results = await fetchInternalStats(accounts);
          return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
      } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
  }

  // 变量获取
  async function handleFetchBindings({accountId, apiToken, workerName}) {
      try {
          const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/bindings`, { headers: { "Authorization": `Bearer ${apiToken}` } });
          const data = await res.json();
          const bindings = data.result
              .filter(b => b.type === "plain_text" || b.type === "secret_text")
              .map(b => ({ key: b.name, value: b.type === "plain_text" ? b.text : "" }));
          return new Response(JSON.stringify({ success: true, data: bindings }), { headers: { "Content-Type": "application/json" } });
      } catch(e) { return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500 }); }
  }

  // 删除绑定 (为了简化，复用部署逻辑)
  async function handleDeleteBinding(env, {accountId, apiToken, workerName, key, type}) {
      // 这里的逻辑可以优化为只调用 Cloudflare API 删除，但为了保证代码一致性，建议重新部署
      // 暂时返回一个简单的信号，前端会重新触发部署逻辑
      return new Response(JSON.stringify({ success: false, msg: "建议使用完整部署流程更新" }), { status: 200 }); 
  }
  
  function loginHtml() { return `<!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f3f4f6"><form method="GET"><input type="password" name="code" placeholder="密码" style="padding:10px"><button style="padding:10px">登录</button></form></body></html>`; }
  
  // ==========================================
  // 2. 前端页面 (完全展开版 HTML)
  // ==========================================
  function mainHtml() {
    return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="manifest" href="/manifest.json">
    <title>Worker 智能中控 (V7.5 Full)</title>
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
    </style>
  </head>
  <body class="bg-slate-100 p-2 md:p-4 min-h-screen text-slate-700">
    <div class="max-w-7xl mx-auto space-y-4">
      
      <header class="bg-white px-4 py-3 md:px-6 md:py-4 rounded shadow flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
          <div class="flex-none">
              <h1 class="text-xl font-bold text-slate-800 flex items-center gap-2">🚀 Worker 部署中控 <span class="text-xs bg-purple-600 text-white px-2 py-0.5 rounded ml-2">V7.5</span></h1>
              <div class="text-[10px] text-gray-400 mt-1">全局管理 · 收藏夹 · 动态历史深度</div>
          </div>
          <div id="logs" class="bg-slate-900 text-green-400 p-2 rounded text-xs font-mono hidden max-h-[80px] lg:max-h-[50px] overflow-y-auto shadow-inner w-full lg:flex-1 lg:mx-4 order-2 lg:order-none"></div>
          
          <div class="flex flex-wrap items-center gap-2 md:gap-3 bg-slate-50 p-2 rounded border border-slate-200 w-full lg:w-auto flex-none text-xs">
               <button onclick="toggleLayout()" class="bg-white border text-gray-600 px-2 py-1 rounded hover:bg-gray-50">◫ 布局</button>
               <div class="w-px h-4 bg-gray-300 mx-1"></div>
               
               <div class="flex items-center gap-1">
                  <span>自动更新:</span>
                  <div class="relative inline-block w-8 align-middle select-none">
                      <input type="checkbox" id="auto_update_toggle" class="toggle-checkbox absolute block w-4 h-4 rounded-full bg-white border-4 appearance-none cursor-pointer border-gray-300"/>
                      <label for="auto_update_toggle" class="toggle-label block overflow-hidden h-4 rounded-full bg-gray-300 cursor-pointer"></label>
                  </div>
               </div>
               <div class="flex items-center gap-1">
                  <input type="number" id="auto_update_interval" value="30" class="w-8 text-center border rounded py-0.5"><span>分</span>
               </div>
               
               <div class="w-px h-4 bg-gray-300 mx-1"></div>
               <div class="flex items-center gap-1" title="获取 GitHub 历史提交的数量">
                  <span class="font-bold text-gray-600">历史:</span>
                  <input type="number" id="history_limit" value="10" placeholder="10" class="w-10 text-center border border-blue-200 bg-blue-50 rounded py-0.5 text-blue-600 font-bold">
               </div>

               <div class="w-px h-4 bg-gray-300 mx-1"></div>
               <div class="flex items-center gap-1">
                  <span class="text-red-600 font-bold">熔断:</span>
                  <input type="number" id="fuse_threshold" value="0" placeholder="0" class="w-8 text-center border border-red-300 bg-red-50 rounded py-0.5 font-bold text-red-600">
               </div>
               <button onclick="saveAutoConfig()" class="bg-slate-700 text-white px-2 py-1 rounded hover:bg-slate-800 font-bold ml-1">保存</button>
          </div>
      </header>
      
      <div id="layout_container" class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div id="section_accounts" class="lg:col-span-7 space-y-4">
            <div class="bg-white p-4 rounded shadow flex-1">
              <div class="flex justify-between items-center mb-3">
                   <h2 class="font-bold text-gray-700 text-sm">📡 账号列表 (按流量降序)</h2>
                   <div class="flex gap-2">
                       <button onclick="loadStats()" id="btn_stats" class="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-1 rounded font-bold hover:bg-indigo-100">🔄 刷新用量</button>
                       <button onclick="resetFormForAdd()" class="text-[10px] bg-blue-50 text-blue-600 px-2 py-1 rounded">➕ 添加账号</button>
                   </div>
              </div>
              
              <div id="account_form" class="hidden bg-slate-50 p-3 mb-3 border rounded text-xs space-y-3">
                 <div class="flex gap-2">
                    <input id="in_alias" placeholder="备注" class="input-field w-1/3">
                    <input id="in_id" placeholder="Account ID" class="input-field w-2/3">
                 </div>
                 <input id="in_token" type="password" placeholder="API Token" class="input-field">
                 <div class="grid grid-cols-3 gap-2">
                    <input id="in_workers_cmliu" placeholder="🔴 CMliu Worker" class="input-field bg-red-50">
                    <input id="in_workers_joey" placeholder="🔵 Joey Worker" class="input-field bg-blue-50">
                    <input id="in_workers_ech" placeholder="🟢 ECH Worker" class="input-field bg-green-50">
                 </div>
                 <div class="flex gap-2 pt-2">
                    <button onclick="saveAccount()" id="btn_save_acc" class="flex-1 bg-slate-700 text-white py-1.5 rounded font-bold">💾 保存账号</button>
                    <button onclick="deleteFromEdit()" id="btn_del_edit" class="hidden flex-none bg-red-100 text-red-600 px-3 py-1.5 rounded">🗑️</button>
                    <button onclick="cancelEdit()" class="flex-none bg-gray-200 text-gray-600 px-3 py-1.5 rounded">❌</button>
                 </div>
                 <div id="edit_vars_section" class="hidden border-t pt-2 mt-2">
                    <div id="edit_vars_container" class="space-y-2"></div>
                 </div>
              </div>
              
              <div id="account_list_container" class="overflow-x-auto min-h-[300px]">
                  <table class="w-full compact-table">
                      <thead>
                          <tr>
                              <th>备注</th>
                              <th>Worker</th>
                              <th>流量</th>
                              <th>占比</th>
                              <th class="text-right">操作</th>
                          </tr>
                      </thead>
                      <tbody id="account_body"></tbody>
                  </table>
              </div>
            </div>
        </div>
  
        <div id="section_projects" class="lg:col-span-5 space-y-4">
          
          <div class="bg-white rounded shadow border-t-4 border-red-500 project-card">
              <div class="bg-red-50 px-4 py-2 flex justify-between items-center border-b border-red-100">
                  <div class="flex items-center gap-2">
                      <span class="text-sm font-bold text-red-700">🔴 CMliu 配置</span>
                      <span id="badge_cmliu" class="text-[9px] px-1.5 py-0.5 rounded text-white bg-gray-400">Loading</span>
                  </div>
                  <button onclick="openVersionHistory('cmliu')" class="text-[10px] bg-white border border-red-200 text-red-600 px-2 py-0.5 rounded hover:bg-red-50">📜 历史/收藏</button>
              </div>
              <div class="p-3">
                  <div id="ver_cmliu" class="text-[10px] font-mono text-gray-400 mb-2 border-b border-gray-100 pb-2">Checking...</div>
                  <details class="group bg-slate-50 rounded border mb-2">
                      <summary class="bg-slate-100 px-2 py-1 text-xs font-bold text-gray-600 flex justify-between"><span>📝 变量列表</span><span>▼</span></summary>
                      <div id="vars_cmliu" class="p-2 space-y-1 max-h-[200px] overflow-y-auto"></div>
                  </details>
                  <div class="flex gap-2 mb-2">
                      <button onclick="addVarRow('cmliu')" class="flex-1 bg-dashed border text-gray-400 text-xs py-1 rounded hover:text-gray-600">➕ 变量</button>
                      <button onclick="selectSyncAccount('cmliu')" class="flex-none bg-orange-50 text-orange-600 border border-orange-200 text-xs px-2 py-1 rounded">🔄 同步</button>
                  </div>
                  <div class="flex gap-2">
                      <button onclick="refreshUUID('cmliu')" class="flex-1 bg-gray-100 text-gray-600 text-xs py-1.5 rounded">🎲 刷 UUID</button>
                      <button onclick="deploy('cmliu')" id="btn_deploy_cmliu" class="flex-[2] bg-red-600 text-white text-xs py-1.5 rounded font-bold hover:bg-red-700">🚀 部署</button>
                  </div>
              </div>
          </div>

          <div class="bg-white rounded shadow border-t-4 border-blue-500 project-card">
              <div class="bg-blue-50 px-4 py-2 flex justify-between items-center border-b border-blue-100">
                  <div class="flex items-center gap-2">
                      <span class="text-sm font-bold text-blue-700">🔵 Joey 配置</span>
                      <span id="badge_joey" class="text-[9px] px-1.5 py-0.5 rounded text-white bg-gray-400">Loading</span>
                  </div>
                  <button onclick="openVersionHistory('joey')" class="text-[10px] bg-white border border-blue-200 text-blue-600 px-2 py-0.5 rounded hover:bg-blue-50">📜 历史/收藏</button>
              </div>
              <div class="p-3">
                  <div id="ver_joey" class="text-[10px] font-mono text-gray-400 mb-2 border-b border-gray-100 pb-2">Checking...</div>
                  <details class="group bg-slate-50 rounded border mb-2">
                      <summary class="bg-slate-100 px-2 py-1 text-xs font-bold text-gray-600 flex justify-between"><span>📝 变量列表</span><span>▼</span></summary>
                      <div id="vars_joey" class="p-2 space-y-1 max-h-[200px] overflow-y-auto"></div>
                  </details>
                  <div class="flex gap-2 mb-2">
                      <button onclick="addVarRow('joey')" class="flex-1 bg-dashed border text-gray-400 text-xs py-1 rounded hover:text-gray-600">➕ 变量</button>
                      <button onclick="selectSyncAccount('joey')" class="flex-none bg-orange-50 text-orange-600 border border-orange-200 text-xs px-2 py-1 rounded">🔄 同步</button>
                  </div>
                  <div class="flex gap-2">
                      <button onclick="refreshUUID('joey')" class="flex-1 bg-gray-100 text-gray-600 text-xs py-1.5 rounded">🎲 刷 UUID</button>
                      <button onclick="deploy('joey')" id="btn_deploy_joey" class="flex-[2] bg-blue-600 text-white text-xs py-1.5 rounded font-bold hover:bg-blue-700">🚀 部署</button>
                  </div>
              </div>
          </div>
          
          <div class="bg-white rounded shadow border-t-4 border-green-500 project-card">
              <div class="bg-green-50 px-4 py-2 flex justify-between items-center border-b border-green-100">
                  <span class="text-sm font-bold text-green-700">🟢 ECH 配置</span>
                  <span class="text-[9px] px-1.5 py-0.5 rounded text-white bg-green-500">Stable</span>
              </div>
              <div class="p-3">
                  <div class="mb-2 p-2 bg-slate-50 border rounded text-xs">
                      <div id="ech_proxy_selector_container" class="mb-2"></div>
                      <div id="vars_ech" class="space-y-1"></div>
                  </div>
                  <div class="flex gap-2">
                      <button onclick="selectSyncAccount('ech')" class="flex-1 bg-orange-50 text-orange-600 border border-orange-200 text-xs px-2 py-1 rounded hover:bg-orange-100">🔄 同步</button>
                      <button onclick="deploy('ech')" id="btn_deploy_ech" class="flex-[2] bg-green-600 text-white text-xs py-1.5 rounded hover:bg-green-700 font-bold">🚀 部署 ECH</button>
                  </div>
              </div>
          </div>

        </div>
      </div>
    </div>
  
    <div id="history_modal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
        <div class="bg-white rounded-lg w-[450px] shadow-xl max-h-[85vh] flex flex-col overflow-hidden">
            <div class="p-3 border-b bg-gray-50 flex justify-between items-center">
                <h3 class="text-sm font-bold text-gray-700">📜 版本管理</h3>
                <button onclick="document.getElementById('history_modal').classList.add('hidden')" class="text-gray-400 hover:text-gray-600 text-lg">×</button>
            </div>
            <div class="flex-1 overflow-y-auto bg-slate-50 p-2 space-y-3">
                
                <div id="fav_section" class="hidden">
                    <div class="text-[10px] font-bold text-orange-600 uppercase tracking-wider mb-1 px-1">⭐ 收藏夹 (Favorites)</div>
                    <div id="fav_list" class="space-y-1"></div>
                </div>

                <div>
                    <div class="flex justify-between items-end px-1 mb-1">
                        <div class="text-[10px] font-bold text-gray-500 uppercase tracking-wider">🕒 最近提交 (History)</div>
                        <div class="text-[9px] text-gray-400" id="history_count_display"></div>
                    </div>
                    <div id="history_list" class="space-y-1 min-h-[100px]"></div>
                </div>
            </div>
            <div class="p-2 border-t bg-white text-[10px] text-gray-500 text-center">
                <p>点击列表项即可回滚/锁定到该版本 (将自动停止自动更新)</p>
            </div>
        </div>
    </div>
    
    <div id="sync_select_modal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
        <div class="bg-white rounded-lg p-4 w-80 shadow-xl max-h-[80vh] flex flex-col">
            <h3 class="text-sm font-bold mb-3 text-gray-700">📥 选择同步源</h3>
            <div id="sync_list" class="space-y-1 overflow-y-auto flex-1 mb-3"></div>
            <button onclick="document.getElementById('sync_select_modal').classList.add('hidden')" class="w-full bg-gray-200 text-gray-600 text-xs py-1.5 rounded">取消</button>
        </div>
    </div>
  
    <script>
      // ================= 配置常量 =================
      const TEMPLATES = { 
        'cmliu': { defaultVars: ["UUID", "PROXYIP", "DOH", "PATH", "URL", "KEY", "ADMIN"], uuidField: "UUID", name: "CMliu" }, 
        'joey': { defaultVars: ["u", "d", "p"], uuidField: "u", name: "Joey" }, 
        'ech': { defaultVars: ["PROXYIP"], uuidField: "", name: "ECH" } 
      };
      const DOH_PRESETS = ["https://dns.jhb.ovh/joeyblog","https://doh.cmliussss.com/CMLiussss","cloudflare-ech.com"];
      const ECH_PROXIES = [{group:"Global", list:["ProxyIP.CMLiussss.net"]}, {group:"Asia", list:["ProxyIP.HK.CMLiussss.net (HK)","ProxyIP.SG.CMLiussss.net (SG)","ProxyIP.JP.CMLiussss.net (JP)"]}];
  
      // ================= 全局变量 =================
      let accounts = [];
      let editingIndex = -1;
      let deletedVars = { cmliu: [], joey: [], ech: [] };
      let currentLayout = 'standard';
      let deployConfigs = {}; // 存储每个项目的部署状态 (mode, sha)
  
      // ================= 初始化 =================
      async function init() {
          const savedLayout = localStorage.getItem('cw_layout'); 
          if(savedLayout){ currentLayout = savedLayout; applyLayout(); }
          
          renderProxySelector();
          await loadAccounts();
          await Promise.all(['cmliu','joey','ech'].map(t => loadVars(t)));
          await loadGlobalConfig();
          loadStats();
          
          // 加载项目锁定状态
          checkDeployConfig('cmliu'); 
          checkDeployConfig('joey');
          
          // 检查版本更新
          checkUpdate('cmliu'); 
          checkUpdate('joey'); 
          checkUpdate('ech');
      }

      // ================= 核心新功能：历史与收藏 =================

      // 打开版本历史弹窗
      async function openVersionHistory(type) {
          const modal = document.getElementById('history_modal');
          const hList = document.getElementById('history_list');
          const fList = document.getElementById('fav_list');
          const fSec = document.getElementById('fav_section');
          
          // 获取用户设置的历史数量
          const limit = document.getElementById('history_limit').value || 10;
          
          modal.classList.remove('hidden');
          hList.innerHTML = '<div class="text-center text-gray-400 text-xs py-4">加载中...</div>';
          fList.innerHTML = ''; 
          fSec.classList.add('hidden');
          document.getElementById('history_count_display').innerText = \`Fetch Limit: \${limit}\`;

          try {
              // 并行获取：历史提交 + 收藏夹
              const [histRes, favRes] = await Promise.all([
                  fetch(\`/api/check_update?type=\${type}&mode=history&limit=\${limit}\`),
                  fetch(\`/api/favorites?type=\${type}\`)
              ]);
              const histData = await histRes.json();
              const favData = await favRes.json();

              // 1. 渲染收藏夹
              if (favData && favData.length > 0) {
                  fSec.classList.remove('hidden');
                  favData.forEach(item => renderHistoryItem(type, item, fList, true));
              }

              // 2. 渲染历史列表
              hList.innerHTML = '';
              
              // 添加 "Always Latest" 选项
              const latestBtn = document.createElement('div');
              latestBtn.className = "bg-green-50 hover:bg-green-100 p-2 rounded border border-green-200 cursor-pointer transition mb-2";
              latestBtn.innerHTML = \`<div class="flex justify-between items-center"><span class="font-bold text-green-700 text-xs">⚡ Always Latest (恢复自动更新)</span></div><div class="text-[9px] text-green-600 mt-1">每次部署拉取最新代码。</div>\`;
              latestBtn.onclick = () => { modal.classList.add('hidden'); deploy(type, 'latest'); };
              hList.appendChild(latestBtn);

              if (histData.history) {
                  histData.history.forEach(commit => {
                      const item = { 
                          sha: commit.sha, 
                          date: commit.commit.committer.date, 
                          message: commit.commit.message 
                      };
                      // 检查该版本是否已在收藏夹中
                      const isFav = favData && favData.find(f => f.sha === item.sha);
                      renderHistoryItem(type, item, hList, false, isFav);
                  });
              } else { 
                  hList.innerHTML = '<div class="text-red-400 text-xs">获取失败</div>'; 
              }

          } catch(e) { 
              hList.innerHTML = '<div class="text-red-400 text-xs">网络错误</div>'; 
          }
      }

      // 渲染单条历史记录 (支持收藏按钮)
      function renderHistoryItem(type, item, container, isFavSection, isFavInHist = false) {
          const shortSha = item.sha.substring(0, 7);
          const date = new Date(item.date).toLocaleString();
          const isCurrent = deployConfigs[type] && deployConfigs[type].currentSha === item.sha;
          
          const el = document.createElement('div');
          el.className = \`group relative p-2 rounded border transition mb-1 flex gap-2 \${isCurrent ? 'bg-orange-50 border-orange-300' : 'bg-white border-gray-100 hover:border-blue-200'}\`;
          
          // 收藏按钮
          const starBtn = document.createElement('button');
          starBtn.className = \`text-sm focus:outline-none \${(isFavSection || isFavInHist) ? 'text-orange-400 hover:text-orange-600' : 'text-gray-300 hover:text-orange-400'}\`;
          starBtn.innerHTML = (isFavSection || isFavInHist) ? '★' : '☆';
          starBtn.title = isFavSection ? "取消收藏" : "加入收藏";
          starBtn.onclick = (e) => {
              e.stopPropagation();
              toggleFavorite(type, item, isFavSection || isFavInHist);
          };

          // 内容区域
          const content = document.createElement('div');
          content.className = "flex-1 cursor-pointer overflow-hidden";
          content.innerHTML = \`
              <div class="flex justify-between items-center mb-0.5">
                  <span class="font-mono text-[10px] bg-slate-100 px-1 rounded text-slate-600">\${shortSha}</span>
                  <span class="text-[9px] text-gray-400">\${date}</span>
              </div>
              <div class="text-[10px] text-gray-700 truncate" title="\${item.message}">\${item.message}</div>
              \${isCurrent ? '<div class="text-[9px] text-orange-600 font-bold mt-0.5">◀ 当前版本</div>' : ''}
          \`;
          content.onclick = () => {
              if(confirm(\`确认回滚/锁定到版本 [\${shortSha}]？\\n(这将暂停该项目的自动代码更新)\`)) {
                  document.getElementById('history_modal').classList.add('hidden');
                  deploy(type, item.sha);
              }
          };

          el.appendChild(starBtn);
          el.appendChild(content);
          container.appendChild(el);
      }

      // 切换收藏状态
      async function toggleFavorite(type, item, isRemove) {
          try {
              await fetch('/api/favorites', {
                  method: 'POST',
                  body: JSON.stringify({ 
                      action: isRemove ? 'remove' : 'add', 
                      item: item, 
                      type: type 
                  })
              });
              // 刷新列表以显示最新状态
              openVersionHistory(type); 
          } catch(e) { 
              alert('操作失败'); 
          }
      }

      // ================= 核心部署与配置逻辑 =================

      // 获取部署状态 (检查是否锁定)
      async function checkDeployConfig(t) { 
          try {
              const r = await fetch(\`/api/deploy_config?type=\${t}\`);
              const c = await r.json();
              deployConfigs[t] = c;
              
              const badge = document.getElementById(\`badge_\${t}\`);
              if (c.mode === 'fixed') {
                  badge.className = "text-[9px] px-1.5 py-0.5 rounded text-white bg-orange-500 font-bold";
                  badge.innerText = "🔒 Locked";
              } else {
                  badge.className = "text-[9px] px-1.5 py-0.5 rounded text-white bg-green-500";
                  badge.innerText = "Auto Update";
              }
          } catch(e) {} 
      }
      
      // 部署函数
      async function deploy(t, sha = '') {
         const btn = document.getElementById(\`btn_deploy_\${t}\`);
         const ot = btn.innerText;
         btn.innerText = "⏳ 部署中...";
         btn.disabled = true;
         
         // 收集当前变量
         const vars = [];
         document.querySelectorAll(\`.var-row-\${t}\`).forEach(r => {
             const k = r.querySelector('.key').value;
             const v = r.querySelector('.val').value;
             if(k) vars.push({key: k, value: v});
         });
         
         // 先保存变量
         await fetch(\`/api/settings?type=\${t}\`, {method: 'POST', body: JSON.stringify(vars)});
         
         const logBox = document.getElementById('logs');
         logBox.classList.remove('hidden');
         const modeText = sha ? (sha === 'latest' ? 'Latest' : 'Locked') : 'Default';
         logBox.innerHTML = \`<div class="text-yellow-400">⚡ Deploying \${t} (\${modeText})...</div>\`;
         
         try {
             const res = await fetch(\`/api/deploy?type=\${t}\`, {
                 method: 'POST',
                 body: JSON.stringify({
                     variables: vars,
                     deletedVariables: deletedVars[t],
                     targetSha: sha
                 })
             });
             const logs = await res.json();
             
             logBox.innerHTML += logs.map(l => 
                 \`<div>[\${l.success ? 'OK' : 'ERR'}] \${l.name}: <span class="text-gray-400">\${l.msg}</span></div>\`
             ).join('');
             
             deletedVars[t] = [];
             
             // 延时刷新状态
             setTimeout(() => {
                 checkUpdate(t);
                 checkDeployConfig(t);
             }, 1000);
         } catch(e) { 
             logBox.innerHTML += \`<div class="text-red-500">Error: \${e.message}</div>\`; 
         }
         
         btn.innerText = ot;
         btn.disabled = false;
      }

      // ================= UI 渲染逻辑 =================

      // 渲染 Proxy 选择器 (ECH专用)
      function renderProxySelector() {
          const c = document.getElementById('ech_proxy_selector_container');
          let h = '<select id="ech_proxy_select" onchange="applyEchProxy()" class="w-full text-xs border rounded p-1 mb-1"><option value="">-- Select ProxyIP --</option>';
          ECH_PROXIES.forEach(g => {
              h += \`<optgroup label="\${g.group}">\`;
              g.list.forEach(i => {
                  h += \`<option value="\${i.split(' ')[0]}">\${i}</option>\`;
              });
              h += '</optgroup>';
          });
          c.innerHTML = h + '</select>';
      }
      
      function applyEchProxy() {
          const v = document.getElementById('ech_proxy_select').value;
          if (v) addVarRow('ech', 'PROXYIP', v);
      }

      // 添加变量行
      function addVarRow(t, k = '', v = '') {
          const c = document.getElementById(\`vars_\${t}\`);
          const d = document.createElement('div');
          d.className = \`flex gap-1 items-center mb-1 var-row-\${t}\`;
          
          let h = '';
          // 下拉辅助逻辑
          if (t === 'cmliu' && (k === 'PROXYIP' || k === 'DOH')) {
              const options = k === 'DOH' ? DOH_PRESETS : ECH_PROXIES.flatMap(g => g.list);
              h = \`<select onchange="this.previousElementSibling.value=this.value" class="w-4 border rounded text-[8px] bg-gray-50 cursor-pointer">
                  <option>▼</option>
                  \${options.map(u => \`<option value="\${u.split(' ')[0]}">\${u}</option>\`).join('')}
              </select>\`;
          }
          
          d.innerHTML = \`
              <input class="input-field w-1/3 key font-bold" placeholder="Key" value="\${k}">
              <input class="input-field w-2/3 val" placeholder="Val" value="\${v}">
              \${h}
              <button onclick="removeVarRow(this,'\${t}')" class="text-gray-300 hover:text-red-500 px-1 font-bold">×</button>
          \`;
          c.appendChild(d);
      }

      function removeVarRow(b, t) {
          const k = b.parentElement.querySelector('.key').value;
          if (k) deletedVars[t].push(k);
          b.parentElement.remove();
      }

      // 加载变量
      async function loadVars(t) {
          const c = document.getElementById(\`vars_\${t}\`);
          c.innerHTML = '<div class="text-center text-gray-300">...</div>';
          try {
              const r = await fetch(\`/api/settings?type=\${t}\`);
              const v = await r.json();
              const m = new Map();
              
              if (Array.isArray(v)) v.forEach(x => m.set(x.key, x.value));
              
              // 补全默认 Key
              TEMPLATES[t].defaultVars.forEach(k => {
                  if (!m.has(k)) m.set(k, k === TEMPLATES[t].uuidField ? crypto.randomUUID() : '');
              });
              
              c.innerHTML = '';
              deletedVars[t] = [];
              m.forEach((val, key) => addVarRow(t, key, val));
          } catch(e) {
              c.innerHTML = 'Load Error';
          }
      }

      // 加载全局配置
      async function loadGlobalConfig() {
          try {
              const r = await fetch('/api/auto_config');
              const c = await r.json();
              document.getElementById('auto_update_toggle').checked = !!c.enabled;
              document.getElementById('auto_update_interval').value = c.interval || 30;
              document.getElementById('fuse_threshold').value = c.fuseThreshold || 0;
              // 加载历史数量 Limit
              if (c.historyLimit) document.getElementById('history_limit').value = c.historyLimit;
          } catch(e) {}
      }

      // 保存全局配置
      async function saveAutoConfig() {
          const limit = document.getElementById('history_limit').value;
          await fetch('/api/auto_config', {
              method: 'POST',
              body: JSON.stringify({
                  enabled: document.getElementById('auto_update_toggle').checked,
                  interval: document.getElementById('auto_update_interval').value,
                  fuseThreshold: document.getElementById('fuse_threshold').value,
                  historyLimit: limit
              })
          });
          alert('已保存配置');
      }
      
      // ================= 账号管理逻辑 =================
      
      async function loadAccounts() {
          try {
              const r = await fetch('/api/accounts');
              accounts = await r.json();
              // 初始化 stats 对象避免报错
              accounts.forEach(a => a.stats = a.stats || { total: 0, max: 100000 });
              renderTable();
          } catch(e) {}
      }

      function renderTable() {
          const tb = document.getElementById('account_body');
          if (accounts.length === 0) {
              tb.innerHTML = '<tr><td colspan="5" class="text-center text-gray-300 py-4">无数据</td></tr>';
              return;
          }
          
          tb.innerHTML = accounts.map((a, i) => {
              const count = (a.workers_cmliu||[]).length + (a.workers_joey||[]).length + (a.workers_ech||[]).length;
              const percent = ((a.stats.total / a.stats.max) * 100).toFixed(1);
              let barColor = 'bg-green-500';
              if (percent > 80) barColor = 'bg-orange-500';
              if (percent >= 100) barColor = 'bg-red-600';

              return \`
              <tr class="hover:bg-gray-50 border-b">
                  <td class="font-medium">\${a.alias}</td>
                  <td><span class="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">\${count} 个</span></td>
                  <td>\${a.stats.total}</td>
                  <td>
                      <div class="flex items-center gap-2">
                          <div class="w-12 bg-gray-200 rounded-full h-1.5 overflow-hidden">
                              <div class="\${barColor} h-1.5" style="width: \${Math.min(percent, 100)}%"></div>
                          </div>
                          <span class="text-[10px]">\${percent}%</span>
                      </div>
                  </td>
                  <td class="text-right">
                      <button onclick="editAccount(\${i})" class="text-blue-500 mr-2 text-xs">✎</button>
                      <button onclick="delAccount(\${i})" class="text-red-500 text-xs">×</button>
                  </td>
              </tr>\`;
          }).join('');
      }

      async function loadStats() {
          const b = document.getElementById('btn_stats');
          b.disabled = true;
          try {
              const r = await fetch('/api/stats');
              const d = await r.json();
              accounts.forEach(a => {
                  const s = d.find(x => x.alias === a.alias);
                  a.stats = s && !s.error ? s : { total: 0, max: 100000 };
              });
              renderTable();
          } catch(e) {}
          b.disabled = false;
      }

      function editAccount(i) {
          editingIndex = i;
          const a = accounts[i];
          document.getElementById('in_alias').value = a.alias;
          document.getElementById('in_id').value = a.accountId;
          document.getElementById('in_token').value = a.apiToken;
          
          ['cmliu', 'joey', 'ech'].forEach(t => {
              document.getElementById('in_workers_' + t).value = (a['workers_' + t] || []).join(',');
          });
          
          document.getElementById('account_form').classList.remove('hidden');
      }

      function resetFormForAdd() {
          editingIndex = -1;
          document.querySelectorAll('#account_form input').forEach(i => i.value = '');
          document.getElementById('account_form').classList.remove('hidden');
      }

      async function saveAccount() {
          const o = {
              alias: document.getElementById('in_alias').value,
              accountId: document.getElementById('in_id').value,
              apiToken: document.getElementById('in_token').value
          };
          ['cmliu', 'joey', 'ech'].forEach(t => {
              o['workers_' + t] = document.getElementById('in_workers_' + t).value.split(/,|，/).map(s => s.trim()).filter(s => s);
          });
          
          // 保留原有 Stats
          if (editingIndex >= 0 && accounts[editingIndex]) {
              o.stats = accounts[editingIndex].stats;
          } else {
              o.stats = { total: 0, max: 100000 };
          }
          
          if (editingIndex >= 0) accounts[editingIndex] = o;
          else accounts.push(o);
          
          await fetch('/api/accounts', {method: 'POST', body: JSON.stringify(accounts)});
          renderTable();
          document.getElementById('account_form').classList.add('hidden');
      }

      async function delAccount(i) {
          if (confirm('确认删除此账号?')) {
              accounts.splice(i, 1);
              await fetch('/api/accounts', {method: 'POST', body: JSON.stringify(accounts)});
              renderTable();
          }
      }

      function cancelEdit() {
          document.getElementById('account_form').classList.add('hidden');
      }

      async function deleteFromEdit() {
          if (editingIndex >= 0) delAccount(editingIndex);
          cancelEdit();
      }

      // 同步功能
      function selectSyncAccount(t) {
          const m = document.getElementById('sync_select_modal');
          const l = document.getElementById('sync_list');
          const v = accounts.filter(a => a[\`workers_\${t}\`] && a[\`workers_\${t}\`].length);
          
          l.innerHTML = '';
          v.forEach(a => {
              const b = document.createElement('button');
              b.className = "w-full text-left bg-slate-50 p-2 mb-1 text-xs border rounded hover:bg-blue-50";
              b.innerHTML = \`<b>\${a.alias}</b> -> \${a[\`workers_\${t}\`][0]}\`;
              b.onclick = () => doSync(a, t, a[\`workers_\${t}\`][0]);
              l.appendChild(b);
          });
          m.classList.remove('hidden');
      }

      async function doSync(a, t, n) {
          document.getElementById('sync_select_modal').classList.add('hidden');
          if (!confirm('确认覆盖当前变量配置?')) return;
          
          const r = await fetch('/api/fetch_bindings', {
              method: 'POST',
              body: JSON.stringify({ accountId: a.accountId, apiToken: a.apiToken, workerName: n })
          });
          const d = await r.json();
          
          if (d.success) {
              const c = document.getElementById(\`vars_\${t}\`);
              c.innerHTML = '';
              deletedVars[t] = [];
              d.data.forEach(v => addVarRow(t, v.key, v.value));
          } else {
              alert(d.msg);
          }
      }

      async function checkUpdate(t) {
          const e = document.getElementById(\`ver_\${t}\`);
          try {
              const r = await fetch(\`/api/check_update?type=\${t}\`);
              const d = await r.json();
              
              if (d.remote && (!d.local || d.remote.sha !== d.local.sha)) {
                  e.innerHTML = \`<span class="text-red-500 font-bold animate-pulse">🔴 New: \${timeAgo(d.remote.date)}</span>\`;
              } else {
                  e.innerHTML = \`<span class="text-green-600">✅ Latest</span>\`;
              }
          } catch(e) { e.innerHTML = "Check Fail"; }
      }

      function timeAgo(s) {
          const sec = (new Date() - new Date(s)) / 1000;
          if (sec > 86400) return Math.floor(sec / 86400) + "天前";
          if (sec > 3600) return Math.floor(sec / 3600) + "小时前";
          return "刚刚";
      }

      function refreshUUID(t) {
          const k = TEMPLATES[t].uuidField;
          if (k) {
              document.querySelectorAll(\`.var-row-\${t}\`).forEach(r => {
                  if (r.querySelector('.key').value === k) {
                      const input = r.querySelector('.val');
                      input.value = crypto.randomUUID();
                      input.classList.add('bg-green-100');
                      setTimeout(() => input.classList.remove('bg-green-100'), 500);
                  }
              });
          }
      }

      function toggleLayout() {
          currentLayout = currentLayout === 'standard' ? 'vertical' : 'standard';
          localStorage.setItem('cw_layout', currentLayout);
          applyLayout();
      }

      function applyLayout() {
          const c = document.getElementById('layout_container');
          const sp = document.getElementById('section_projects');
          const sa = document.getElementById('section_accounts');
          
          if (currentLayout === 'vertical') {
              c.className = "flex flex-col gap-4";
              sp.className = "grid grid-cols-1 md:grid-cols-2 gap-4 order-first";
              sa.className = "w-full order-last";
          } else {
              c.className = "grid grid-cols-1 lg:grid-cols-12 gap-4";
              sa.className = "lg:col-span-7 space-y-4";
              sp.className = "lg:col-span-5 space-y-4";
          }
      }

      // 启动
      init();
    </script>
  </body></html>
    `;
  }
