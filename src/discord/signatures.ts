function fromHex(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]+$/iu.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = value.slice(index * 2, index * 2 + 2);
    bytes[index] = Number.parseInt(pair, 16);
  }
  return bytes;
}

export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  const publicKey = fromHex(publicKeyHex);
  const signature = fromHex(signatureHex);
  if (publicKey === null || publicKey.length !== 32 || signature === null || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey.buffer, { name: "Ed25519" }, false, ["verify"]);
    const encodedBody = new TextEncoder().encode(timestamp + body);
    const signedBody = new Uint8Array(new ArrayBuffer(encodedBody.byteLength));
    signedBody.set(encodedBody);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature.buffer,
      signedBody.buffer,
    );
  } catch {
    return false;
  }
}
