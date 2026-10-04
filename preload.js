const { contextBridge, ipcRenderer } = require('electron');

const call = async (ch, ...a) => {
  const r = await ipcRenderer.invoke(ch, ...a);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld('api', {
  call,
  move: (x, y) => ipcRenderer.send('win:move', x, y),
  resize: (b) => ipcRenderer.send('win:resize', b),
  ctxInfo: (info) => ipcRenderer.sendSync('ctx-info', info),
  on: (ch, fn) => {
    const allowed = ['mode', 'cmd', 'theme-changed', 'shortcut-errors', 'set-setting', 'fullscreen', 'update-status', 'imm-scroll'];
    if (allowed.includes(ch)) ipcRenderer.on(ch, (_e, ...a) => fn(...a));
  }
});
