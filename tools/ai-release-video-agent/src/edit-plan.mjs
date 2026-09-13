export function normalizeEditorialScene(scene, index = 0) {
  const shot = scene.shot;
  if (shot) {
    if (!['generated','title','graphic'].includes(shot.mode)) throw new Error('Unknown shot mode');
    if (!shot.rationale?.trim()) throw new Error('Director must explain the shot purpose');
    if (shot.mode === 'generated' && !shot.prompt?.trim()) throw new Error('Generated shot requires a visual prompt');
    if (shot.mode === 'graphic' && !scene.onScreen) throw new Error('Graphic shot requires onScreen content');
    for (const key of ['background','foreground','accent']) if (shot[key] && !/^#[0-9a-f]{6}$/i.test(shot[key])) throw new Error('Palette must use six-digit hex colors');
    if (shot.motion && !['static','push-in','pull-out','pan-left'].includes(shot.motion)) throw new Error('Unsupported camera motion');
    if (shot.transition && !['cut','fade'].includes(shot.transition)) throw new Error('Unsupported transition');
  }
  const input = scene.onScreen;
  const title = (input?.title || scene.caption || '').split(/\r?\n/)[0].trim();
  if (!title || !scene.voiceover?.trim()) throw new Error(`Scene ${index + 1}: title and narration required`);
  const kind = input?.kind || 'takeaway';
  if (!['process', 'comparison', 'takeaway'].includes(kind)) throw new Error(`Unsupported layout: ${kind}`);
  const items = input?.items || (shot && shot.mode !== 'graphic' ? [] : scene.voiceover.split(/[。！？]/u).map(s => s.trim()).filter(Boolean).slice(0, 3));
  if (kind === 'process' && (items.length < 2 || items.length > 5)) throw new Error('Process requires 2–5 nodes');
  if (kind === 'comparison' && (!input.left?.title || !input.right?.title || !input.left?.items?.length || !input.right?.items?.length)) throw new Error('Comparison requires explicit left and right content');
  const display = { kind, title, items, left: input?.left, right: input?.right, source: input?.source || '' };
  const strings = [display.title, ...items, display.source, input?.left?.title, input?.right?.title, ...(input?.left?.items || []), ...(input?.right?.items || [])].filter(Boolean);
  if (strings.some(s => /中央大字|底部显示|用红色箭头|深色科技背景|对比图[:：]|示意图[:：]|画面描述/.test(s))) throw new Error('Production directions found in display text');
  if (title.length > 38 || items.some(s => s.length > 100)) throw new Error('Display text too long; shorten before rendering');
  if (items.length>5 || items.some(s => s.length > (kind==='process'?40:65))) throw new Error('Too much text for this layout; use shorter points or more scenes');
  for (const side of [input?.left,input?.right].filter(Boolean)) {
    if (side.title.length>20 || side.items.length>3 || side.items.some(s=>s.length>60)) throw new Error('Comparison text exceeds layout limits');
  }
  return { id: scene.id || `scene-${index + 1}`, narration: scene.voiceover.trim(), display, shot, adaptation: shot ? 'directed' : input ? 'structured' : 'narration-summary' };
}

export function parseSrt(text) {
  const time = s => { const [h,m,tail] = s.split(':'); return Number(h)*3600 + Number(m)*60 + Number(tail.replace(',', '.')); };
  return text.replace(/\r/g, '').trim().split(/\n\s*\n/).flatMap(block => {
    const lines = block.split('\n'); const i = lines.findIndex(l => l.includes(' --> '));
    if (i < 0) return [];
    const [a,b] = lines[i].split(' --> ');
    return [{ start: time(a), end: time(b), text: lines.slice(i+1).join(' ') }];
  });
}
