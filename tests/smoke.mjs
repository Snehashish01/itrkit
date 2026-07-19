import { existsSync } from 'node:fs'
import process from 'node:process'
import { chromium } from 'playwright-core'

const edgePaths = [
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
]
const executablePath = edgePaths.find(existsSync)

if (!executablePath) {
  throw new Error('Microsoft Edge is required for the browser smoke test.')
}

const passphrase = 'Smoke-test-passphrase-2026'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function assertNoHorizontalOverflow(page, state) {
  const overflowing = await page.locator('body *').evaluateAll((elements) =>
    elements
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return { element: `${element.tagName.toLowerCase()}.${element.className}`, left: rect.left, right: rect.right, width: rect.width }
      })
      .filter(({ left, right, width }) => width > 0 && (left < -1 || right > window.innerWidth + 1)),
  )
  assert(overflowing.length === 0, `Horizontal overflow in ${state}: ${JSON.stringify(overflowing.slice(0, 5))}`)
}

async function setupVault(page) {
  await page.getByLabel('Vault passphrase').fill(passphrase)
  await page.getByLabel('Confirm passphrase').fill(passphrase)
  await page.getByRole('button', { name: 'Encrypt workspace' }).click()
  await page.getByRole('heading', { name: 'Start with the simplest family member.' }).waitFor()
}

async function rawVaultSummary(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('family-itr-vault')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const readAll = (storeName) => new Promise((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const read = (storeName, key) => new Promise((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const documents = await readAll('documents')
    const conversations = await readAll('conversations')
    const members = await read('settings', 'members')
    const security = await read('settings', 'security')
    const manifest = await read('settings', 'manifest')
    return {
      documentCount: documents.length,
      conversationCount: conversations.length,
      documentKeys: documents.map((record) => Object.keys(record)),
      conversationKeys: conversations.map((record) => Object.keys(record)),
      membersKeys: Object.keys(members ?? {}),
      manifestKeys: Object.keys(manifest ?? {}),
      iterations: security?.iterations,
      plaintext: JSON.stringify({ documents, conversations, members }),
    }
  })
}

const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true })
const page = await context.newPage()
const outboundRequests = []
const consoleProblems = []
const providerRequests = []
await page.route('https://mock-provider.example/v1/chat/completions', async (route) => {
  providerRequests.push({
    body: JSON.parse(route.request().postData() ?? '{}'),
    authorization: await route.request().headerValue('authorization'),
  })
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: 'Mock provider response.' } }] }),
  })
})
page.on('request', (request) => {
  const hostname = new URL(request.url()).hostname
  if (!['127.0.0.1', 'mock-provider.example'].includes(hostname)) outboundRequests.push(request.url())
})
page.on('console', (message) => {
  if (['error', 'warning'].includes(message.type())) consoleProblems.push(message.text())
})

