const main = document.querySelector('#main');
const navigation = document.querySelector('#navigation');
const toast = document.querySelector('#toast');
const sampleId = 'sample-potato-shrimp';
const paths = {
  book: '<path d="M4 19V5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1 0-4h13M8 7h7m-7 4h7"/>',
  inbox: '<path d="M4 4h16l2 10v6H2v-6L4 4Zm-2 10h6l2 3h4l2-3h6"/>',
  pot: '<path d="M4 12h16v3a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6v-3ZM2 12h20M8 8c-2-2 2-3 0-5m4 5c-2-2 2-3 0-5m4 5c-2-2 2-3 0-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M8 5v14l11-7L8 5Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  edit: '<path d="m5 16-1 4 4-1 11-11-3-3L5 16Zm9-9 3 3"/>',
  link: '<path d="M13 5h6v6m0-6-8 8m5 0v6H5V8h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m4 12 5 5L20 6"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const stamp = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const timeLabel = seconds => seconds < 60 ? `${seconds} 秒` :
  `${Math.floor(seconds / 60)} 分钟${seconds % 60 ? ` ${seconds % 60} 秒` : ''}`;
const sourceLink = (url, label = '查看抖音原片') => url
  ? `<a class="button subtle" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${icon('link')}${label}</a>` : '';
const sampleImage = new URL('./potato-shrimp.jpg', import.meta.url).href;
const libraryUrl = document.querySelector('meta[name="recipe-library"]')?.content || '/api/library';
const cloudUrl = document.querySelector('meta[name="recipe-cloud"]')?.content;
let cloudToken = '';
let cloudJobId = '';
let cloudTimer;
try {
  cloudToken = sessionStorage.getItem('zaotai-cloud-token') || '';
  cloudJobId = localStorage.getItem('zaotai-cloud-job') || '';
} catch {}
const statuses = {
  queued: ['已收藏', 'wait'], processing: ['正在整理', 'wait'],
  'needs-video': ['整理未完成', 'attention'], review: ['等待重新整理', 'wait'], saved: ['已存菜谱', '']
};
let library = { recipes: [], inbox: [] };
let toastTimeout;
let routeSequence = 0;
let refreshing = false;
let refreshSequence = 0;
let lastAppliedRefresh = 0;
const timers = new Map();
try {
  for (const [key, deadline] of JSON.parse(localStorage.getItem('zaotai-timers') || '[]')) timers.set(key, deadline);
} catch {}

function notify(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, 3600);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败，请重试。');
  return data;
}

const json = (method, body) => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const getRoute = () => location.hash.slice(1).split('/');
const findRecipe = id => library.recipes.find(recipe => recipe.id === id);
const findItem = id => library.inbox.find(item => item.id === id);
const navigate = hash => {
  if (location.hash === hash) render();
  else location.hash = hash;
};

function nav(active) {
  navigation.innerHTML = [['recipes', 'book', '我的菜谱'], ['inbox', 'inbox', '收件箱'], ['cook', 'pot', '跟做'], ['add', 'plus', '添加菜谱']]
    .filter(([key]) => key === 'add' ? Boolean(cloudUrl) : !library.readOnly || key !== 'inbox')
    .map(([key, mark, label]) => `<a href="#${key}" class="nav-link"${active === key ? ' aria-current="page"' : ''}>${icon(mark)}${label}</a>`).join('');
}

function cloudForm() {
  main.innerHTML = `<header class="page-header"><h1>添加菜谱</h1><p>粘贴抖音链接，或从相册选择视频。</p></header>
    <form id="cloud-form" class="box fields">
      <label class="field">上传口令<input name="token" type="password" autocomplete="current-password" required value="${esc(cloudToken)}"></label>
      <label class="field">抖音分享链接<textarea name="share" maxlength="12000" placeholder="在抖音点分享，再复制链接"></textarea></label>
      <label class="field">视频文件<input name="video" type="file" accept="video/*"></label>
      <button type="submit" class="button primary">提交并整理</button>
      <p id="cloud-status" role="status" aria-live="polite"></p>
      <a id="cloud-result" class="button subtle" hidden>打开新菜谱</a>
    </form>`;
  if (cloudJobId && cloudToken) void pollCloud();
}

async function cloudApi(path, options = {}) {
  return api(new URL(path, cloudUrl), { ...options,
    headers: { ...options.headers, Authorization: 'Bearer ' + cloudToken } });
}

