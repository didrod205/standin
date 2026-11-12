import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app-check.js';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-ai.js';
import { firebaseConfig, appCheckConfig } from './config.js';
import { ruleScan, mergeFindings, buildMap, maskText, leakCheck, restoreText, KIND_LABEL } from './redact.js';

// ---------- Firebase AI Logic setup ----------
if (appCheckConfig.debugToken) self.FIREBASE_APPCHECK_DEBUG_TOKEN = appCheckConfig.debugToken;
const app = initializeApp(firebaseConfig);
initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(appCheckConfig.recaptchaEnterpriseSiteKey),
  isTokenAutoRefreshEnabled: true,
});
const ai = getAI(app, { backend: new GoogleAIBackend() });

const findingSchema = Schema.object({
  properties: {
    items: Schema.array({
      items: Schema.object({
        properties: {
          value: Schema.string(),
          kind: Schema.enumString({ enum: ['PERSON', 'ORG', 'PLACE', 'ADDRESS', 'HEALTH', 'MONEY', 'ID', 'OTHER'] }),
        },
      }),
    }),
  },
});

// Step 1 model: private details are found ONLY on this device. Never falls back to the cloud.
const maskModel = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  inCloudParams: { model: 'gemini-3.5-flash-lite' }, // required by the SDK, never used in this mode
  onDeviceParams: {
    createOptions: {
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    },
  },
  generationConfig: { responseMimeType: 'application/json', responseSchema: findingSchema, temperature: 0 },
});

// Step 2 model: the heavy writing goes to the cloud when online, and falls back to the device when offline.
const CLOUD_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const deviceParams = {
  createOptions: {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  },
};
const writeModels = CLOUD_MODELS.map(name => getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_IN_CLOUD,
  inCloudParams: { model: name, generationConfig: { temperature: 0.4, maxOutputTokens: 8192 } },
  onDeviceParams: deviceParams,
}));

async function writeWithFallback(prompt) {
  let lastErr;
  for (let i = 0; i < writeModels.length; i++) {
    try {
      const res = await Promise.race([writeModels[i].generateContent(prompt), new Promise((_, j) => setTimeout(() => j(new Error('timed out after 60 s')), 60000))]);
      return { res, model: CLOUD_MODELS[i] };
    }
    catch (e) { lastErr = e; console.warn(`Cloud model ${CLOUD_MODELS[i]} failed, trying next`, e); }
  }
  throw lastErr;
}

// ---------- UI state ----------
const $ = s => document.querySelector(s);
const state = { items: [], map: [], outbound: '', device: 'checking', deviceReady: false, receipt: [] };

const SAMPLE = `Hi, I need to write to my landlord. My name is Dana Whitfield and I rent the apartment at 1187 Larkspur Avenue, Unit 4B. Since September there has been black mold behind the bathroom wall. My son Milo (6) has asthma and his doctor, Dr. Priya Raman at Northgate Children's Clinic, said the mold is making his attacks worse. He used his inhaler 3 times last week. I told the building manager Greg Osterman by phone on Oct 2 and by email on Oct 19 (greg.osterman@larkspurliving.com) but nothing happened. I paid a $2,400 deposit and rent is $1,850. My phone is (415) 555-0193. I want the mold fixed within 14 days or I will report it to the city housing office. Please make it firm but polite.`;

const TASKS = {
  letter: 'Write a firm, polite formal letter based on the notes. Include a clear request, a deadline and a short timeline of what happened.',
  email: 'Write a short, clear email reply based on the notes. Keep it under 180 words.',
  summary: 'Write a neutral one-page summary of the situation for a lawyer or caseworker: facts, timeline, open questions.',
  plain: 'Rewrite the notes in plain, simple English that a 12-year-old could follow, keeping every fact.',
};

function setStatus(el, text, tone) { el.textContent = text; el.dataset.tone = tone; }

async function checkDevice() {
  const chip = $('#chip-device');
  if (!('LanguageModel' in self)) {
    state.device = 'unavailable';
    setStatus(chip, 'On-device model: not in this browser. Masking uses local rules only.', 'warn');
    return;
  }
  try {
    const a = await self.LanguageModel.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] });
    state.device = a;
    const msg = { available: 'On-device model: ready', downloadable: 'On-device model: can be downloaded (press Mask)', downloading: 'On-device model: downloading', unavailable: 'On-device model: not supported on this device. Masking uses local rules only.' }[a] || `On-device model: ${a}`;
    setStatus(chip, msg, a === 'available' ? 'ok' : 'warn');
  } catch (e) {
    state.device = 'unavailable';
    setStatus(chip, 'On-device model: check failed. Masking uses local rules only.', 'warn');
  }
}

