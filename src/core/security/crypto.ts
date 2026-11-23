export interface CryptoVerifierOptions {
  /** Allowed agent Ed25519 public keys (base64-encoded SPKI). If omitted, any valid signature is accepted. */
  trustedPublicKeys?: string[]
  /** Maximum allowed clock drift in milliseconds for X-MCP-Timestamp (default: 300_000 = 5 mins) */
  maxClockDriftMs?: number
  /** Reject unsigned requests when true (default: false) */
  requireSignature?: boolean
}

export interface SignedPayloadHeaders {
  'X-MCP-Signature': string
  'X-MCP-Timestamp': string
  'X-MCP-Public-Key'?: string
}

const textEncoder = new TextEncoder()

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < view.byteLength; i++) {
    binary += String.fromCharCode(view[i]!)
  }
  return btoa(binary)
}

/**
 * Generates an Ed25519 keypair and exports public/private keys as base64 strings.
 */
export async function generateMcpKeyPair(): Promise<{
  publicKey: string
  privateKey: string
}> {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey)
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)

  return {
    publicKey: bytesToBase64(spki),
    privateKey: bytesToBase64(pkcs8),
  }
}

/**
 * Signs a raw string payload with an Ed25519 PKCS#8 private key (base64).
 * Message format: `${timestamp}.${rawBody}`
 */
export async function signMcpPayload(
  rawBody: string,
  privateKeyBase64: string,
  publicKeyBase64?: string,
  timestamp: string = Date.now().toString(),
): Promise<SignedPayloadHeaders> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(privateKeyBase64),
    { name: 'Ed25519' },
    false,
    ['sign'],
  )

  const message = textEncoder.encode(`${timestamp}.${rawBody}`)
  const signatureBuffer = await crypto.subtle.sign({ name: 'Ed25519' }, key, message)

  return {
    'X-MCP-Signature': bytesToBase64(signatureBuffer),
    'X-MCP-Timestamp': timestamp,
    ...(publicKeyBase64 ? { 'X-MCP-Public-Key': publicKeyBase64 } : {}),
  }
}

/**
 * Verifies an incoming HTTP request's X-MCP-Signature, X-MCP-Timestamp, and X-MCP-Public-Key headers.
 */
export async function verifyMcpRequest(
  headers: Headers,
  rawBody: string,
  options: CryptoVerifierOptions,
): Promise<{ valid: boolean; reason?: string; publicKey?: string }> {
  const signature = headers.get('x-mcp-signature')
  const timestamp = headers.get('x-mcp-timestamp')
  const publicKey = headers.get('x-mcp-public-key')

  if (!signature || !timestamp || !publicKey) {
    if (options.requireSignature) {
      return { valid: false, reason: 'Missing required MCP cryptographic signature headers' }
    }
    return { valid: true }
  }

  if (options.trustedPublicKeys && !options.trustedPublicKeys.includes(publicKey)) {
    return { valid: false, reason: 'Agent public key is not in trustedPublicKeys allowlist' }
  }

  const parsedTs = Number(timestamp)
  const drift = options.maxClockDriftMs ?? 300_000
  if (!Number.isFinite(parsedTs) || Math.abs(Date.now() - parsedTs) > drift) {
    return { valid: false, reason: 'Request timestamp expired or invalid' }
  }

  try {
    const cryptoKey = await crypto.subtle.importKey(
      'spki',
      base64ToBytes(publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    )

    const message = textEncoder.encode(`${timestamp}.${rawBody}`)
    const isValid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      cryptoKey,
      base64ToBytes(signature),
      message,
    )

    if (!isValid) {
      return { valid: false, reason: 'Cryptographic signature verification failed' }
    }

    return { valid: true, publicKey }
  } catch {
    return { valid: false, reason: 'Malformed public key or signature encoding' }
  }
}