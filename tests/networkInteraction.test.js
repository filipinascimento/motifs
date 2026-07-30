import assert from 'node:assert/strict'
import test from 'node:test'

import { switchNetworkMode } from '../src/networkInteraction.js'

test('mode switching retains the button across the asynchronous transition', async () => {
  let resolveMode
  let mode = '3d'
  let framed = 0
  const button = { textContent: '3D', disabled: false, isConnected: true }
  const helios = {
    setMode: () => new Promise((resolve) => { resolveMode = resolve }),
    frameNetwork: async () => { framed += 1 },
  }
  const pending = switchNetworkMode({
    helios, button, currentMode: mode, onModeChange: (value) => { mode = value },
  })
  assert.equal(button.textContent, '2D')
  assert.equal(button.disabled, true)
  resolveMode()
  const result = await pending
  assert.deepEqual(result, { mode: '2d', applied: true })
  assert.equal(mode, '2d')
  assert.equal(button.textContent, '2D')
  assert.equal(button.disabled, false)
  assert.equal(framed, 1)
})

test('a failed mode switch is handled and restores the previous mode', async () => {
  let mode = '2d'
  let reported = ''
  const button = { textContent: '2D', disabled: false, isConnected: true }
  const result = await switchNetworkMode({
    helios: { setMode: async () => { throw new Error('transition failed') } },
    button,
    currentMode: mode,
    onModeChange: (value) => { mode = value },
    onError: (error) => { reported = error.message },
  })
  assert.equal(result.applied, false)
  assert.equal(mode, '2d')
  assert.equal(button.textContent, '2D')
  assert.equal(button.disabled, false)
  assert.equal(reported, 'transition failed')
})