function updateNet() {
  setStatus($('#chip-net'), navigator.onLine ? 'Network: online' : 'Network: offline. Writing will run on this device.', navigator.onLine ? 'ok' : 'warn');
}

function addReceipt(row) {
  state.receipt.push({ time: new Date().toLocaleTimeString(), ...row });
  const tb = $('#receipt tbody');
  tb.innerHTML = state.receipt.map(r => `<tr><td>${r.time}</td><td>${r.step}</td><td><span class="where" data-w="${r.where}">${r.where}</span></td><td>${r.chars}</td><td>${r.leaked}</td></tr>`).join('');
  $('#receipt-empty').hidden = state.receipt.length > 0;
}

function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderItems() {
  const box = $('#items');
  if (!state.items.length) { box.innerHTML = '<p class="muted">Nothing found yet.</p>'; return; }
  box.innerHTML = state.items.map((it, i) => `<button class="item ${it.on ? 'on' : ''}" data-i="${i}" title="${it.by === 'device' ? 'Found by the on-device model' : it.by === 'rule' ? 'Found by a local rule' : 'Added by you'}"><span class="k">${KIND_LABEL[it.kind]}</span>${esc(it.value)}<span class="by">${it.by}</span></button>`).join('');
  box.querySelectorAll('.item').forEach(b => b.onclick = () => { const it = state.items[+b.dataset.i]; it.on = !it.on; refreshOutbound(); });
}

function refreshOutbound() {
  const text = $('#input').value;
  state.map = buildMap(state.items);
  state.outbound = maskText(text, state.map);
  const leaks = leakCheck(state.outbound, state.map);
  let html = esc(state.outbound).replace(/\[([A-Z_]+)_(\d+)\]/g, '<mark class="tok">[$1_$2]</mark>');
  $('#outbound').innerHTML = html || '<span class="muted">The exact text that would leave this device appears here.</span>';
  const hidden = state.map.length;
  $('#count-hidden').textContent = hidden;
  $('#count-leak').textContent = leaks.length;
  $('#keep-list').innerHTML = state.map.map(m => `<li><code>${m.token}</code> <span>${esc(m.value)}</span></li>`).join('') || '<li class="muted">No stand-ins yet</li>';
  $('#btn-write').disabled = !state.outbound || leaks.length > 0;
  $('#leak-warn').hidden = leaks.length === 0;
  renderItems();
}

async function runMask() {
  const text = $('#input').value.trim();
  if (!text) return;
  const btn = $('#btn-mask'); btn.disabled = true; btn.textContent = 'Masking on this device...';
  const rule = ruleScan(text).map(f => ({ ...f, by: 'rule' }));
  let modelItems = [];
  let where = 'local rules only';
  if (state.device !== 'unavailable') {
    try {
      if (!state.deviceReady && maskModel.initializeDeviceModel) {
        await maskModel.initializeDeviceModel(p => setStatus($('#chip-device'), `On-device model: downloading ${Math.round(p * 100)}%`, 'warn'));
        state.deviceReady = true;
      }
      const prompt = `List every private detail in the text below that could identify a real person or their situation: people's names, organizations, places, street addresses, health conditions, money amounts, ID numbers. Copy each value exactly as written. Return JSON.\n\nTEXT:\n${text}`;
      const res = await maskModel.generateContent(prompt);
      let parsed;
      try { parsed = JSON.parse(res.response.text()); } catch { throw new Error('The on-device model did not return valid JSON'); }
      if (!Array.isArray(parsed.items)) throw new Error('The on-device model returned no list');
      modelItems = (parsed.items || []).map(f => ({ ...f, by: 'device' }));
      where = String(res.response.inferenceSource || 'ON_DEVICE').toUpperCase();
      await checkDevice();
    } catch (e) {
      console.warn('On-device masking unavailable:', e);
      setStatus($('#chip-device'), 'On-device model: answer unusable. Masked with local rules.', 'warn');
      $('#chip-device').title = e.message;
    }
  }
  const manual = state.items.filter(i => i.by === 'you');
  state.items = mergeFindings(text, [modelItems, rule, manual]);
  addReceipt({ step: 'Find private details', where, chars: 0, leaked: 0 });
  refreshOutbound();
  btn.disabled = false; btn.textContent = 'Mask again';
  $('#step2').classList.add('live');
}

