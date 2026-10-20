import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { Channel, type ControlToOutput, type OutputBridge } from '@shared/protocol'

const bridge: OutputBridge = {
  sendToControl: (msg) => ipcRenderer.send(Channel.toControl, msg),
  command: (cmd) => ipcRenderer.send(Channel.outputCommand, cmd),
  onControlMessage: (handler) => {
    const listener = (_e: IpcRendererEvent, msg: ControlToOutput) => handler(msg)
    ipcRenderer.on(Channel.toOutput, listener)
    return () => ipcRenderer.removeListener(Channel.toOutput, listener)
  },
}

contextBridge.exposeInMainWorld('veejus', bridge)
