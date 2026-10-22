import type { ControlBridge, MainRequest, MainResponse } from '@shared/protocol'

export const bridge = (window as unknown as { veejus: ControlBridge }).veejus

/** Send a request to the main process and throw if it answers with an error. */
export async function request<T extends MainResponse['type']>(
  req: MainRequest,
  expect: T | T[],
): Promise<Extract<MainResponse, { type: T }>> {
  const res = await bridge.request(req)
  if (res.type === 'error') throw new Error(res.message)
  const ok = Array.isArray(expect) ? (expect as string[]).includes(res.type) : res.type === expect
  if (!ok) throw new Error(`Expected ${String(expect)} response, got ${res.type}`)
  return res as Extract<MainResponse, { type: T }>
}
