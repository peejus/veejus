import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  Channel,
  type ControlBridge,
  type OutputToControl,
  type OutputWindowState,
} from '@shared/protocol'

const bridge: ControlBridge = {
  sendToOutput: (msg) => ipcRenderer.send(Channel.toOutput, msg),
  onOutputMessage: (handler) => {
    const listener = (_e: IpcRendererEvent, msg: OutputToControl) => handler(msg)
    ipcRenderer.on(Channel.toControl, listener)
    return () => ipcRenderer.removeListener(Channel.toControl, listener)
  },
  onOutputState: (handler) => {
    const listener = (_e: IpcRendererEvent, state: OutputWindowState) => handler(state)
    ipcRenderer.on(Channel.outputState, listener)
    return () => ipcRenderer.removeListener(Channel.outputState, listener)
  },
  request: (req) => ipcRenderer.invoke(Channel.mainRequest, req),
}

contextBridge.exposeInMainWorld('veejus', bridge)
