// Options page: edit the ContentStudio port, bearer token, and channel list.
// Channel ids are validated on save (UC + 22 base64url chars, 24 total).

import {
  getSettings,
  isValidChannelId,
  saveSettings,
  type ChannelConfig,
  type Settings,
} from './settings';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`options.html is missing #${id}`);
  }
  return node as T;
}

function channelRowTemplate(channel?: ChannelConfig): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'channel-edit-row';

  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.placeholder = 'Channel ID (UC…)';
  idInput.className = 'channel-id-input';
  idInput.spellcheck = false;
  idInput.value = channel?.channelId ?? '';
  row.appendChild(idInput);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Display name';
  nameInput.className = 'channel-name-input';
  nameInput.value = channel?.name ?? '';
  row.appendChild(nameInput);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-channel';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => row.remove());
  row.appendChild(remove);

  return row;
}

function readChannelRows(): Array<{ channelId: string; name: string; row: HTMLDivElement }> {
  const rows = Array.from(document.querySelectorAll<HTMLDivElement>('.channel-edit-row'));
  return rows.map((row) => {
    const idInput = row.querySelector<HTMLInputElement>('.channel-id-input');
    const nameInput = row.querySelector<HTMLInputElement>('.channel-name-input');
    return {
      channelId: (idInput?.value ?? '').trim(),
      name: (nameInput?.value ?? '').trim(),
      row,
    };
  });
}

function showFeedback(message: string, isError: boolean): void {
  const feedback = el<HTMLDivElement>('save-feedback');
  feedback.textContent = message;
  feedback.className = isError ? 'feedback feedback-error' : 'feedback feedback-ok';
}

async function load(): Promise<void> {
  const settings = await getSettings();
  el<HTMLInputElement>('port').value = String(settings.port);
  el<HTMLInputElement>('token').value = settings.token;
  const container = el<HTMLDivElement>('channels');
  container.textContent = '';
  for (const channel of settings.channels) {
    container.appendChild(channelRowTemplate(channel));
  }
}

async function save(): Promise<void> {
  const portRaw = el<HTMLInputElement>('port').value.trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    showFeedback(`Port must be an integer between 1 and 65535 (got "${portRaw}").`, true);
    return;
  }

  const token = el<HTMLInputElement>('token').value.trim();

  const rows = readChannelRows();
  const channels: ChannelConfig[] = [];
  const seen = new Set<string>();
  for (const { channelId, name, row } of rows) {
    row.classList.remove('row-invalid');
    if (channelId === '' && name === '') {
      continue; // fully-empty row — treat as removed
    }
    if (!isValidChannelId(channelId)) {
      row.classList.add('row-invalid');
      showFeedback(
        `"${channelId || '(empty)'}" is not a valid channel ID — expected "UC" followed by 22 characters (24 total), e.g. UC_x5XG1OV2P6uZZ5FSM9Ttw.`,
        true,
      );
      return;
    }
    if (seen.has(channelId)) {
      row.classList.add('row-invalid');
      showFeedback(`Channel ID ${channelId} is listed twice.`, true);
      return;
    }
    seen.add(channelId);
    channels.push({ channelId, name: name || channelId });
  }

  const settings: Settings = { port, token, channels };
  await saveSettings(settings);
  showFeedback('Saved.', false);
}

document.addEventListener('DOMContentLoaded', () => {
  el<HTMLButtonElement>('add-channel').addEventListener('click', () => {
    el<HTMLDivElement>('channels').appendChild(channelRowTemplate());
  });
  el<HTMLButtonElement>('save').addEventListener('click', () => void save());
  void load();
});
