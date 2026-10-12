(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const states = {
    starting: '正在启动', setup_required: '等待首次配置', configuring: '正在配置', migrating: '正在准备数据库', running: '运行中', ready: '已准备', disabled: '未启用', initializing: '正在接入', initialization_required: '等待接入', window_not_available: '等待桌面微信', paused: '已暂停', pausing: '正在暂停', resuming: '正在恢复', stopped: '已停止', stopping: '正在停止', degraded: '需要关注', failed: '启动失败', backing_up: '正在备份', unresponsive: '心跳未确认', stop_unconfirmed: '停止尚未确认', not_configured: '尚未配置', configured: '已配置', not_installed: '尚未安装', idle: '等待任务', success: '最近执行成功', error: '执行异常', settled_after_abort: '执行已收尾', lost: '运行租约已失效',
  };
  const names = { database: '本机数据库', web: '工作台', worker: '持续任务引擎', model: '模型连接', wechat: '微信组件', quant: '量化组件', embeddings: '语义检索' };
  const readerStates = { running: '已响应', initialized: '已接入，等待读取', init_required: '等待接入', initialization_required: '等待接入', disabled: '未授权', unresponsive: '心跳未确认' };
  const modules = { 'loop-admission': '检查持续任务', 'loop-execution': '执行持续任务', 'work-execution': '执行手动任务', 'heartbeat-admission': '检查车间唤醒', 'interaction-processing': '整理交互记录', 'interaction-ingestion': '读取授权资料', 'outbox-recovery': '检查待发送结果', 'collaboration-attention': '检查协作状态', 'paper-matching': '模拟盘撮合' };
  const errors = { model_configuration_required: '请先保存模型设置。', invalid_model_url: '请填写完整的模型接口地址。', model_url_requires_https: '外部服务需要 HTTPS 地址，本机服务可使用 HTTP。', invalid_model_name: '请填写正确的模型名称。', invalid_model_key: '请填写模型密钥，已有密钥可以留空保留。', stop_application_before_configuring: '请先停止后台，再修改模型配置。', operation_in_progress: '后台正在处理操作，请稍后再试。', application_not_running: '请先启动知遇。', control_token_required: '管理会话已失效，请从桌面图标重新打开知遇。', csrf_required: '管理会话已失效，请从桌面图标重新打开知遇。', manager_already_starting_or_unresponsive: '后台尚未响应，请稍后重试或查看托盘状态。', web_ready_timeout: '工作台启动未完成，可查看后台日志后重试。', worker_ready_not_confirmed: '持续任务引擎启动未确认，请检查错误后重试。', postgres_partial_initialization_requires_review: '数据库初始化未完成，请保留数据目录并联系维护者处理。', worker_heartbeat_missing_or_stale: '任务引擎心跳缺失，请保留错误记录并尝试停止后重启。' };
  Object.assign(errors, { invalid_component_selection: '组件设置无效，请重新选择。', release_component_not_installed: '当前程序文件未包含所选组件，请使用带组件的安装包。', wechat_read_consent_required: '请先勾选授权接入本人微信消息。', reader_permission_required: '读取端需要系统权限。确认你正在接入本人的微信后，可点击“用管理员权限接入微信”。', wechat_reader_permission_required: '读取端需要系统权限。可在下方选择“用管理员权限接入微信”。', quant_stop_unconfirmed: '量化内部进程停止尚未确认，请保留错误记录，暂勿恢复或覆盖数据。', wechat_sender_stop_unconfirmed: '微信发送组件停止尚未确认，请保留发送记录，暂勿重复发送或恢复数据。' });
  let csrf = '', busy = false, current = null, initialized = false, savedComponents = {};
  function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
  function explain(code) {
    const migrationErrors = { migration_database_bootstrap_failed: '本机数据库创建未完成，请保留错误记录后重试。', migration_extension_failed: '数据库向量组件未能载入，请保留错误记录并联系维护者。', migration_schema_failed: '数据库初始化或升级未完成，请保留数据目录与错误记录并联系维护者。', migration_owner_failed: '本机用户身份准备未完成，请保留错误记录后重试。' };
    if (migrationErrors[code]) return migrationErrors[code];
    if (errors[code]) return errors[code];
    if (/model_service_http_401|model_service_http_403/.test(code)) return '服务商拒绝了密钥，请核对密钥和服务商权限。';
    if (/model_service_http_404/.test(code)) return '模型列表接口不可用，请核对接口地址；有些服务商不支持读取模型列表。';
    if (/model_service_http_429/.test(code)) return '服务商限流或额度不足，请稍后重试。';
    if (/fetch failed|timeout|aborted|TimeoutError/.test(code)) return '连接超时或网络不可用，请核对网络与接口地址。';
    return '操作未完成。请保留下面的错误信息，修复后可重试。';
  }
  async function api(path, method = 'GET', body, explicitToken) {
    const headers = {};
    if (method !== 'GET') { headers['X-Zhiyu-CSRF'] = csrf; headers['Content-Type'] = 'application/json'; }
    if (explicitToken) headers['X-Zhiyu-Token'] = explicitToken;
    const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `http_${response.status}`);
    return value;
  }
  function settings() { return { baseUrl: $('base-url').value, model: $('model-name').value, apiKey: $('api-key').value }; }
  function componentSettings() { return { quantEnabled: $('quant-enabled').checked, wechatEnabled: $('wechat-enabled').checked, wechatReadConsent: $('wechat-read-consent').checked, wechatSendEnabled: $('wechat-send-enabled').checked }; }
  function time(value) { if (!value) return '暂无'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '暂无' : date.toLocaleString('zh-CN', { hour12: false }); }
  function render(state) {
    current = state; $('overall').textContent = states[state.status] || '需要关注'; $('overall').classList.toggle('error', ['failed', 'degraded', 'stop_unconfirmed'].includes(state.status));
    $('components').replaceChildren();
    for (const [name, component] of Object.entries(state.components || {})) {
      const item = document.createElement('li'), label = document.createElement('span'), phase = document.createElement('span');
      label.textContent = names[name] || name; phase.textContent = states[component.phase] || '状态待确认'; phase.className = 'phase';
      if (['not_installed', 'not_configured', 'configured', 'degraded'].includes(component.phase)) phase.classList.add('warning');
      if (['failed', 'unresponsive', 'stop_unconfirmed', 'lost'].includes(component.phase)) phase.classList.add('error');
      item.append(label, phase);
      const detail = document.createElement('small');
      detail.textContent = component.error ? `${explain(component.error)} ${component.error}` : [component.detail || (name === 'model' && component.model ? component.model : ''), name === 'wechat' && component.readerPhase ? `消息读取：${readerStates[component.readerPhase] || '状态待确认'}。` : '', component.lastHeartbeat ? `最近心跳：${time(component.lastHeartbeat)}` : ''].filter(Boolean).join(' ');
      if (detail.textContent) item.append(detail); $('components').append(item);
    }
    $('module-list').replaceChildren();
    for (const module of state.components?.worker?.modules || []) {
      const item = document.createElement('div'); item.className = 'module';
      item.textContent = `${modules[module.name] || module.name} · ${states[module.phase] || '状态待确认'}${module.inFlight ? '（正在执行）' : ''}\n最近运行：${time(module.lastRunAt)}；下次检查：${time(module.nextRunAt)}${module.lastError ? `\n原因：${module.lastError}` : ''}`;
      item.style.whiteSpace = 'pre-wrap'; $('module-list').append(item);
    }
    const running = ['running', 'paused', 'degraded', 'pausing', 'resuming'].includes(state.status);
    const changing = ['starting', 'migrating', 'stopping', 'backing_up'].includes(state.status);
    const controlsBusy = busy || changing;
    $('start').disabled = controlsBusy || running || state.components?.model?.phase === 'not_configured';
    $('pause').disabled = controlsBusy || !['running', 'degraded'].includes(state.status);
    $('resume').disabled = controlsBusy || state.status !== 'paused'; $('stop').disabled = controlsBusy || !(running || state.status === 'failed');
    $('backup').disabled = controlsBusy;
    for (const id of ['base-url', 'model-name', 'api-key', 'provider', 'test', 'save']) $(id).disabled = controlsBusy || running;
    $('quant-enabled').disabled = controlsBusy || running || !state.components?.quant?.installed;
    $('wechat-enabled').disabled = controlsBusy || running || !state.components?.wechat?.installed;
    for (const id of ['wechat-read-consent', 'wechat-send-enabled']) $(id).disabled = controlsBusy || running || !$('wechat-enabled').checked;
    $('components-save').disabled = controlsBusy || running;
    for (const id of ['wechat-init', 'wechat-init-elevated']) $(id).disabled = controlsBusy || running || !$('wechat-enabled').checked || !$('wechat-read-consent').checked;
    const permissionRequired = /^(?:wechat_)?reader_permission_required$/.test(state.components?.wechat?.error || '');
    $('wechat-init-elevated').hidden = !permissionRequired;
    $('config-tip').textContent = running ? '修改模型设置前，请先点击“停止后台”。' : '先保存设置，再启动工作台。';
    const available = ['running', 'degraded'].includes(state.components?.web?.phase) && state.webUrl && /^http:\/\/127\.0\.0\.1:\d+$/.test(state.webUrl);
    $('workbench').setAttribute('aria-disabled', available ? 'false' : 'true');
    if (available) $('workbench').href = state.webUrl; else $('workbench').removeAttribute('href');
    $('error-code').textContent = state.error ? `错误记录：${state.error}${state.errorDetail?.stage ? `；阶段：${state.errorDetail.stage}` : ''}${state.errorDetail?.driverCode ? `；SQLSTATE：${state.errorDetail.driverCode}` : ''}` : '';
  }
  async function refresh() {
    try {
      const state = await api('/api/status'); render(state);
      if (!initialized) { notice(state.status === 'setup_required' ? '首次使用：填入模型接口、模型名称和密钥，保存后启动知遇。' : '本机后台已连接。你可以查看状态或进入工作台。'); initialized = true; }
    } catch (error) { notice(explain(error.message), true); $('overall').textContent = '后台暂未响应'; }
  }
  async function action(label, task) {
    if (busy) return; busy = true; if (current) render(current); notice(label);
    try { const message = await task(); notice(message || '操作已完成。'); $('error-code').textContent = ''; }
    catch (error) { notice(explain(error.message), true); $('error-code').textContent = `错误记录：${error.message}`; }
    finally { busy = false; await refresh(); }
  }
  $('provider').addEventListener('change', () => {
    const defaults = { bailian: ['https://dashscope.aliyuncs.com/compatible-mode/v1', ''], deepseek: ['https://api.deepseek.com/v1', ''], openai: ['https://api.openai.com/v1', ''], local: ['http://127.0.0.1:11434/v1', ''] }[$('provider').value];
    if (defaults) { $('base-url').value = defaults[0]; $('model-name').value = defaults[1]; }
    $('api-key').value = ''; $('key-hint').textContent = '切换服务商后，请填写对应服务商的密钥；本机无密钥服务可填写 local。';
  });
  $('model-form').addEventListener('submit', event => { event.preventDefault(); void action('正在保存本机设置…', async () => { await api('/api/config', 'POST', settings()); $('api-key').value = ''; $('api-key').placeholder = '已保存，留空保留原密钥'; return '模型设置已保存。点击“启动知遇”准备数据库并打开工作台。'; }); });
  $('test').addEventListener('click', () => void action('正在读取服务商模型列表…', async () => (await api('/api/model-test', 'POST', settings())).detail));
  $('start').addEventListener('click', () => void action('正在启动知遇，首次准备数据库可能需要几分钟…', async () => { await api('/api/start', 'POST'); return '启动已完成，点击“进入工作台”开始使用。'; }));
  $('pause').addEventListener('click', () => void action('正在暂停新任务，等待运行心跳确认…', async () => { await api('/api/pause', 'POST'); return '暂停请求已记录，正在执行的任务仍可能完成。'; }));
  $('resume').addEventListener('click', () => void action('正在恢复持续任务…', async () => { await api('/api/resume', 'POST'); return '恢复请求已记录，请查看任务引擎状态。'; }));
  $('stop').addEventListener('click', () => void action('正在等待任务收尾并停止后台…', async () => { await api('/api/stop', 'POST'); return '后台已停止，数据已保留。'; }));
  $('backup').addEventListener('click', () => void action('正在停止后台并备份本机数据，请等待完成…', async () => { const result = await api('/api/backup', 'POST'); return `备份完成，保存在：\n${result.path}\n备份包含个人资料和模型密钥，请妥善保管。`; }));
  async function saveComponents() { const result = await api('/api/components', 'POST', componentSettings()); savedComponents = result.components; return result; }
  $('components-save').addEventListener('click', () => void action('正在保存组件设置…', async () => { await saveComponents(); return '组件设置已保存。量化会在启动时准备；微信消息读取需另外接入。'; }));
  for (const id of ['wechat-enabled', 'wechat-read-consent']) $(id).addEventListener('change', () => { if (!$('wechat-enabled').checked) { $('wechat-read-consent').checked = false; $('wechat-send-enabled').checked = false; } if (current) render(current); });
  async function connectWechat(elevate) { if (!$('wechat-read-consent').checked) throw new Error('wechat_read_consent_required'); await saveComponents(); const result = await api('/api/wechat-init', 'POST', { elevate }); return result.warning || '微信读取已接入。请在工作台选择要接入的资料来源，发送仍保留审核确认。'; }
  $('wechat-init').addEventListener('click', () => void action('正在接入本人微信，请保持微信登录并等待结果…', () => connectWechat(false)));
  $('wechat-init-elevated').addEventListener('click', () => void action('正在请求系统权限，请在 Windows 权限窗口确认本人微信接入…', () => connectWechat(true)));
  async function initialize() {
    try {
      const token = new URLSearchParams(location.hash.slice(1)).get('token');
      history.replaceState(null, '', location.pathname);
      const session = token ? await api('/api/session', 'POST', {}, token) : await api('/api/session'); csrf = session.csrfToken;
      const config = await api('/api/config'); $('base-url').value = config.baseUrl; $('model-name').value = config.model;
      savedComponents = config.components || {};
      $('quant-enabled').checked = savedComponents.quantEnabled === true; $('wechat-enabled').checked = savedComponents.wechatEnabled === true;
      $('wechat-read-consent').checked = savedComponents.wechatReadConsent === true; $('wechat-send-enabled').checked = savedComponents.wechatSendEnabled === true;
      if (config.hasApiKey) { $('api-key').placeholder = '已保存，留空保留原密钥'; $('key-hint').textContent = '密钥已保存在本机，页面不会回显。'; }
      await refresh(); setInterval(() => void refresh(), 3000);
    } catch (error) { notice(explain(error.message), true); $('overall').textContent = '需要重新打开知遇'; for (const button of document.querySelectorAll('button')) button.disabled = true; }
  }
  void initialize();
})();
