import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  Channel,
  type ClipInfo,
  type ControlBridge,
  type OutputToControl,
  type OutputWindowState,
} from '@shared/protocol'

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge: ControlBridge = {
  sendToOutput: (msg) => ipcRenderer.send(Channel.toOutput, msg),
  onOutputMessage: (handler) => subscribe<OutputToControl>(Channel.toControl, handler),
  onOutputState: (handler) => subscribe<OutputWindowState>(Channel.outputState, handler),
  onLibrary: (handler) => subscribe<ClipInfo[]>(Channel.library, handler),
  request: (req) => ipcRenderer.invoke(Channel.mainRequest, req),
  getPathForFile: (file) => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld('veejus', bridge)