async function submitCloud(formData) {
  const video = formData.get('video');
  const share = formData.get('share').trim();
  if (video.size > 100 * 1024 * 1024) throw new Error('请选择 100 MB 以内的视频。');
  if (!video.size && !share) throw new Error('请填写链接或选择视频。');
  cloudToken = formData.get('token').trim();
  const output = main.querySelector('#cloud-status');
  output.textContent = video.size ? '正在准备上传…' : '正在提交链接…';
  const job = await cloudApi('/v1/jobs', json('POST', { share, size: video.size }));
  if (job.upload) {
    output.textContent = '正在上传视频，请保持页面打开。';
    const upload = new FormData();
    for (const [key, value] of Object.entries(job.upload.fields)) upload.append(key, value);
    upload.append('file', video);
    const reply = await fetch(job.upload.url, { method: 'POST', body: upload });
    if (!reply.ok) throw new Error('视频上传失败，请重试。');
  }
  await cloudApi(`/v1/jobs/${job.id}/submit`, { method: 'POST' });
  cloudJobId = job.id;
  try {
    sessionStorage.setItem('zaotai-cloud-token', cloudToken);
    localStorage.setItem('zaotai-cloud-job', cloudJobId);
  } catch {}
  output.textContent = '已提交，可以关闭页面。';
  void pollCloud();
}

async function pollCloud() {
  clearTimeout(cloudTimer);
  const output = main.querySelector('#cloud-status');
  const id = cloudJobId;
  if (!output || !id) return;
  try {
    const job = await cloudApi(`/v1/jobs/${id}`);
    if (id !== cloudJobId || !output.isConnected) return;
    if (job.status === 'failed') { output.textContent = job.message; return; }
    if (job.status === 'published') {
      await refresh();
      if (id !== cloudJobId || !output.isConnected) return;
      if (findRecipe(job.id)) {
        output.textContent = `已发布《${job.title}》`;
        const result = main.querySelector('#cloud-result');
        result.href = `#recipe/${job.id}`;
        result.hidden = false;
        return;
      }
      output.textContent = '整理完成，正在更新菜谱网站。';
    } else if (job.status === 'publishing') {
      output.textContent = job.message || '菜谱已保存，正在等待网页发布。';
    } else {
      output.textContent = job.status === 'processing' ? '正在整理视频，可以关闭页面。' : '已排队，可以关闭页面。';
    }
  } catch (error) {
    if (output.isConnected) output.textContent = error.message;
    return;
  }
  cloudTimer = setTimeout(pollCloud, 10000);
}

function card(recipe, destination = 'recipe') {
  const cover = recipe.coverUrl || (recipe.id === sampleId ? sampleImage : '');
  const art = cover ? `<img src="${esc(cover)}" alt="${esc(recipe.title)}" loading="lazy" decoding="async">` : icon('pot');
  const ingredients = recipe.ingredients.slice(0, 4).map(item => esc(item.name)).join(' · ');
  return `<a class="card" href="#${destination}/${recipe.id}"><span class="card-art">${art}</span><span>
    <h3>${esc(recipe.title)}</h3>
    <p>${ingredients || '打开查看做菜步骤'}</p>
    <small>${recipe.steps.length} 个步骤${recipe.id === sampleId ? ' · 原片已核对' : ''}</small>
    </span><span class="arrow">${icon('next')}</span></a>`;
}

function recipes() {
  const featured = findRecipe(sampleId);
  main.innerHTML = `<section class="hero">
    <div class="hero-copy"><div class="kicker">从视频到餐桌</div><h1>刷到好菜，<br>下次就做。</h1>
      <p>把想做的菜存起来。备料、火候和计时，站在灶台前一步一步看。</p>
      <div class="hero-actions">
        ${library.readOnly ? '' : `<a href="#inbox" class="button warm">${icon('plus')} 收藏视频</a>`}
        ${featured ? `<a href="#cook/${featured.id}" class="button ghost">${icon('play')} 跟做样例</a>` : ''}
      </div>
    </div>
    <figure class="hero-figure"><img src="${sampleImage}" alt="炸至金黄色的土豆丝虾球"><figcaption>土豆丝虾球 · 原片画面</figcaption></figure>
  </section>
  <section aria-labelledby="recipes-title">
    <div class="section-title"><div><div class="kicker">我的厨房</div><h2 id="recipes-title">我的菜谱</h2><p id="recipe-count">${library.recipes.length} 道菜</p></div>
      <label class="search">${icon('search')}<input id="search" type="search" aria-label="搜索菜名或食材" placeholder="搜菜名或食材，例如虾滑"></label></div>
    <div id="recipe-list" class="grid"></div>
    ${library.readOnly ? '' : `<div class="form-actions"><a href="#edit/new" class="button link">${icon('plus')} 手动写菜谱</a></div>`}
  </section>`;
  main.querySelector('#search').addEventListener('input', refreshRecipeList);
  refreshRecipeList();
}