try {
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Encrypt this workspace' }).waitFor()
  await assertNoHorizontalOverflow(page, 'vault setup')
  await setupVault(page)

  await page.getByRole('button', { name: 'Add person' }).click()
  await page.getByLabel('Neutral alias').fill('P1')
  await page.getByRole('button', { name: 'Add to organizer' }).click()
  await page.getByText('Likely ITR-1', { exact: true }).first().waitFor()

  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'form16.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Description,Amount\nGross salary PAN ABCDE1234F TAN ABCD12345E Aadhaar 1234 5678 9012 test@example.com,"900,000"\nTotal TDS,"75,000"'),
  })
  await page.getByText('2 values extracted', { exact: false }).waitFor()

  // Tax computation panel renders the old-vs-new regime statement for the member.
  await page.getByRole('heading', { name: 'Tax computation' }).waitFor()
  await page.getByText('Total tax liability', { exact: true }).waitFor()
  await page.getByText('Refund / payable', { exact: true }).waitFor()

  await page.getByPlaceholder('Ask about this return…').fill('Summarize income and what still needs review')
  await page.getByRole('button', { name: 'Send question' }).click()
  await page.getByText('I found 2 extracted values', { exact: false }).waitFor()
  await page.getByText('Still missing from the checklist', { exact: false }).waitFor()
  const visibleText = await page.locator('body').innerText()
  for (const marker of ['ABCDE1234F', 'ABCD12345E', '1234 5678 9012', 'test@example.com']) {
    assert(!visibleText.includes(marker), `Sensitive marker rendered in the UI: ${marker}`)
  }

  const raw = await rawVaultSummary(page)
  assert(raw.documentCount === 1, 'Expected one encrypted document record.')
  assert(raw.conversationCount === 2, 'Expected two encrypted conversation records.')
  assert(raw.documentKeys.every((keys) => keys.join(',') === 'version,id,memberId,metadata,data'), 'Unexpected document envelope.')
  assert(raw.conversationKeys.every((keys) => keys.join(',') === 'version,id,memberId,payload'), 'Unexpected conversation envelope.')
  assert(raw.membersKeys.join(',') === 'iv,ciphertext', 'Member state is not encrypted.')
  assert(raw.manifestKeys.join(',') === 'iv,ciphertext', 'Vault manifest is not encrypted.')
  assert(raw.iterations === 600000, 'Unexpected PBKDF2 iteration count.')
  for (const marker of ['P1', 'form16.csv', 'Gross salary', 'Summarize income']) {
    assert(!raw.plaintext.includes(marker), `Plaintext marker found in IndexedDB: ${marker}`)
  }

  const oldMembersEnvelope = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('family-itr-vault')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return new Promise((resolve, reject) => {
      const request = database.transaction('settings').objectStore('settings').get('members')
      request.onsuccess = () => resolve({
        iv: [...new Uint8Array(request.result.iv)],
        ciphertext: [...new Uint8Array(request.result.ciphertext)],
      })
      request.onerror = () => reject(request.error)
    })
  })
  await page.getByText('Documents ready', { exact: true }).click()
  await page.waitForFunction(async (oldCiphertext) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('family-itr-vault')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const current = await new Promise((resolve, reject) => {
      const request = database.transaction('settings').objectStore('settings').get('members')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return JSON.stringify([...new Uint8Array(current.ciphertext)]) !== JSON.stringify(oldCiphertext)
  }, oldMembersEnvelope.ciphertext)
  const latestMembersEnvelope = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('family-itr-vault')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return new Promise((resolve, reject) => {
      const request = database.transaction('settings').objectStore('settings').get('members')
      request.onsuccess = () => resolve({
        iv: [...new Uint8Array(request.result.iv)],
        ciphertext: [...new Uint8Array(request.result.ciphertext)],
      })
      request.onerror = () => reject(request.error)
    })
  })
  await page.evaluate(async (oldEnvelope) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('family-itr-vault')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const request = database.transaction('settings', 'readwrite').objectStore('settings').put({
        iv: new Uint8Array(oldEnvelope.iv).buffer,
        ciphertext: new Uint8Array(oldEnvelope.ciphertext).buffer,
      }, 'members')
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }, oldMembersEnvelope)
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByLabel('Vault passphrase').fill(passphrase)
  await page.getByRole('button', { name: 'Unlock vault' }).click()
  const replayError = await page.locator('.vault-gate-error').textContent()
  assert(replayError?.includes('Member state does not match'), `Unexpected member replay error: ${replayError}`)
  await page.evaluate(async (latestEnvelope) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('family-itr-vault')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const request = database.transaction('settings', 'readwrite').objectStore('settings').put({
        iv: new Uint8Array(latestEnvelope.iv).buffer,
        ciphertext: new Uint8Array(latestEnvelope.ciphertext).buffer,
      }, 'members')
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }, latestMembersEnvelope)
  await page.getByLabel('Vault passphrase').fill(passphrase)
  await page.getByRole('button', { name: 'Unlock vault' }).click()
  await page.getByText('form16.csv', { exact: true }).waitFor()

  const originalCiphertext = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('family-itr-vault')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const record = await new Promise((resolve, reject) => {
      const request = database.transaction('documents').objectStore('documents').getAll()
      request.onsuccess = () => resolve(request.result[0])
      request.onerror = () => reject(request.error)
    })
    const original = [...new Uint8Array(record.metadata.ciphertext)]
    const tampered = new Uint8Array(record.metadata.ciphertext.slice(0))
    tampered[0] ^= 1
    record.metadata.ciphertext = tampered.buffer
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('documents', 'readwrite')
      const request = transaction.objectStore('documents').put(record)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    return { id: record.id, bytes: original }
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByLabel('Vault passphrase').fill(passphrase)
  await page.getByRole('button', { name: 'Unlock vault' }).click()
  await page.getByText('The vault could not be upgraded safely', { exact: false }).waitFor()
  await page.evaluate(async ({ id, bytes }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('family-itr-vault')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const record = await new Promise((resolve, reject) => {
      const request = database.transaction('documents').objectStore('documents').get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    record.metadata.ciphertext = new Uint8Array(bytes).buffer
    await new Promise((resolve, reject) => {
      const request = database.transaction('documents', 'readwrite').objectStore('documents').put(record)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }, originalCiphertext)
  await page.getByLabel('Vault passphrase').fill(passphrase)
  await page.getByRole('button', { name: 'Unlock vault' }).click()
  await page.getByText('form16.csv', { exact: true }).waitFor()

  await page.getByRole('button', { name: 'BYO API' }).click()
  await page.getByRole('button', { name: 'Provider settings' }).click()
  await page.getByLabel('Endpoint').fill('https://mock-provider.example/v1/chat/completions')
  await page.getByLabel('Model').fill('mock-tax-model')
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill('session-only-test-key')
  await page.getByRole('checkbox', { name: /I trust https:\/\/mock-provider\.example/ }).check()
  await page.getByPlaceholder('Ask about this return…').fill('What is the next general step?')
  await page.getByRole('button', { name: 'Send question' }).click()
  await page.getByText('Mock provider response.', { exact: true }).waitFor()
  assert(providerRequests.length === 1, 'Expected one intercepted provider request.')
  assert(providerRequests[0].authorization === 'Bearer session-only-test-key', 'Provider key header is missing.')
  assert(providerRequests[0].body.messages.length === 2, 'Evidence-off request included conversation history.')
  const privateMarkers = ['900000', '75000', 'Gross salary', 'form16.csv', 'evidence packet']
  const evidenceOffBody = JSON.stringify(providerRequests[0].body)
  for (const marker of privateMarkers) {
    assert(!evidenceOffBody.includes(marker), `Evidence-off provider payload leaked: ${marker}`)
  }

  await page.getByRole('checkbox', { name: /Send 2 extracted candidates/ }).check()
  await page.getByPlaceholder('Ask about this return…').fill('Review the shared evidence.')
  await page.getByRole('button', { name: 'Send question' }).click()
  await page.getByText('Mock provider response.', { exact: true }).nth(1).waitFor()
  assert(providerRequests.length === 2, 'Expected a second intercepted provider request.')
  const evidenceOnBody = JSON.stringify(providerRequests[1].body)
  assert(evidenceOnBody.includes('evidence packet'), 'Evidence-on request omitted consent context.')
  assert(evidenceOnBody.includes('Gross salary'), 'Evidence-on request omitted extracted candidates.')
  assert(!evidenceOnBody.includes('sourceQuote'), 'Remote evidence included source quotes.')
  for (const marker of ['ABCDE1234F', 'ABCD12345E', '1234 5678 9012', 'test@example.com']) {
    assert(!evidenceOnBody.includes(marker), `Sensitive marker leaked to provider: ${marker}`)
  }
  await page.getByLabel('Endpoint').fill('https://second-provider.example/v1/chat/completions')
  assert(!(await page.getByRole('checkbox', { name: /Send 2 extracted candidates/ }).isChecked()), 'Evidence consent survived an endpoint change.')
  assert(!(await page.getByRole('checkbox', { name: /I trust https:\/\/second-provider\.example/ }).isChecked()), 'Provider trust survived an endpoint change.')
  assert((await page.getByRole('textbox', { name: 'API key', exact: true }).inputValue()) === '', 'API key survived an endpoint change.')

  const persistedSecrets = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('family-itr-vault')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const stores = [...database.objectStoreNames]
    const records = []
    for (const storeName of stores) {
      const values = await new Promise((resolve, reject) => {
        const request = database.transaction(storeName).objectStore(storeName).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      records.push(...values)
    }
    return `${JSON.stringify(records)}${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`
  })
  assert(!persistedSecrets.includes('session-only-test-key'), 'Provider key was persisted.')
  assert(!persistedSecrets.includes('mock-provider.example'), 'Provider endpoint was persisted.')

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export' }).click()
  const download = await downloadPromise
  const downloadStream = await download.createReadStream()
  const backupChunks = []
  for await (const chunk of downloadStream) backupChunks.push(chunk)
  const backupBuffer = Buffer.concat(backupChunks)
  const backupJson = JSON.parse(backupBuffer.toString('utf8'))
  assert(backupJson.format === 'family-itr-encrypted-v2', 'Export did not use v2 backup format.')
  const truncatedBackup = structuredClone(backupJson)
  truncatedBackup.documents.pop()
  const wrongVersionBackup = structuredClone(backupJson)
  wrongVersionBackup.documents[0].version = 1

  const siblingPage = await context.newPage()
  try {
    await siblingPage.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
    await siblingPage.getByLabel('Vault passphrase').fill(passphrase)
    await siblingPage.getByRole('button', { name: 'Unlock vault' }).click()
    await siblingPage.getByText('form16.csv', { exact: true }).waitFor()
    assert(await page.locator('.detail-header').isVisible(), 'Opening a sibling tab unexpectedly cleared the first tab.')
    await siblingPage.getByRole('button', { name: 'Lock' }).click()
    await page.getByRole('heading', { name: 'Unlock your workspace' }).waitFor()
    await siblingPage.getByLabel('Vault passphrase').fill(passphrase)
    siblingPage.once('dialog', (dialog) => dialog.accept())
    await siblingPage.locator('input[type="file"][aria-label="Choose encrypted vault backup to restore"]').setInputFiles({
      name: 'same-origin.itrvault',
      mimeType: 'application/json',
      buffer: backupBuffer,
    })
    await siblingPage.getByRole('heading', { name: 'Unlock your workspace' }).waitFor()
    await page.getByRole('heading', { name: 'Unlock your workspace' }).waitFor()
  } finally {
    await siblingPage.close()
  }

  const restoreContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const restorePage = await restoreContext.newPage()
  try {
    await restorePage.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
    await restorePage.getByLabel('Vault passphrase').fill('Wrong-backup-passphrase-2026')
    restorePage.once('dialog', (dialog) => dialog.accept())
    await restorePage.locator('input[type="file"][aria-label="Choose encrypted vault backup to restore"]').setInputFiles({
      name: 'audit.itrvault',
      mimeType: 'application/json',
      buffer: backupBuffer,
    })
    await restorePage.getByText('Incorrect backup passphrase.').waitFor()

    await restorePage.getByLabel('Vault passphrase').fill(passphrase)
    restorePage.once('dialog', (dialog) => dialog.accept())
    await restorePage.locator('input[type="file"][aria-label="Choose encrypted vault backup to restore"]').setInputFiles({
      name: 'truncated.itrvault',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(truncatedBackup)),
    })
    await restorePage.getByText('backup records do not match', { exact: false }).waitFor()
    restorePage.once('dialog', (dialog) => dialog.accept())
    await restorePage.locator('input[type="file"][aria-label="Choose encrypted vault backup to restore"]').setInputFiles({
      name: 'wrong-version.itrvault',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(wrongVersionBackup)),
    })
    await restorePage.getByText('invalid record envelopes', { exact: false }).waitFor()
    const settingsAfterFailures = await restorePage.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('family-itr-vault')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      return new Promise((resolve, reject) => {
        const request = database.transaction('settings').objectStore('settings').count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    })
    assert(settingsAfterFailures === 0, 'Failed restore mutated the destination vault.')

    restorePage.once('dialog', (dialog) => dialog.accept())
    await restorePage.locator('input[type="file"][aria-label="Choose encrypted vault backup to restore"]').setInputFiles({
      name: 'complete.itrvault',
      mimeType: 'application/json',
      buffer: backupBuffer,
    })
    await restorePage.getByRole('heading', { name: 'Unlock your workspace' }).waitFor()
    await restorePage.getByLabel('Vault passphrase').fill(passphrase)
    await restorePage.getByRole('button', { name: 'Unlock vault' }).click()
    await restorePage.getByText('form16.csv', { exact: true }).waitFor()
    assert(await restorePage.locator('.assistant-message').count() >= 2, 'Conversation history was not restored.')
  } finally {
    await restoreContext.close()
  }

  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Unlock your workspace' }).waitFor()
  await page.getByLabel('Vault passphrase').fill('Wrong-passphrase-2026')
  await page.getByRole('button', { name: 'Unlock vault' }).click()
  await page.getByText('Incorrect vault passphrase.').waitFor()
  await page.getByLabel('Vault passphrase').fill(passphrase)
  await page.getByRole('button', { name: 'Unlock vault' }).click()
  await page.getByText('form16.csv', { exact: true }).waitFor()
  await page.getByText('I found 2 extracted values', { exact: false }).waitFor()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Remove form16.csv' }).click()
  await page.getByRole('button', { name: 'Remove form16.csv' }).waitFor({ state: 'detached' })
  assert(!(await page.getByRole('checkbox', { name: 'Form 16 / pension statement' }).isChecked()), 'Checklist stayed checked after removing its last document.')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Remove P1' }).click()
  await page.getByRole('heading', { name: 'Start with the simplest family member.' }).waitFor()
  const dependentRecordCounts = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('family-itr-vault')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const count = (storeName) => new Promise((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return { documents: await count('documents'), conversations: await count('conversations') }
  })
  assert(dependentRecordCounts.documents === 0, 'Member deletion left orphaned documents.')
  assert(dependentRecordCounts.conversations === 0, 'Member deletion left orphaned conversations.')
  await assertNoHorizontalOverflow(page, 'populated encrypted workspace')

  assert(outboundRequests.length === 0, `Unexpected outbound requests: ${outboundRequests.join(', ')}`)
  assert(consoleProblems.length === 0, `Console problems: ${consoleProblems.join(' | ')}`)
  console.log('Smoke test passed: encryption, parser, tax computation panel, local assistant, reload lock, deletion consistency, responsive layout, and no outbound requests.')
} finally {
  await context.close()
  await browser.close()
}
