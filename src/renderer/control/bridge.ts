import type { ControlBridge, MainRequest, MainResponse } from '@shared/protocol'

export const bridge = (window as unknown as { veejus: ControlBridge }).veejus

/** Send a request to the main process and throw if it answers with an error. */
export async function request<T extends MainResponse['type']>(
  req: MainRequest,
  expect: T,
): Promise<Extract<MainResponse, { type: T }>> {
  const res = await bridge.request(req)
  if (res.type === 'error') throw new Error(res.message)
  if (res.type !== expect) throw new Error(`Expected ${expect} response, got ${res.type}`)
  return res as Extract<MainResponse, { type: T }>
}