function refreshRecipeList() {
  const input = main.querySelector('#search');
  if (!input) return;
  const query = input.value.trim().toLocaleLowerCase();
  const results = library.recipes.filter(recipe =>
    [recipe.title, ...recipe.ingredients.map(item => item.name)].some(value => value.toLocaleLowerCase().includes(query))
  );
  main.querySelector('#recipe-count').textContent = `${library.recipes.length} 道菜`;
  main.querySelector('#recipe-list').innerHTML = results.length
    ? results.map(recipe => card(recipe)).join('')
    : '<div class="empty">没有找到匹配的菜谱。</div>';
}

function inboxItems() {
  const list = main.querySelector('#inbox-list');
  if (!list) return;
  list.innerHTML = library.inbox.length ? library.inbox.map(item => {
    const [label, color] = statuses[item.status];
    const actions = [];
    if (item.status === 'needs-video') {
      actions.push(`<label class="button subtle file-label">${icon('plus')} 补传视频<input type="file" data-upload="${item.id}" accept="video/mp4,video/quicktime,.mp4,.mov" class="visually-hidden"></label>`);
      actions.push(`<button class="button subtle" type="button" data-retry="${item.id}">重试</button>`);
      actions.push(`<a href="#edit/inbox/${item.id}" class="button link">手动整理</a>`);
    }
    if (item.status === 'saved') actions.push(`<a href="#recipe/${item.recipeId}" class="button primary">看菜谱 ${icon('next')}</a>`);
    return `<article class="box inbox-item"><header><h3>${esc(item.title)}</h3><span class="badge ${color}">${label}</span></header>
      <p>${item.author ? `${esc(item.author)} · ` : ''}${new Date(item.createdAt).toLocaleDateString('zh-CN')}</p>
      ${item.message ? `<p>${esc(item.message)}</p>` : ''}
      <footer>${actions.join('')}${sourceLink(item.sourceUrl, '原视频')}</footer></article>`;
  }).join('') : '<div class="empty">这里还没有收藏。粘贴一条抖音分享文案试试。</div>';
}

function inbox() {
  main.innerHTML = `<header class="page-header"><div><div class="kicker">抖音收藏</div><h1>收件箱</h1><p>粘贴链接就能收藏，整理完成后会自动加入我的菜谱。</p></div></header>
    <form id="share-form" class="box inbox-form">
      <label class="field">抖音分享文案<textarea name="share" required maxlength="12000" placeholder="粘贴从抖音复制的整段文案，或一条视频链接。"></textarea></label>
      <div class="form-actions"><button class="button primary" type="submit">${icon('plus')} 收藏并自动整理</button></div>
    </form>
    <div class="inbox-grid" id="inbox-list" aria-label="收藏列表"></div>`;
  inboxItems();
}

function detail(recipe) {
  const cover = recipe.coverUrl || (recipe.id === sampleId ? sampleImage : '');
  main.innerHTML = `<article class="detail"><a href="#recipes" class="back">${icon('back')} 返回菜谱</a>
    <header class="page-header"><div><div class="kicker">${recipe.id === sampleId ? '原片已核对' : '私人菜谱'}</div>
      <h1>${esc(recipe.title)}</h1>${recipe.summary ? `<p>${esc(recipe.summary)}</p>` : ''}</div></header>
    <div class="form-actions detail-cta">
      <a href="#cook/${recipe.id}" class="button primary">${icon('play')} 开始跟做</a>
      ${library.readOnly ? '' : `<a href="#edit/recipe/${recipe.id}" class="button subtle">${icon('edit')} 编辑</a>`}
      ${sourceLink(recipe.sourceUrl)}
    </div>
    ${cover ? `<figure class="recipe-photo"><img src="${esc(cover)}" alt="${esc(recipe.title)}成品" decoding="async"><figcaption>原视频画面</figcaption></figure>` : ''}
    <section class="box"><h2>食材和用量</h2>${recipe.ingredients.length ? `<ul class="ingredients">${recipe.ingredients.map(item =>
      `<li><span>${esc(item.name)}</span><span>${esc(item.amount || '用量未确认')}</span></li>`).join('')}</ul>` : '<p class="description">可以在编辑页补充食材。</p>'}</section>
    <section class="box"><h2>做菜步骤</h2><ol class="detail-steps">${recipe.steps.map((step, index) =>
      `<li><span class="step-number">${index + 1}</span><div>${esc(step.text)}
      ${step.timestamp != null ? `<small>原片约 ${stamp(step.timestamp)}</small>` : ''}</div></li>`).join('')}</ol></section>
    ${recipe.notes ? `<section class="box"><h2>笔记</h2><p class="description">${esc(recipe.notes)}</p></section>` : ''}
    ${recipe.author ? `<p class="form-note">视频作者 · ${esc(recipe.author)}</p>` : ''}
  </article>`;
}

