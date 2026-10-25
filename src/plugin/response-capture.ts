import type { Context } from 'elysia'
import { mapResponse } from 'elysia/adapter/bun/handler'
import type { HeaderFilter } from '../records/header-filter'
import { ResponseSnapshot, type StoredResponse } from '../records/stored-response'

type ResponseSet = Context['set']

export class ResponseCapture {
  constructor(
    private readonly maxBodyBytes: number,
    private readonly headerFilter: HeaderFilter,
  ) {}

  async toResponse(value: unknown, set: ResponseSet, request: Request): Promise<Response> {
    const response = await mapResponse(value, set, request)
    ResponseCapture.forgetMergedCookies(set)
    return response
  }

  snapshot(response: Response): Promise<StoredResponse> {
    return ResponseSnapshot.capture(response, { maxBodyBytes: this.maxBodyBytes, headerFilter: this.headerFilter })
  }

  private static forgetMergedCookies(set: ResponseSet): void {
    delete set.cookie
    if (set.headers instanceof Headers) set.headers.delete('set-cookie')
    else delete set.headers['set-cookie']
  }
}
