import { expect, test } from 'bun:test'
import * as entry from '../src/index'

test('entry module loads', () => {
  expect(entry).toBeDefined()
})
