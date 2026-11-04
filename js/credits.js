// Image credits page: lists every photo that is used (status "ok") from data/images/CREDITS.json, with a text filter.
// Relative path on purpose: the site may be served from a sub-path.
const KINDS = { people: 'Famous people', dishes: 'Dishes', landmarks: 'Landmarks', alcohol: 'Drinks' };
const list = document.getElementById('credit-list');
const status = document.getElementById('credit-status');
const filter = document.getElementById('credit-filter');

function row(e) {
  const li = document.createElement('li');
  const title = document.createElement('strong');
  title.textContent = `${e.name} (${e.iso3}, ${KINDS[e.kind] || e.kind})`;
  const meta = document.createElement('span');
  meta.className = 'cr-meta';
  const licence = e.licence || 'licence not stated';
  meta.append(`${e.artist || 'Unknown author'}, `);
  if (e.licenceUrl) {
    const a = document.createElement('a');
    a.href = e.licenceUrl;
    a.textContent = licence;
    meta.append(a);
  } else meta.append(licence);
  if (e.filePage) {
    meta.append(' · ');
    const a = document.createElement('a');
    a.href = e.filePage;
    a.textContent = 'file page';
    meta.append(a);
  }
  li.append(title, meta);
  li._text = `${e.name} ${e.iso3} ${KINDS[e.kind] || e.kind} ${e.artist || ''} ${licence}`.toLowerCase();
  return li;
}

function apply() {
  const q = filter.value.trim().toLowerCase();
  let shown = 0;
  for (const li of list.children) {
    const hit = !q || li._text.includes(q);
    li.hidden = !hit;
    if (hit) shown++;
  }
  status.textContent = `${shown} of ${list.children.length} images shown.`;
}

try {
  const res = await fetch('data/images/CREDITS.json');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  list.append(...data.entries.filter((e) => e.status === 'ok' && e.file).map(row));
  filter.disabled = false;
  filter.addEventListener('input', apply);
  apply();
} catch (err) {
  status.textContent = 'Could not load the credits list. It is also available as data/images/CREDITS.md.';
}