async function runWrite() {
  const leaks = leakCheck(state.outbound, state.map);
  if (leaks.length) return;
  const btn = $('#btn-write'); btn.disabled = true; btn.textContent = navigator.onLine ? 'Writing in the cloud...' : 'Writing on this device...';
  if (state.device !== 'unavailable' && !state.writeDeviceInit) {
    // called inside the click so Chrome allows the on-device model; used only if the cloud is unreachable
    try { writeModels.forEach(m => m.initializeDeviceModel && m.initializeDeviceModel()); state.writeDeviceInit = true; } catch (e) { console.warn(e); }
  }
  const task = $('#task').value === 'custom' ? $('#custom').value : TASKS[$('#task').value];
  const prompt = `${task}\n\nThe notes use stand-in tokens in square brackets such as [PERSON_1] or [ADDRESS_1] in place of private details. Keep every token exactly as written, including the brackets, wherever that detail belongs. Never invent real names, numbers or addresses. Do not add placeholders of your own; today's date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}. Output only the finished text, no markdown.\n\nNOTES:\n${state.outbound}`;
  const finalLeaks = leakCheck(prompt, state.map);
  if (finalLeaks.length) { btn.textContent = 'Blocked: private detail in request'; return; }
  try {
    const { res, model } = await writeWithFallback(prompt);
    const raw = res.response.text();
    const where = String(res.response.inferenceSource || 'IN_CLOUD').toUpperCase();
    addReceipt({ step: where === 'IN_CLOUD' ? `Write draft (${model})` : 'Write draft (Gemini Nano)', where, chars: where === 'IN_CLOUD' ? prompt.length : 0, leaked: 0 });
    $('#cloud-raw').textContent = raw;
    const r = restoreText(raw, state.map);
    let html = esc(r.text);
    for (const m of [...state.map].sort((a, b) => b.value.length - a.value.length)) {
      html = html.split(esc(m.value)).join(`<mark class="back">${esc(m.value)}</mark>`);
    }
    $('#result').innerHTML = html;
    $('#restore-note').textContent = `${r.used.length} of ${state.map.length} stand-ins swapped back on this device.` + (r.missing.length ? ` Not used by the draft: ${r.missing.join(', ')}.` : '') + (r.unknown.length ? ` Unknown tokens left as is: ${r.unknown.join(', ')}.` : '');
    $('#step3').classList.add('live');
    $('#btn-copy').disabled = false;
  } catch (e) {
    console.error(e);
    $('#result').textContent = `Could not write the draft: ${e.message}`;
  }
  btn.disabled = false; btn.textContent = 'Write with stand-ins';
}

function addManual() {
  const v = $('#manual').value.trim();
  const text = $('#input').value;
  if (!v) return;
  if (!text.includes(v)) { $('#manual').setCustomValidity('That exact text is not in your notes.'); $('#manual').reportValidity(); return; }
  $('#manual').setCustomValidity('');
  state.items.push({ value: v, kind: 'OTHER', by: 'you', on: true });
  state.items = mergeFindings(text, [state.items]).map(i => ({ ...i, by: state.items.find(x => x.value === i.value)?.by || i.by }));
  $('#manual').value = '';
  refreshOutbound();
}

function downloadReceipt() {
  const lines = ['Standin privacy receipt', `Created ${new Date().toISOString()}`, '', 'time | step | where it ran | characters sent off this device | private details sent'];
  for (const r of state.receipt) lines.push(`${r.time} | ${r.step} | ${r.where} | ${r.chars} | ${r.leaked}`);
  lines.push('', 'Stand-ins kept on this device (values not included in this file):', ...state.map.map(m => `${m.token} (${KIND_LABEL[m.kind]})`));
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'standin-receipt.txt'; a.click();
}

$('#btn-sample').onclick = () => { $('#input').value = SAMPLE; state.items = []; refreshOutbound(); };
$('#btn-mask').onclick = runMask;
$('#btn-write').onclick = runWrite;
$('#btn-add').onclick = addManual;
$('#manual').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } });
$('#task').onchange = () => { $('#custom').hidden = $('#task').value !== 'custom'; };
$('#input').addEventListener('input', () => { state.items = state.items.filter(i => $('#input').value.includes(i.value)); refreshOutbound(); });
$('#btn-copy').onclick = () => navigator.clipboard.writeText($('#result').innerText);
$('#btn-receipt').onclick = downloadReceipt;
$('#toggle-raw').onclick = () => { $('#cloud-raw').hidden = !$('#cloud-raw').hidden; };
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);
updateNet();
checkDevice();
refreshOutbound();