function ingredientRow(item = {}) {
  return `<div class="entry" data-kind="ingredient">
    <input data-field="name" aria-label="食材名" placeholder="食材名" maxlength="100" value="${esc(item.name)}">
    <input data-field="amount" aria-label="用量" placeholder="用量" maxlength="100" value="${esc(item.amount)}">
    <button type="button" data-remove class="button subtle" aria-label="移除此食材">${icon('close')}</button></div>`;
}
function stepRow(item = {}) {
  return `<div class="entry steps" data-kind="step">
    <textarea data-field="text" aria-label="步骤说明" placeholder="写下做法、火候或熟度" maxlength="2000">${esc(item.text)}</textarea>
    <span class="step-fields"><input data-field="seconds" type="number" min="1" max="86400" inputmode="numeric" aria-label="计时秒数" placeholder="秒数" value="${item.seconds ?? ''}">
    ${item.timestamp != null ? `<small>原片 ${stamp(item.timestamp)}</small>` : ''}
    <input data-field="timestamp" type="hidden" value="${item.timestamp ?? ''}"></span>
    <button type="button" data-remove class="button subtle" aria-label="移除此步骤">${icon('close')}</button></div>`;
}
function edit(mode, id) {
  const item = mode === 'inbox' ? findItem(id) : null;
  const recipe = mode === 'recipe' ? findRecipe(id) : null;
  if ((mode === 'recipe' && !recipe) || (mode === 'inbox' && !item)) return missing();
  const value = recipe || item?.draft || { title: item?.title === '抖音视频' ? '' : item?.title };
  const back = recipe ? `#recipe/${id}` : item ? '#inbox' : '#recipes';
  main.innerHTML = `<article class="edit"><a class="back" href="${back}">${icon('back')} 返回</a>
    <header class="page-header"><div><div class="kicker">我的厨房</div><h1>${recipe ? '编辑菜谱' : item ? '手动补充菜谱' : '写菜谱'}</h1></div>${sourceLink(item?.sourceUrl || recipe?.sourceUrl)}</header>
    <form id="recipe-form" data-mode="${mode}" data-id="${id || ''}">
      <section class="box fields">
        <label class="field">菜名<input name="title" required maxlength="100" value="${esc(value.title)}"></label>
        <label class="field">一句简介<input name="summary" maxlength="500" value="${esc(value.summary)}"></label>
      </section>
      <section class="box"><h2>食材</h2><div id="edit-ingredients" class="entries">${(value.ingredients?.length ? value.ingredients : [{}]).map(ingredientRow).join('')}</div>
        <div class="form-actions"><button type="button" class="button subtle" data-add="ingredient">${icon('plus')} 加食材</button></div></section>
      <section class="box"><h2>步骤</h2><div id="edit-steps" class="entries">${(value.steps?.length ? value.steps : [{}]).map(stepRow).join('')}</div>
        <p class="form-note">有明确时长的步骤可填写秒数，跟做时可以一键计时。</p>
        <div class="form-actions"><button type="button" class="button subtle" data-add="step">${icon('plus')} 加步骤</button></div></section>
      <section class="box"><label class="field">笔记<textarea name="notes" maxlength="2000">${esc(value.notes)}</textarea></label></section>
      <button class="button primary" type="submit">${icon('check')} 存入我的菜谱</button>
    </form></article>`;
}

