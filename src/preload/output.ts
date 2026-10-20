import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { Channel, type ClipInfo, type ControlToOutput, type OutputBridge } from '@shared/protocol'

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge: OutputBridge = {
  sendToControl: (msg) => ipcRenderer.send(Channel.toControl, msg),
  command: (cmd) => ipcRenderer.send(Channel.outputCommand, cmd),
  onControlMessage: (handler) => subscribe<ControlToOutput>(Channel.toOutput, handler),
  onLibrary: (handler) => subscribe<ClipInfo[]>(Channel.library, handler),
  getLibrary: () => ipcRenderer.invoke(Channel.getLibrary),
}

contextBridge.exposeInMainWorld('veejus', bridge)
