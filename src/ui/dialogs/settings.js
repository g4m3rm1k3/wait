/** Settings dialog: channels, wait-code pattern and template, timing rates, initial macros. */
import { $ } from '../dom.js';
import { validateWaitPattern } from '../../nc/wait-pattern.js';
import { NUMBER_PATTERN } from '../../nc/numbers.js';

const NUMERIC_FIELDS = ['cutFeed', 'rapidFeed', 'rotationFeed', 'toolChangeSeconds'];
const INITIAL_MACRO = new RegExp(`^#?(\\d+)\\s*=\\s*(${NUMBER_PATTERN})$`);

export function setupSettingsDialog(app) {
  const open = () => openSettings(app);
  $('#settings-btn').onclick = open;
  $('#rates-btn').onclick = open;
  $('#help-btn').onclick = () => $('#help-dialog').showModal();
  $('#settings-form').onsubmit = (event) => {
    event.preventDefault();
    submitSettings(app, event.target);
  };
}

/** Fill the form from the current settings and show it. */
function openSettings(app) {
  const form = $('#settings-form');
  for (const [key, value] of Object.entries(app.ws.state.settings)) {
    const field = form.elements.namedItem(key);
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = value;
    else field.value = value;
  }
  $('#settings-error').textContent = '';
  $('#settings-dialog').showModal();
}

function submitSettings(app, form) {
  const values = Object.fromEntries(new FormData(form));
  const showError = (message) => { $('#settings-error').textContent = message; };

  const pattern = validateWaitPattern(values.waitPattern);
  if (!pattern.valid) return showError(pattern.error);
  if (values.hChannel === values.vChannel) return showError('Select two different channels.');
  if (!values.waitTemplate.includes('{id}')) return showError('The wait template must include {id}.');

  // "#501=0, #502=0" -> { 501: 0, 502: 0 }
  const initialMacros = {};
  const pieces = values.initialMacrosText.split(/[,;\n]/).map((piece) => piece.trim()).filter(Boolean);
  for (const piece of pieces) {
    const match = INITIAL_MACRO.exec(piece);
    if (!match) return showError(`Invalid initial macro: ${piece}`);
    initialMacros[match[1]] = Number(match[2]);
  }

  const settings = { ...values, initialMacros, useProgramFeed: form.elements.useProgramFeed.checked };
  for (const key of NUMERIC_FIELDS) settings[key] = Number(values[key]);

  app.ws.applySettings(settings);
  $('#settings-dialog').close();
  app.refreshAfterEdit();
  app.toast('Machine profile and time estimates updated');
}