function updateTimer() {
  const timer = main.querySelector('[data-timer]');
  if (!timer) return;
  const deadline = timers.get(timer.dataset.timer);
  const remaining = deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : Number(timer.dataset.seconds);
  timer.querySelector('strong').textContent = deadline && !remaining ? '时间到' : stamp(remaining);
  timer.querySelector('[data-start]').textContent = deadline && remaining ? '重新计时' : '开始计时';
  timer.querySelector('[data-reset]').hidden = !deadline;
}

function cook(id, stepIndex) {
  if (!id) {
    main.innerHTML = `<header class="page-header"><div><div class="kicker">一步一步来</div><h1>今天做什么？</h1>
      <p>选一道菜，跟着大字步骤做。</p></div></header><div id="cook-list" class="grid">${library.recipes.map(recipe => card(recipe, 'cook')).join('')}</div>`;
    return;
  }
  const recipe = findRecipe(id);
  if (!recipe) return missing();
  const count = recipe.steps.length;
  const index = Math.min(count - 1, Math.max(0, Number.parseInt(stepIndex, 10) || 0));
  const step = recipe.steps[index];
  main.innerHTML = `<article class="cook"><a href="#recipe/${id}" class="back">${icon('back')} 看食材和全部步骤</a>
    <header class="page-header"><div><div class="kicker">下厨跟做</div><h1>${esc(recipe.title)}</h1></div>
    <span class="badge">${index + 1} / ${count}</span></header>
    <progress class="cook-progress" value="${index + 1}" max="${count}" aria-label="做菜进度"></progress>
    <section class="box"><h2>步骤 ${index + 1}</h2><p>${esc(step.text)}</p>
    ${step.timestamp != null ? `<small>原片约 ${stamp(step.timestamp)}</small>` : ''}
    ${step.seconds ? `<div class="timer" data-timer="${id}/${index}" data-seconds="${step.seconds}">
      ${icon('clock')}<strong>${stamp(step.seconds)}</strong><button type="button" class="button primary" data-start>开始计时</button>
      <button type="button" class="button subtle" data-reset hidden>重置</button></div>` : ''}</section>
    <div class="cook-controls">${index ? `<a class="button subtle" href="#cook/${id}/${index - 1}">${icon('back')} 上一步</a>` :
      '<button class="button subtle" disabled>上一步</button>'}
    ${index < count - 1 ? `<a class="button primary" href="#cook/${id}/${index + 1}">下一步 ${icon('next')}</a>` :
      `<a class="button primary" href="#recipe/${id}">${icon('check')} 完成跟做</a>`}</div></article>`;
  updateTimer();
}

function missing() {
  main.innerHTML = '<div class="empty">找不到这道菜或收藏。<br><a href="#recipes" class="button subtle">返回我的菜谱</a></div>';
}

function render() {
  routeSequence += 1;
  clearTimeout(cloudTimer);
  const [page, first, second] = getRoute();
  if (library.readOnly && ['inbox', 'edit'].includes(page)) {
    navigate('#recipes');
    return;
  }
  nav(page === 'inbox' || (page === 'edit' && first === 'inbox') ? 'inbox' : ['cook', 'add'].includes(page) ? page : 'recipes');
  if (page === 'inbox') inbox();
  else if (page === 'add' && cloudUrl) cloudForm();
  else if (page === 'recipe') findRecipe(first) ? detail(findRecipe(first)) : missing();
  else if (page === 'edit') edit(first, second);
  else if (page === 'cook') cook(first, second);
  else recipes();
}

async function refresh() {
  const sequence = ++refreshSequence;
  const result = await api(libraryUrl, { cache: 'no-cache' });
  if (result.readOnly && cloudUrl) {
    const cloud = await api(new URL('./cloud/library.json', import.meta.url), { cache: 'no-cache' }).catch(() => null);
    if (Array.isArray(cloud?.recipes)) {
      const cloudIds = new Set(cloud.recipes.map(recipe => recipe.id));
      result.recipes = [...cloud.recipes, ...result.recipes.filter(recipe => !cloudIds.has(recipe.id))];
    }
  }
  if (sequence < lastAppliedRefresh) return;
  lastAppliedRefresh = sequence;
  library = result;
  if (!library.readOnly && getRoute()[0] === 'inbox' && !main.querySelector('[data-upload]:focus')) inboxItems();
  refreshRecipeList();
  const chooser = main.querySelector('#cook-list');
  if (chooser) chooser.innerHTML = library.recipes.map(recipe => card(recipe, 'cook')).join('');
}

main.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const submit = form.querySelector('[type="submit"]');
  const data = new FormData(form);
  const sequence = routeSequence;
  submit.disabled = true;
  try {
    if (form.id === 'cloud-form') await submitCloud(data);
    else if (form.id === 'share-form') {
      const item = await api('/api/inbox', json('POST', { share: data.get('share') }));
      form.reset();
      await refresh();
      notify(item.status === 'queued' ? '已收藏，整理完成后会自动存入菜谱。' : '这条视频已经收藏。');
    } else if (form.id === 'recipe-form') {
      const inputs = (kind, fields) => [...form.querySelectorAll(`[data-kind="${kind}"]`)].map(row =>
        Object.fromEntries(fields.map(field => [field, row.querySelector(`[data-field="${field}"]`).value])));
      const ingredients = inputs('ingredient', ['name', 'amount']);
      const steps = inputs('step', ['text', 'seconds', 'timestamp']).map(step => ({
        text: step.text, seconds: step.seconds ? Number(step.seconds) : null,
        timestamp: step.timestamp ? Number(step.timestamp) : null
      }));
      const { mode, id } = form.dataset;
      const recipe = await api(mode === 'recipe' ? `/api/recipes/${id}` : '/api/recipes',
        json(mode === 'recipe' ? 'PUT' : 'POST', {
          title: data.get('title'), summary: data.get('summary'), notes: data.get('notes'), ingredients, steps,
          importId: mode === 'inbox' ? id : undefined
        }));
      await refresh();
      if (sequence === routeSequence) navigate(`#recipe/${recipe.id}`);
      notify('已存入我的菜谱。');
    }
  } catch (error) { notify(error.message); }
  finally { submit.disabled = false; }
});

main.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-remove')) button.closest('.entry').remove();
  if (button.dataset.add) {
    const ingredient = button.dataset.add === 'ingredient';
    const list = main.querySelector(ingredient ? '#edit-ingredients' : '#edit-steps');
    const limit = ingredient ? 60 : 180;
    if (list.children.length >= limit) return notify(`最多添加 ${limit} 项。`);
    list.insertAdjacentHTML('beforeend', ingredient ? ingredientRow() : stepRow());
    list.lastElementChild.querySelector('input,textarea').focus();
  }
  if (button.dataset.retry) {
    button.disabled = true;
    try {
      await api(`/api/inbox/${button.dataset.retry}/retry`, { method: 'POST' });
      await refresh();
      notify('已重新排队。');
    } catch (error) { notify(error.message); }
    finally { button.disabled = false; }
  }
  const timer = button.closest('[data-timer]');
  if (timer && (button.hasAttribute('data-start') || button.hasAttribute('data-reset'))) {
    if (button.hasAttribute('data-start')) timers.set(timer.dataset.timer, Date.now() + Number(timer.dataset.seconds) * 1000);
    else timers.delete(timer.dataset.timer);
    try { localStorage.setItem('zaotai-timers', JSON.stringify([...timers])); } catch {}
    updateTimer();
  }
});

main.addEventListener('change', async event => {
  const input = event.target;
  if (!input.dataset.upload || !input.files?.[0]) return;
  const file = input.files[0];
  if (file.size > 100 * 1024 * 1024) {
    notify('请选择 100 MB 以内的视频。');
    input.value = '';
    return;
  }
  input.disabled = true;
  try {
    await api(`/api/inbox/${input.dataset.upload}/video`, { method: 'POST', body: file });
    await refresh();
    notify('视频已上传，整理完成后会自动存入菜谱。');
  } catch (error) { notify(error.message); }
  finally {
    input.value = '';
    input.disabled = false;
    if (getRoute()[0] === 'inbox') inboxItems();
  }
});

async function poll() {
  if (refreshing || document.hidden || !library.inbox.some(item => ['queued', 'processing'].includes(item.status))) return;
  refreshing = true;
  try { await refresh(); } catch {}
  finally { refreshing = false; }
}

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
  main.focus({ preventScroll: true });
  if (['recipes', 'inbox', 'cook'].includes(getRoute()[0])) void refresh().catch(() => {});
});
document.addEventListener('visibilitychange', () => { updateTimer(); void poll(); });
setInterval(updateTimer, 250);
setInterval(poll, 2400);
try {
  await refresh();
  render();
} catch (error) {
  main.innerHTML = `<div class="empty">暂时打开不了菜谱本。<br><a class="button subtle" href="${esc(location.pathname)}">重新加载</a></div>`;
  notify(error.message);
}
